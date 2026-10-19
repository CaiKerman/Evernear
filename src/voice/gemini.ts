import { SocketVoice, gateFunction, newResponseId } from './base.js';
import type { VoiceDone } from '../types.js';

export function geminiUsage(value:any){
  const detail=(rows:any[])=>Object.fromEntries((rows||[]).map(x=>[String(x.modality||'').toLowerCase()+'_tokens',x.tokenCount]));
  return {input_tokens:value.promptTokenCount,output_tokens:value.responseTokenCount,total_tokens:value.totalTokenCount,
    input_tokens_details:detail(value.promptTokensDetails),output_tokens_details:detail(value.responseTokensDetails),raw:value};
}
export class GeminiVoice extends SocketVoice {
  private responseId='';private outputText='';private inputText='';private cancelled=false;private decisionSent=false;
  private functions:any[]=[];private functionNames=new Map<string,string>();private lastUsage:any;private latestContext='';private pendingContext='';
  protected headers(){return {};}
  protected endpoint(){const u=new URL(super.endpoint());u.searchParams.set('key',this.options.config.key);return u.toString();}
  protected opened(){
    this.latestContext=this.options.instructions;
    const {role,config,appConfig}=this.options;
    const extra=role==='gate'?'\n本阶段通过 submit_decision 函数提交决定，不朗读 JSON、不直接回答；严格遵守当前阶段的 JSON 结构。':'';
    this.send({setup:{model:config.model.startsWith('models/')?config.model:'models/'+config.model,
      generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:config.voice||'Aoede'}}},maxOutputTokens:role==='gate'?1800:2500},
      systemInstruction:{parts:[{text:this.options.instructions+extra}]},
      inputAudioTranscription:{},outputAudioTranscription:{},contextWindowCompression:{slidingWindow:{}},
      ...(role!=='gate'?{realtimeInputConfig:{automaticActivityDetection:{disabled:true}}}:{realtimeInputConfig:{automaticActivityDetection:{silenceDurationMs:appConfig.vad.silenceMs}}}),
      tools:role==='gate'?[{functionDeclarations:[gateFunction]}]:[]}});
  }
  configure(instructions:string){
    this.options.instructions=instructions;if(!this.ready||instructions===this.latestContext)return;this.pendingContext=instructions;
    // Gemini setup is immutable mid-connection. Append a bounded application
    // context update without completing a turn instead of sending another setup.
    this.flushContext();
  }
  private flushContext(){if(!this.ready||this.active||!this.pendingContext)return;this.latestContext=this.pendingContext;this.pendingContext='';const context=this.options.role==='gate'?this.latestContext.slice(this.latestContext.lastIndexOf('\n')+1):this.latestContext;this.send({clientContent:{turns:[{role:'user',parts:[{text:'【背景更新，不是用户发话，无需回答】\n'+context}]}],turnComplete:false}});}
  private begin(){
    if(this.responseId)return;this.responseId=newResponseId();this.outputText='';this.functions=[];this.decisionSent=false;this.cancelled=false;this.active=true;this.emit('responseStart',this.responseId);
  }
  protected received(data:Buffer){
    const e=JSON.parse(data.toString());
    if(e.error){this.fault(e.error.message||'Gemini Live 接口错误');if(!this.ready)this.close();return;}
    if(e.setupComplete){this.markReady();return;}
    if(e.usageMetadata){this.lastUsage=geminiUsage(e.usageMetadata);this.usage(this.lastUsage);}
    if(e.goAway){this.emit('notice','Gemini 通知本次连接即将结束；将按现有重连机制恢复');}
    if(e.voiceActivity?.type==='ACTIVITY_START')this.emit('speech',e.voiceActivity);
    if(e.voiceActivity?.type==='ACTIVITY_END')this.emit('speechEnd',e.voiceActivity);
    const content=e.serverContent;
    if(content){
      if(content.interrupted){this.cancelled=true;this.active=false;this.emit('speech');}
      if(content.inputTranscription){
        this.inputText+=content.inputTranscription.text||'';
        if(content.inputTranscription.finished){this.flushInput();}
      }
      const parts=content.modelTurn?.parts||[];
      if(parts.length||content.outputTranscription)this.begin();
      if(!this.cancelled){
        for(const part of parts){
          if(part.text&&!part.thought){this.outputText+=part.text;this.emit('textDelta',{id:this.responseId,text:part.text});}
          const inline=part.inlineData;
          if(inline&&this.options.role!=='gate'){
            if(!/^audio\/pcm(?:;|$)/.test(inline.mimeType||''))throw new Error('Gemini 返回了未适配的音频编码，需要 PCM 音频');
            const rate=Number(inline.mimeType.match(/rate=(\d+)/)?.[1]||24000);this.emit('audio',{id:this.responseId,audio:inline.data,sampleRate:rate});
          }
        }
        if(content.outputTranscription){this.outputText+=content.outputTranscription.text||'';this.emit('textDelta',{id:this.responseId,text:content.outputTranscription.text||''});}
      }
      // turnComplete ends model generation, not microphone speech. In gate mode
      // the tool decision may already have been delivered before this boundary.
      if(content.turnComplete){this.flushInput();this.finish(this.cancelled?'cancelled':'completed');}
    }
    if(e.toolCall){
      this.begin();
      for(const call of e.toolCall.functionCalls||[]){
        this.functionNames.set(call.id,call.name);
        if(this.options.role==='gate'&&call.name==='submit_decision'){
          if(this.decisionSent||this.cancelled)continue;this.decisionSent=true;
          const done:VoiceDone={id:this.responseId,status:'completed',text:JSON.stringify(call.args||{}),output:[]};
          this.send({toolResponse:{functionResponses:[{id:call.id,name:call.name,response:{received:true}}]}});
          // Keep the turn active until the server turn boundary, but deliver one
          // routing decision only. Audio and follow-up acknowledgments stay mute.
          this.emit('done',done);
        }else this.send({toolResponse:{functionResponses:[{id:call.id,name:call.name,response:{error:'不支持的函数'}}]}});
      }
    }
    if(e.toolCallCancellation){for(const id of e.toolCallCancellation.ids||[])this.functionNames.delete(id);}
  }
  private flushInput(){if(this.inputText.trim()){this.emit('transcript',this.inputText);this.inputText='';}}
  private finish(status:string){
    if(!this.responseId)return;
    this.active=false;
    if(!this.lastUsage)this.usage({});
    if(this.options.role!=='gate'||!this.decisionSent){
      this.emit('done',{id:this.responseId,status,text:this.outputText,output:[],usage:this.lastUsage} satisfies VoiceDone);
    }
    this.responseId='';this.outputText='';this.functions=[];this.active=false;this.cancelled=false;this.decisionSent=false;this.lastUsage=undefined;this.flushContext();
  }
  append(audio:string){if(this.canAppend())this.send({realtimeInput:{audio:{mimeType:'audio/pcm;rate=16000',data:audio}}});}
  text(text:string){this.requireReady();this.cancel();this.send({clientContent:{turns:[{role:'user',parts:[{text}]}],turnComplete:true}});}
  toolResult(callId:string,output:string){const name=this.functionNames.get(callId);if(!name)return;let response:any;try{response=JSON.parse(output);}catch{response={result:output};}this.send({toolResponse:{functionResponses:[{id:callId,name,response}]}});this.functionNames.delete(callId);}
  respond(){} // A complete clientContent turn or toolResponse triggers generation.
  cancel(){
    if(!this.active)return;this.cancelled=true;
    // An empty, incomplete clientContent update interrupts generation without
    // pretending that microphone speech has ended. Late old audio is suppressed.
    this.send({clientContent:{turns:[],turnComplete:false}});
  }
}
