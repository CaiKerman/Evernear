import test from 'node:test';import assert from 'node:assert/strict';import { once } from 'node:events';
import { WebSocketServer } from 'ws';import { Realtime } from '../providers.js';import { defaults } from '../store.js';

test('Qwen protocol: wait for session config, text-only gate, PCM format and final status',async t=>{
  const wss=new WebSocketServer({port:0,host:'127.0.0.1'});await once(wss,'listening');t.after(()=>{for(const s of wss.clients)s.terminate();wss.close();});
  const received:any[]=[];let client:any;
  wss.on('connection',(ws,req)=>{assert.match(req.url||'',/model=fixture/);assert.equal(req.headers.authorization,'Bearer test-key');client=ws;ws.send(JSON.stringify({type:'session.created'}));ws.on('message',b=>{const e=JSON.parse(b.toString());received.push(e);if(e.type==='session.update'){assert.deepEqual(e.session.modalities,['text']);assert.equal(e.session.audio.input.format.sample_rate,16000);ws.send(JSON.stringify({type:'session.updated'}));}if(e.type==='conversation.item.create')ws.send(JSON.stringify({type:'conversation.item.created',item:e.item}));if(e.type==='response.create'){
    ws.send(JSON.stringify({type:'response.created',response:{id:'r'}}));ws.send(JSON.stringify({type:'response.text.delta',response_id:'r',delta:'{"action":"ignore"}'}));ws.send(JSON.stringify({type:'response.done',response:{id:'r',status:'completed',output:[],usage:{total_tokens:15}}}));}});});
  const v=new Realtime({role:'gate',config:{url:`ws://127.0.0.1:${(wss.address() as any).port}`,model:'fixture',key:'test-key',voice:'Tina'},appConfig:structuredClone(defaults),instructions:'gate'});t.after(()=>v.close());
  v.on('fault',()=>{});await v.connect();assert.ok(v.ready);const done=once(v,'done');v.text('hello');const [r]=await done;assert.equal(r.text,'{"action":"ignore"}');assert.equal(r.status,'completed');
  v.append('AAAA');await new Promise(r=>setTimeout(r,20));assert.ok(received.some(x=>x.type==='input_audio_buffer.append'));
  const cancelled=once(v,'done');client.send(JSON.stringify({type:'response.done',response:{id:'c',status:'cancelled',output:[]}}));assert.equal((await cancelled)[0].status,'cancelled');
});
