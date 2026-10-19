import { SocketVoice, newResponseId } from './base.js';
import { encodeDoubao, decodeDoubao } from './doubao-codec.js';
import type { VoiceDone } from '../types.js';
import WebSocket from 'ws';
import { boundVoiceInstructions } from '../voice-config.js';

export function doubaoUsage(value:any){
  const input={text_tokens:value.input_text_tokens,audio_tokens:value.input_audio_tokens},output={text_tokens:value.output_text_tokens,audio_tokens:value.output_audio_tokens};
  const sum=(v:any)=>Object.values(v).every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0)?Object.values(v).reduce<number>((s,n)=>s+Number(n),0):undefined;
  return {input_tokens:sum(input),output_tokens:sum(output),input_tokens_details:input,output_tokens_details:output,raw:value};
}
export class DoubaoVoice extends SocketVoice {
  nativeTools=false;
  private sessionId=newResponseId();private dialogId='';private responseId='';private outputText='';private inputText='';private muted=new Set<string>();private hadUsage=false;private suppressNext=false;
  protected headers(){
    const c=this.options.config,common={'X-Api-Resource-Id':c.resourceId||'volc.speech.dialog','X-Api-Connect-Id':newResponseId()};
    return {...common,'X-Api-App-ID':c.appId||'','X-Api-Access-Key':c.key,'X-Api-App-Key':c.appKey||'PlgvMymc7f3tQnJ6'};
  }
  private packet(event:number,payload:unknown={},type=1){if(this.ready||event===100){const name=event===100?'session.update':event===201?'context.update':event===300||event===501?'response.create':event===200?'input_audio_buffer.append':'';this.options.requests?.protocol({url:this.options.config.url,model:this.options.config.model,source:'voice-'+this.options.role,channel:'voice'},name,'sent');}this.send(encodeDoubao(event,payload,this.sessionId,type));}
  protected opened(){this.packet(1);}
  private persona(instructions:string){
    const bounded=boundVoiceInstructions(instructions,4000);if(bounded!==instructions)this.emit('notice','豆包人设限额为 4000 字符，本次已压缩发送的背景；本地完整记忆仍保留。');instructions=bounded;
    return /^2\.|^SC/i.test(this.options.config.model)?{character_manifest:instructions}:{bot_name:'伴语',system_role:instructions,speaking_style:''};
  }
  private startSession(){
    const {config,role,appConfig}=this.options;
    this.packet(100,{asr:{extra:{enable_custom_vad:true,end_smooth_window_ms:Math.max(500,appConfig.vad.silenceMs)}},
      tts:{speaker:config.voice,audio_config:{channel:1,format:'pcm_s16le',sample_rate:24000}},
      dialog:{...this.persona(this.options.instructions),extra:{model:config.model,input_mod:role==='speaker'?'text':'keep_alive',enable_conversation_truncate:true}}});
  }
  configure(instructions:string){
    if(this.ready&&instructions===this.options.instructions)return;this.options.instructions=instructions;if(this.ready)this.packet(201,{tts:{speaker:this.options.config.voice,audio_config:{channel:1,format:'pcm_s16le',sample_rate:24000,speech_rate:0,loudness_rate:0}},dialog:{...this.persona(instructions),dialog_id:this.dialogId}});
  }
  private begin(id?:string){
    if(id&&id===this.responseId)return;
    if(this.responseId&&!id)return;
    this.responseId=id||newResponseId();this.outputText='';this.hadUsage=false;
    if(this.suppressNext)this.muted.add(this.responseId);
    this.active=!this.muted.has(this.responseId);if(this.active)this.emit('responseStart',this.responseId);
    if(this.muted.size>50)this.muted.clear();
  }
  protected received(data:Buffer){
    const frame=decodeDoubao(data),e=frame.json||{};
    if(frame.sessionId&&frame.event>=100&&frame.sessionId!==this.sessionId)return;
    if(frame.type===15||[51,153,599].includes(frame.event)){this.fault(e.error||e.message||'豆包实时语音错误 '+(frame.code||e.status_code||frame.event));if(!this.ready)this.close();return;}
    if(frame.event===50){this.startSession();return;}
    if(frame.event===150){this.dialogId=e.dialog_id||'';this.markReady();return;}
    if(frame.event===154){this.hadUsage=true;this.usage(doubaoUsage(e.usage||e));return;}
    if(frame.event===450){this.suppressNext=false;this.emit('speech',e);this.inputText='';}
    if(frame.event===451)this.inputText=(e.results||[]).map((r:any)=>r.text||'').join('');
    if(frame.event===459){if(this.inputText.trim())this.emit('transcript',this.inputText);this.inputText='';this.emit('speechEnd',e);}
    if(frame.event===350||frame.event===550){
      this.begin(e.reply_id);
      if(!this.muted.has(this.responseId)){
        if(frame.event===550){this.outputText+=e.content||'';this.emit('textDelta',{id:this.responseId,text:e.content||''});}
        else if(this.options.role==='speaker'&&e.text&&!this.outputText)this.outputText=e.text;
      }
    }
    if(frame.event===352&&this.options.role!=='gate'){this.begin();if(!this.muted.has(this.responseId))this.emit('audio',{id:this.responseId,audio:frame.body.toString('base64'),sampleRate:24000});}
    if(frame.event===559&&this.options.role==='gate')this.finish();
    if(frame.event===359&&this.options.role!=='gate')this.finish();
  }
  private finish(){
    if(!this.responseId)return;const id=this.responseId,status=this.muted.has(id)?'cancelled':'completed';this.active=false;
    if(!this.hadUsage)this.usage({});
    this.emit('done',{id,status,text:this.outputText,output:[]} satisfies VoiceDone);this.responseId='';this.outputText='';
  }
  append(audio:string){if(this.canAppend())this.packet(200,Buffer.from(audio,'base64'),2);}
  text(text:string){
    this.requireReady();
    // SayHello accepts explicit text without requiring an earlier ASREnded.
    // ChatTTSText (500) requires a preceding query, so it cannot serve the
    // application's independent per-answer speaker session.
    this.packet(this.options.role==='speaker'?300:501,{content:text});
  }
  toolResult(){throw new Error('豆包原生对话接口不提供该函数调用协议，请通过转写控制命令或返回轻量模式');}
  respond(){}
  cancel(){if(this.responseId)this.muted.add(this.responseId);this.active=false;}
  suppressTurn(){this.suppressNext=true;this.cancel();}
  close(){
    if(this.dead)return;
    // Send the documented session/connection finish messages before closing.
    if(this.socket?.readyState===WebSocket.OPEN){if(this.ready)this.packet(102);this.packet(2);}
    super.close();
  }
}
