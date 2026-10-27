import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { VoiceOptions } from '../providers.js';
import { randomUUID } from 'node:crypto';
import { assertVoiceReady, normalizeVoiceURL, voiceProvider } from '../voice-config.js';

export interface VoiceSession extends EventEmitter {
  options:VoiceOptions;ready:boolean;active:boolean;nativeTools?:boolean;suppressTurn?:()=>void;
  finishInput?():void;
  connect():Promise<void>;configure(instructions:string):void;append(audio:string):void;text(text:string):void;
  toolResult(callId:string,output:string,respond?:boolean):void;respond():void;cancel():void;close():void;
}
export function privateError(error:unknown,options:VoiceOptions){
  let text=error instanceof Error?error.message:String(error);
  for(const value of [options.config.key,options.config.appKey])if(value)for(const secret of [value,encodeURIComponent(value)])text=text.split(secret).join('[已隐藏]');
  return text.replace(/([?&](?:key|api_key|access_token)=)[^&#\s]+/gi,'$1[已隐藏]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]').slice(0,1000);
}
export abstract class SocketVoice extends EventEmitter implements VoiceSession {
  ready=false;active=false;nativeTools=true;protected socket?:WebSocket;protected dead=false;
  private connecting=false;private handshake?:ReturnType<typeof setTimeout>;private heartbeat?:ReturnType<typeof setInterval>;private rejectConnect?:(e:Error)=>void;private resolveConnect?:()=>void;
  constructor(public options:VoiceOptions){super();}
  protected endpoint(){return normalizeVoiceURL(voiceProvider(this.options.config),this.options.config.url);}
  protected headers():Record<string,string>{return {Authorization:'Bearer '+this.options.config.key};}
  protected abstract opened():void;
  protected abstract received(data:Buffer):void;
  abstract configure(instructions:string):void;abstract append(audio:string):void;abstract text(text:string):void;
  abstract toolResult(callId:string,output:string,respond?:boolean):void;abstract respond():void;abstract cancel():void;
  async connect(){
    assertVoiceReady(this.options.config);if(this.dead)throw new Error('该语音会话已经结束');if(this.connecting||this.ready)throw new Error('该语音会话已连接或正在连接');this.connecting=true;
    return new Promise<void>((resolve,reject)=>{
      this.rejectConnect=reject;this.resolveConnect=resolve;
      this.handshake=setTimeout(()=>{this.fault('语音会话配置超时，请检查厂商、模型与凭据');this.close();},20000);
      try{
        const endpoint=this.endpoint(),finishRequest=this.options.requests?.voice({url:endpoint,model:this.options.config.model,source:'voice-'+this.options.role,channel:'voice'});
        const ws=this.socket=new WebSocket(endpoint,{headers:this.headers(),...(this.options.appConfig.proxy?{agent:new HttpsProxyAgent(this.options.appConfig.proxy)}:{}),handshakeTimeout:15000,maxPayload:8*1024*1024});
        ws.on('open',()=>{finishRequest?.('connected');this.heartbeat=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.ping();},20000);try{this.opened();}catch(e){this.fault(e);this.close();}});
        ws.on('message',data=>{if(this.dead)return;try{this.received(Buffer.isBuffer(data)?data:Buffer.from(data as any));}catch(e){this.fault(e);this.close();}});
        ws.on('error',e=>{finishRequest?.('failed',Number(String(e).match(/Unexpected server response: (\d{3})/)?.[1])||undefined);this.fault(e);});
        ws.on('close',code=>{finishRequest?.('closed-before-open');this.clearTimers();this.connecting=false;this.ready=false;this.rejectPending(new Error('语音连接已关闭 ('+code+')'));if(!this.dead)this.emit('disconnected',code);});
      }catch(e){this.fault(e);this.close();}
    });
  }
  protected markReady(){if(this.dead||this.ready)return;this.ready=true;this.connecting=false;clearTimeout(this.handshake);this.handshake=undefined;this.rejectConnect=undefined;this.resolveConnect?.();this.resolveConnect=undefined;this.emit('ready');}
  protected fault(e:unknown){const error=new Error(privateError(e,this.options));this.rejectPending(error);this.emit('fault',error);}
  private rejectPending(e:Error){this.rejectConnect?.(e);this.rejectConnect=undefined;this.resolveConnect=undefined;}
  protected send(value:unknown){if(!this.dead&&this.socket?.readyState===WebSocket.OPEN){if(!Buffer.isBuffer(value)){const x=value as any;const event=x.type||(x.setup?'session.update':x.clientContent?(x.clientContent.turnComplete?'response.create':'context.update'):x.toolResponse?'tool.response':x.realtimeInput?.audio?'input_audio_buffer.append':'');this.options.requests?.protocol({url:this.options.config.url,model:this.options.config.model,source:'voice-'+this.options.role,channel:'voice'},event,'sent');}this.socket.send(Buffer.isBuffer(value)?value:JSON.stringify(value));}}
  protected canAppend(){if(!this.ready||this.dead)return false;if((this.socket?.bufferedAmount||0)>1024*1024){this.emit('backpressure');return false;}return true;}
  protected requireReady(){if(!this.ready||this.dead)throw new Error('语音会话尚未就绪');}
  protected usage(usage:any){this.emit('usage',{role:this.options.role,model:this.options.config.model,provider:voiceProvider(this.options.config),usage:usage||{}});}
  private clearTimers(){clearTimeout(this.handshake);clearInterval(this.heartbeat);this.handshake=undefined;this.heartbeat=undefined;}
  close(){if(this.dead)return;this.dead=true;this.ready=false;this.active=false;this.clearTimers();this.rejectPending(new Error('语音会话已结束'));if(this.socket?.readyState===WebSocket.CONNECTING)this.socket.terminate();else this.socket?.close();}
}

