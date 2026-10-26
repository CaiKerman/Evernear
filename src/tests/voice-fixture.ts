// Local protocol fixture. Its server frame layout is independent of the adapter
// codec so encoding and decoding cannot accidentally validate one another.
import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import type { VoiceProvider } from '../types.js';
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
export function serverFrame(event:number,payload:any={},sessionId='',type=9){
  const body=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));
  return Buffer.concat([Buffer.from([0x11,type*16+4,Buffer.isBuffer(payload)?0:16,0]),u32(event),...(event>=100?[u32(Buffer.byteLength(sessionId)),Buffer.from(sessionId)]:[]),u32(body.length),body]);
}
function clientFrame(b:Buffer){const event=b.readUInt32BE(4);let p=8,id='';if(event>=100){const n=b.readUInt32BE(p);p+=4;id=b.subarray(p,p+n).toString();p+=n;}const n=b.readUInt32BE(p);p+=4;if(p+n!==b.length)throw new Error('invalid client payload length');return {event,sessionId:id,body:b.subarray(p),json:b[2]>>4===1?JSON.parse(b.subarray(p).toString()):undefined};}
export interface FixtureConnection{ws:WebSocket;url:string;headers:any;role:string;sessionId:string;messages:any[];send:(e:any)=>void;respond:(text?:string)=>void;}
export async function voiceFixture(provider:VoiceProvider,autoRespond=false,autoReady=true){
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');const connections:FixtureConnection[]=[];let audioPackets=0,responseCount=0;
  const pcm=Buffer.alloc(9600);for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/24000)*1200),i*2);
  server.on('connection',(ws,req)=>{
    const c:FixtureConnection={ws,url:req.url||'',headers:req.headers,role:'',sessionId:'',messages:[],send:e=>ws.readyState===1&&ws.send(provider==='doubao'?serverFrame(e.event,e.body,c.sessionId,e.type):JSON.stringify(e)),respond:()=>{}};
    connections.push(c);let text='';let configuredSession:any={};
    c.respond=(value?:string)=>{
      const id='fixture-'+(++responseCount),decision={action:'answer',utterance:'本地测试问题',reason:'本地协议夹具',answer:'夹具回答'},answer=value??(c.role==='gate'?JSON.stringify({action:'engage',utterance:'本地测试问题'}):c.role==='reply'?'轻量语音直接回答':c.role==='speaker'?text:'高级对话已接续');
      const usage={input_tokens:10,output_tokens:10,total_tokens:20,input_tokens_details:{text_tokens:3,audio_tokens:7},output_tokens_details:{text_tokens:4,audio_tokens:6}};
      if(provider==='doubao'){
        c.send({event:550,body:{reply_id:id,content:answer}});c.send({event:352,body:pcm,type:11});
        c.send({event:154,body:{usage:{input_text_tokens:3,input_audio_tokens:7,output_text_tokens:4,output_audio_tokens:6}}});
        c.send({event:559});c.send({event:359});
      }else if(provider==='gemini'){
        if(c.role==='gate')c.send({toolCall:{functionCalls:[{id:'call-'+id,name:'submit_decision',args:JSON.parse(answer)}]}});
        else c.send({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:pcm.toString('base64')}}]},outputTranscription:{text:answer}}});
        // Even a gate may get unwanted native audio; it must never be played.
        if(c.role==='gate')c.send({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:pcm.toString('base64')}}]}}});
        c.send({usageMetadata:{promptTokenCount:10,responseTokenCount:10,totalTokenCount:20,promptTokensDetails:[{modality:'TEXT',tokenCount:3},{modality:'AUDIO',tokenCount:7}],responseTokensDetails:[{modality:'TEXT',tokenCount:4},{modality:'AUDIO',tokenCount:6}]}});
        c.send({serverContent:{turnComplete:true}});
      }else{
        c.send({type:'response.created',response:{id}});c.send({type:provider==='openai'?'response.output_text.delta':'response.text.delta',response_id:id,delta:answer});
        c.send({type:provider==='openai'?'response.output_audio.delta':'response.audio.delta',response_id:id,delta:pcm.toString('base64')});
        c.send({type:'response.done',response:{id,status:'completed',output:[],usage}});
      }
    };
    if(provider==='qwen')c.send({type:'session.created'});
    ws.on('message',raw=>{
      const b=Buffer.from(raw as any),e=provider==='doubao'?clientFrame(b):JSON.parse(b.toString());c.messages.push(e);
      if(provider==='doubao'){
        if(e.event===1)c.send({event:50});
        if(e.event===100){c.sessionId=e.sessionId;c.role=JSON.stringify(e.json.dialog).includes('[stage:reply:low]')?'reply':e.json.dialog.extra.input_mod==='text'?'speaker':JSON.stringify(e.json.dialog).includes('[stage:gate]')?'gate':'high';if(autoReady)c.send({event:150,body:{dialog_id:'dialog-fixture'}});}
        if(e.event===200)audioPackets++;
        if(e.event===300||e.event===501){text=e.json.content;if(autoRespond)c.respond();}
        if(e.event===102)c.send({event:152});if(e.event===2)c.send({event:52});
      }else if(provider==='gemini'){
        if(e.setup){c.role=JSON.stringify(e.setup.systemInstruction).includes('[stage:reply:low]')?'reply':e.setup.tools?.some((x:any)=>x.functionDeclarations?.some((f:any)=>f.name==='submit_decision'))?'gate':/stage:speaker|语音播报器/.test(JSON.stringify(e.setup.systemInstruction))?'speaker':'high';if(autoReady)c.send({setupComplete:{}});}
        if(e.realtimeInput?.audio)audioPackets++;
        if(e.clientContent?.turnComplete){text=e.clientContent.turns?.flatMap((t:any)=>t.parts||[]).map((p:any)=>p.text||'').join('')||'';if(autoRespond)c.respond();}
      }else{
        if(e.type==='session.update'){const s=configuredSession={...configuredSession,...e.session};c.role=s.input_audio_transcription&&s.turn_detection===null?'transcribe':String(s.instructions).includes('[stage:reply:low]')?'reply':(s.output_modalities||s.modalities)?.length===1&&(s.output_modalities||s.modalities)[0]==='text'?'gate':/stage:speaker|语音播报器/.test(s.instructions)?'speaker':'high';if(autoReady)c.send({type:'session.updated'});}
        if(e.type==='input_audio_buffer.append')audioPackets++;
        if(e.type==='input_audio_buffer.commit'&&c.role==='transcribe')c.send({type:'conversation.item.input_audio_transcription.completed',transcript:'主动录入测试文本'});
        if(e.type==='conversation.item.create'&&e.item.content){text=e.item.content.map((p:any)=>p.text||'').join('');c.send({type:'conversation.item.created',item:e.item});}
        if(e.type==='response.create'&&autoRespond)c.respond();
      }
    });
  });
  return {provider,server,connections,get audioPackets(){return audioPackets;},url:`ws://127.0.0.1:${(server.address() as any).port}`,
    close(){for(const c of server.clients)c.terminate();server.close();}};
}
export async function until(predicate:()=>boolean,ms=2000){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end)throw new Error('fixture condition timed out');await new Promise(r=>setTimeout(r,5));}}
