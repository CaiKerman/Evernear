import { SocketVoice, Pcm16Resampler } from './base.js';
import type { VoiceDone } from '../types.js';

export class OpenAIVoice extends SocketVoice {
  private configured=false;private configuredInstructions='';
  private resampler=new Pcm16Resampler(16000,24000);
  private textByResponse=new Map<string,string>();
  protected endpoint(){const u=new URL(super.endpoint());u.searchParams.set('model',this.options.config.model);return u.toString();}
  protected opened(){this.configure(this.options.instructions);}
  configure(instructions:string){
    this.options.instructions=instructions;if(this.configured){if(instructions===this.configuredInstructions)return;this.configuredInstructions=instructions;this.send({type:'session.update',session:{type:'realtime',instructions}});return;}this.configured=true;this.configuredInstructions=instructions;const {role,config,appConfig}=this.options;
    const turn_detection=role!=='gate'?null:appConfig.vad.type==='semantic_vad'?{type:'semantic_vad'}:{type:'server_vad',threshold:Math.max(0,appConfig.vad.threshold),silence_duration_ms:appConfig.vad.silenceMs};
    this.send({type:'session.update',session:{type:'realtime',model:config.model,instructions,
      output_modalities:role==='gate'?['text']:['audio'],max_output_tokens:role==='gate'?1800:2500,
      audio:{input:{format:{type:'audio/pcm',rate:24000},turn_detection},output:{format:{type:'audio/pcm',rate:24000},voice:config.voice||'marin'}},
      tools:[]}});
  }
  protected received(data:Buffer){
    const e=JSON.parse(data.toString());
    if(e.type==='session.updated')this.markReady();
    if(e.type==='error'){this.fault(e.error?.message||'OpenAI 实时接口错误');if(!this.ready)this.close();return;}
    if(e.type==='input_audio_buffer.speech_started')this.emit('speech',e);
    if(e.type==='input_audio_buffer.speech_stopped')this.emit('speechEnd',e);
    if(e.type==='conversation.item.input_audio_transcription.completed')this.emit('transcript',e.transcript||'');
    if(e.type==='response.created'){this.active=true;this.emit('responseStart',e.response?.id);}
    if(['response.output_text.delta','response.output_audio_transcript.delta','response.text.delta','response.audio_transcript.delta'].includes(e.type)){
      const id=e.response_id||'';this.textByResponse.set(id,(this.textByResponse.get(id)||'')+(e.delta||''));this.emit('textDelta',{id,text:e.delta||''});
    }
    // A gate session never exposes native model audio, even if a compatible
    // endpoint ignores the requested text-only modality.
    if(['response.output_audio.delta','response.audio.delta'].includes(e.type)&&this.options.role!=='gate')this.emit('audio',{id:e.response_id||'',audio:e.delta,sampleRate:24000});
    if(e.type==='response.done'){
      this.active=false;const r=e.response||{},output=r.output||[],id=r.id||'';
      const text=output.flatMap((item:any)=>item.content||[]).map((part:any)=>part.text||part.transcript||'').join('')||this.textByResponse.get(id)||'';
      this.textByResponse.delete(id);this.usage(r.usage);
      this.emit('done',{id,status:r.status||'incomplete',text,output,usage:r.usage} satisfies VoiceDone);
    }
  }
  append(audio:string){if(this.canAppend()){const pcm=this.resampler.process(Buffer.from(audio,'base64'));if(pcm.length)this.send({type:'input_audio_buffer.append',audio:pcm.toString('base64')});}}
  text(text:string){this.requireReady();this.send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}});this.respond();}
  toolResult(callId:string,output:string,respond=false){this.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:callId,output}});if(respond)this.respond();}
  respond(){this.send({type:'response.create'});}
  cancel(){if(this.active)this.send({type:'response.cancel'});this.active=false;}
}