// The application microphone remains 16 kHz. OpenAI PCM input requires 24 kHz.
// Keep phase and the boundary sample across packets, rather than resampling each
// chunk independently (which drops or duplicates samples at chunk boundaries).
export class Pcm16Resampler {
  private previous=0;private havePrevious=false;private inputIndex=-1;private outputPosition=0;private outputIndex=0;
  constructor(private sourceRate:number,private targetRate:number){}
  process(bytes:Buffer){
    if(bytes.length%2)throw new Error('PCM16 数据长度必须是偶数');
    if(this.sourceRate===this.targetRate)return bytes;
    const values:number[]=[];
    for(let offset=0;offset<bytes.length;offset+=2){
      const sample=bytes.readInt16LE(offset);this.inputIndex++;
      if(!this.havePrevious){this.previous=sample;this.havePrevious=true;}
      while(this.outputPosition<=this.inputIndex){
        const fraction=Math.max(0,Math.min(1,this.outputPosition-(this.inputIndex-1)));
        values.push(Math.round(this.previous+(sample-this.previous)*fraction));this.outputIndex++;this.outputPosition=this.outputIndex*this.sourceRate/this.targetRate;
      }
      this.previous=sample;
    }
    const result=Buffer.alloc(values.length*2);values.forEach((v,i)=>result.writeInt16LE(v,i*2));return result;
  }
}
export const newResponseId=()=>randomUUID();
export const gateFunction={name:'submit_decision',description:'静默判断是否介入及去向，不回答。',parameters:{type:'object',properties:{action:{type:'string',enum:['ignore','answer','switch_high','delegate','ambient','cancel','remember','recall','capabilities','stop_speaking','ack','yield']},utterance:{type:'string'},reason:{type:'string'},memory:{type:'string'},replaceTaskId:{type:'string'},continueHigh:{type:'boolean'},summary:{type:'string'},tone:{type:'string'},firstAnswer:{type:'string'},notifyLater:{type:'boolean'}},required:['action']}};
