import test from 'node:test';import assert from 'node:assert/strict';import { once } from 'node:events';import { gzipSync } from 'node:zlib';
import { createVoice } from '../voice/index.js';import { defaults, validateConfig } from '../store.js';
import { voicePresets, resolveVoiceConfig, assertVoiceReady, normalizeVoiceURL, boundVoiceInstructions } from '../voice-config.js';
import { Pcm16Resampler, privateError } from '../voice/base.js';import { encodeDoubao, decodeDoubao } from '../voice/doubao-codec.js';
import { voiceFixture, until, serverFrame } from './voice-fixture.js';import type { VoiceProvider } from '../types.js';

for(const provider of ['qwen','openai','gemini','doubao'] as VoiceProvider[])for(const role of ['gate','reply','high','speaker'] as const){
  test(`${provider} ${role}: native handshake, typed turn, PCM, gate mute and usage`,async t=>{
    const f=await voiceFixture(provider,true);t.after(()=>f.close());const cfg={...voicePresets[provider],provider,url:f.url,key:'fixture-key',appId:'fixture-app'};
    const v=createVoice({role,config:cfg,appConfig:structuredClone(defaults),instructions:role==='gate'?'[stage:gate] 你是静默介入判断模型':role==='reply'?'[stage:reply:low]':role==='speaker'?'[stage:speaker]':'[stage:high]'});t.after(()=>v.close());v.on('fault',e=>assert.fail(e));
    const audio:any[]=[],usage:any[]=[];v.on('audio',x=>audio.push(x));v.on('usage',x=>usage.push(x));v.append('AAAA');await v.connect();assert.equal(f.audioPackets,0);
    v.append(Buffer.alloc(640).toString('base64'));await until(()=>f.audioPackets===1);const done=once(v,'done');v.text('朗读这段正文');const [r]=await done;
    await until(()=>usage.length>0);assert.equal(r.status,'completed');assert.equal(audio.length,role==='gate'?0:1);assert.ok(r.text.includes(role==='gate'?'engage':role==='reply'?'轻量':role==='speaker'?'朗读':'高级'));
    assert.equal(usage[0].usage.input_tokens_details.audio_tokens,7);assert.equal(usage[0].usage.output_tokens_details.audio_tokens,6);assert.equal(f.connections[0].role,role);
    const c=f.connections[0];
    if(provider==='openai'){
      assert.equal(c.headers.authorization,'Bearer fixture-key');assert.match(c.url,/model=/);const s=c.messages.find(x=>x.type==='session.update').session;
      assert.equal(s.audio.input.format.rate,24000);assert.equal(s.type,'realtime');assert.deepEqual(s.output_modalities,role==='gate'?['text']:['audio']);
      assert.deepEqual(s.tools,[]);
      assert.ok(Buffer.from(c.messages.find(x=>x.type==='input_audio_buffer.append').audio,'base64').length>640);
    }
    if(provider==='gemini'){assert.equal(new URL('http://fixture'+c.url).searchParams.get('key'),'fixture-key');assert.ok(c.messages[0].setup);assert.equal(c.messages.filter(x=>x.setup).length,1);if(role==='gate')await until(()=>c.messages.some(x=>x.toolResponse?.functionResponses?.[0]?.name==='submit_decision'));}
    if(provider==='doubao'){
      assert.equal(c.headers['x-api-app-id'],'fixture-app');assert.equal(c.headers['x-api-access-key'],'fixture-key');assert.equal(c.headers['x-api-resource-id'],'volc.speech.dialog');
      assert.equal(c.messages.find(x=>x.event===100).json.tts.audio_config.format,'pcm_s16le');assert.ok(c.messages.some(x=>x.event===(role==='speaker'?300:501)));assert.equal(v.nativeTools,false);
    }
  });
}

test('provider defaults migrate old config; inheritance never crosses vendor credentials',()=>{
  const old=JSON.parse(JSON.stringify(defaults));delete old.low.provider;delete old.high.provider;const migrated=validateConfig(old);assert.equal(migrated.low.provider,'qwen');assert.equal(migrated.high.provider,'inherit');
  const c=structuredClone(defaults);c.low={...c.low,key:'qwen-key'};c.high={...c.high,model:'high'};assert.equal(resolveVoiceConfig(c,'high').key,'qwen-key');
  c.high.provider='gemini';const isolated=resolveVoiceConfig(c,'high');assert.equal(isolated.key,'');assert.equal(isolated.url,voicePresets.gemini.url);assert.equal(isolated.voice,'Aoede');assert.equal(isolated.appId,'');
  assert.throws(()=>assertVoiceReady(isolated),/填写/);assert.throws(()=>assertVoiceReady({...isolated,key:'k',provider:'doubao'}),/App ID/);assert.throws(()=>assertVoiceReady({...isolated,key:'k',provider:'openai',model:'gpt-live-1'}),/Live Sessions/);
  assert.equal(normalizeVoiceURL('openai','https://api.openai.com/v1'),'wss://api.openai.com/v1/realtime');assert.throws(()=>normalizeVoiceURL('gemini','wss://example.com/?key=secret'),/密钥/);
});

test('streaming PCM resampling preserves phase, duration and sample boundaries',()=>{
  const input=Buffer.alloc(32000);for(let i=0;i<input.length/2;i++)input.writeInt16LE(Math.round(Math.sin(i*.1)*10000),i*2);
  const whole=new Pcm16Resampler(16000,24000).process(input),stream=new Pcm16Resampler(16000,24000),chunks:Buffer[]=[];
  for(let p=0;p<input.length;p+=640)chunks.push(stream.process(input.subarray(p,p+640)));assert.deepEqual(Buffer.concat(chunks),whole);assert.equal(whole.length,47998);assert.throws(()=>stream.process(Buffer.alloc(3)),/偶数/);
});

test('Doubao codec matches documented golden bytes and independently encoded compressed/error frames',()=>{
  assert.deepEqual([...encodeDoubao(1)],[17,20,16,0,0,0,0,1,0,0,0,2,123,125]);
  assert.deepEqual(decodeDoubao(serverFrame(550,{content:'中文'},'session')).json,{content:'中文'});
  const compressed=gzipSync(Buffer.from('{"text":"gzip"}')),size=Buffer.alloc(4);size.writeUInt32BE(compressed.length);
  assert.equal(decodeDoubao(Buffer.concat([Buffer.from([17,0x90,0x11,0]),size,compressed])).json.text,'gzip');
  const message=Buffer.from('{"error":"denied"}'),header=Buffer.alloc(8);header.writeUInt32BE(45000000);header.writeUInt32BE(message.length,4);
  assert.equal(decodeDoubao(Buffer.concat([Buffer.from([17,0xf0,0x10,0]),header,message])).code,45000000);
  assert.throws(()=>decodeDoubao(serverFrame(550,{},'s').subarray(0,15)),/长度|截断/);
  const invalid=serverFrame(550,{},'s');invalid[0]=0x21;assert.throws(()=>decodeDoubao(invalid),/格式/);
});

test('Gemini queues context until turn boundary, suppresses cancelled audio',async t=>{
  const f=await voiceFixture('gemini');t.after(()=>f.close());const v=createVoice({role:'high',config:{...voicePresets.gemini,provider:'gemini',url:f.url,key:'k'},appConfig:structuredClone(defaults),instructions:'initial'});t.after(()=>v.close());await v.connect();const c=f.connections[0];const audio:any[]=[],control:any[]=[];v.on('audio',e=>audio.push(e));v.on('control',e=>{control.push(e);v.toolResult(e.call_id,'{"ok":true}');});
  c.send({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=16000',data:'AAAA'}}]}}});await until(()=>audio.length===1);assert.equal(audio[0].sampleRate,16000);
  v.configure('new authoritative state');v.cancel();c.send({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=16000',data:'AAAA'}}]}}});await new Promise(r=>setTimeout(r,20));assert.equal(audio.length,1);
  assert.equal(c.messages.filter(x=>x.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('new authoritative')).length,0);
  c.send({serverContent:{turnComplete:true}});await until(()=>c.messages.some(x=>x.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('new authoritative')));assert.equal(c.messages.filter(x=>x.setup).length,1);

});

test('Doubao context updates keep PCM16 and SC persona; local command suppresses pending native response',async t=>{
  const f=await voiceFixture('doubao');t.after(()=>f.close());const v=createVoice({role:'high',config:{...voicePresets.doubao,provider:'doubao',model:'2.2.0.0',url:f.url,key:'k',appId:'a'},appConfig:structuredClone(defaults),instructions:'SC persona'});t.after(()=>v.close());await v.connect();const c=f.connections[0];assert.equal(c.messages.find(x=>x.event===100).json.dialog.character_manifest,'SC persona');
  v.configure('updated persona');await until(()=>c.messages.some(x=>x.event===201));assert.equal(c.messages.find(x=>x.event===201).json.tts.audio_config.format,'pcm_s16le');
  const audio:any[]=[],done:any[]=[];v.on('audio',x=>audio.push(x));v.on('done',x=>done.push(x));v.suppressTurn?.();c.respond();await until(()=>done.length===1);assert.equal(done[0].status,'cancelled');assert.equal(audio.length,0);
  c.send({event:450});await new Promise(r=>setTimeout(r,10));c.respond();await until(()=>done.length===2);assert.equal(audio.length,1);assert.equal(done[1].status,'completed');
});

test('all native providers require configured-ready acknowledgment before microphone upload',async t=>{
  for(const provider of ['openai','gemini','doubao'] as VoiceProvider[]){
    const f=await voiceFixture(provider,false,false);t.after(()=>f.close());const v=createVoice({role:'high',config:{...voicePresets[provider],provider,url:f.url,key:'k',appId:'a'},appConfig:structuredClone(defaults),instructions:'test'});t.after(()=>v.close());const connecting=v.connect();await until(()=>f.connections[0]?.messages.some(x=>provider==='doubao'?x.event===100:provider==='gemini'?x.setup:x.type==='session.update'));
    v.append('AAA=');assert.equal(f.audioPackets,0);const c=f.connections[0];c.send(provider==='doubao'?{event:150}:provider==='gemini'?{setupComplete:{}}:{type:'session.updated'});await connecting;v.append('AAA=');await until(()=>f.audioPackets===1);v.close();
  }
});

test('provider error text strips raw and URL-encoded credentials',()=>{
  const options:any={config:{key:'a/b+secret',appKey:'app-secret'}};const message=privateError(new Error('wss://x/?key=a%2Fb%2Bsecret a/b+secret app-secret Bearer abc'),options);assert.ok(!message.includes('secret'));assert.ok(!message.includes('Bearer abc'));
});

test('small provider prompt budget retains routing rules, current question and capability status',()=>{
  const packet={purpose:'test',query:'当前问题',instructions:'固定指令',runtime:{advanced:{state:'disabled',message:'没有启用'}},recent:Array.from({length:30},()=>({role:'user',text:'历史'.repeat(500)})),memory:['记忆'.repeat(1000)]};
  const bounded=boundVoiceInstructions('介入规则\n'+JSON.stringify(packet)+'\n明确控制规则',4000);assert.ok(bounded.length<=4000);assert.match(bounded,/介入规则/);assert.match(bounded,/当前问题/);assert.match(bounded,/disabled/);assert.match(bounded,/明确控制规则/);
});
