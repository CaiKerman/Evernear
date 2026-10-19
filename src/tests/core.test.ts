import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { EventEmitter, once } from 'node:events';
import { Store, defaults, validateConfig } from '../store.js';
import { buildContext, parseIntervention, selectMemories } from '../context.js';
import { Assistant } from '../assistant.js';
import { Realtime, TextModel, safeError } from '../providers.js';
import { advancedAvailability, UsageMeter } from '../runtime.js';
import type { AppEvent } from '../types.js';

function fixture(t:any){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-test-')),store=new Store(dir);t.after(()=>{(store as any).cleanup?.();fs.rmSync(dir,{recursive:true,force:true});});return store;}
async function until(predicate:()=>boolean,ms=1500){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end)throw new Error('condition timed out');await new Promise(r=>setTimeout(r,10));}}
class FakeVoice extends EventEmitter {
  ready=false;active=false;closed=false;texts:string[]=[];sent:any[]=[];
  constructor(public options:any){super();}
  async connect(){this.ready=true;}
  configure(instructions:string){this.options.instructions=instructions;}
  append(audio:string){this.sent.push(audio);}
  text(text:string){this.texts.push(text);this.active=true;}
  toolResult(...args:any[]){this.sent.push(args);}
  respond(){}
  cancel(){this.active=false;}
  close(){this.closed=true;this.ready=false;}
}
function assistantFixture(t:any){const store=fixture(t),voices:FakeVoice[]=[];const a=new Assistant(store,o=>{const f=new FakeVoice(o);voices.push(f);return f as unknown as Realtime;});const events:AppEvent[]=[];a.on('event',e=>events.push(e));(store as any).cleanup=()=>a.stop();return {store,voices,a,events};}
async function server(t:any,handler:http.RequestListener){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${(s.address() as any).port}`;}
function jsonResponse(res:http.ServerResponse,value:unknown){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}

test('plaintext config and memory stay portable; backup and restart recovery preserve state',t=>{
  const s=fixture(t);s.saveConfig({...defaults,low:{...defaults.low,key:'personal-test-secret'}});
  assert.match(fs.readFileSync(s.file('config.json'),'utf8'),/personal-test-secret/);
  s.remember('当前项目使用 RAMSIS 手指映射','explicit user',['ramsis']);s.remember('当前项目使用 RAMSIS 手指映射','duplicate');assert.equal(s.memories().length,1);
  const turn=s.addTurn('assistant','尚未播放的回答','test','generated');
  s.saveTask({id:'t',query:'original',status:'running',startedAt:'now'});
  const restored=new Store(s.folder);assert.equal(restored.session.turns.find(x=>x.id===turn.id)?.delivery,'unheard');assert.equal(restored.session.tasks[0].status,'failed');
  assert.ok(fs.existsSync(s.file('config.json.bak')));
});
test('invalid configuration is rejected and corrupt files are not silently overwritten',t=>{
  const s=fixture(t);const original=fs.readFileSync(s.file('config.json'),'utf8');
  assert.throws(()=>s.saveConfig({...defaults,contextChars:-1}));assert.equal(fs.readFileSync(s.file('config.json'),'utf8'),original);
  fs.writeFileSync(s.file('config.json'),'{broken');assert.throws(()=>new Store(s.folder),/原文件已保留/);assert.equal(fs.readFileSync(s.file('config.json'),'utf8'),'{broken');
  assert.throws(()=>validateConfig({...defaults,vad:{...defaults.vad,silenceMs:10}}));
});
test('relevant memories are selected; unrelated project context is excluded; budget and playback labels hold',t=>{
  const s=fixture(t);s.remember('RAMSIS 手指骨骼映射当前在第一阶段','user');s.remember('最喜欢的水果是西瓜','user');s.remember('使用简体中文 #always','user');
  const m=selectMemories(s.memories(),'继续 RAMSIS 手指映射');assert.ok(m.some(x=>x.text.includes('RAMSIS')));assert.ok(!m.some(x=>x.text.includes('西瓜')));
  s.addTurn('assistant','尚未听见的内容','test','partial');
  const p=buildContext({...s.config,contextChars:2000},s.instructions(),s.memories(),s.session,'继续 RAMSIS 手指映射','test');
  assert.ok(p.chars<=2000);assert.doesNotMatch(p.text,/尚未听见|delivery|lane|heardMs/);assert.ok(p.memory.some(x=>x.includes('RAMSIS')));
  assert.throws(()=>buildContext({...s.config,contextChars:2000},'x'.repeat(900),[],s.session,'q','test'),/固定指令/);
});
test('clearing task records persists only running tasks and keeps conversation and request history',t=>{
  const {a,store,events}=assistantFixture(t);
  for(const status of ['done','failed','cancelled','running'] as const)store.saveTask({id:status,query:status,status,startedAt:new Date().toISOString()});
  store.addTurn('user','保留这条对话','test');store.remember('用户偏好简短回答','user');store.append('requests',{phase:'start',source:'fixture'});
  assert.equal(a.clearTaskRecords(),3);assert.deepEqual(store.session.tasks.map(t=>t.id),['running']);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file('session.json'),'utf8')).tasks.map((t:any)=>t.id),['running']);
  assert.equal(store.session.turns.at(-1)?.text,'保留这条对话');assert.match(store.memoryText(),/简短回答/);assert.equal(fs.readdirSync(store.file('requests')).length,1);
  assert.equal(events.at(-1)?.type,'state');assert.equal(events.at(-1)?.tasks.length,1);assert.equal(a.clearTaskRecords(),0);
  assert.equal(a.cancelTasks(),1);assert.equal(a.clearTaskRecords(),1);assert.deepEqual(new Store(store.folder).session.tasks,[]);
});
test('audio worklet preserves sample count across 128-frame boundaries',()=>{
  let Capture:any;const packets:any[]=[];class Base{port={postMessage:(m:any)=>{if(m.type==='pcm')packets.push(new Int16Array(m.buffer).slice());}};}
  const source=fs.readFileSync(new URL('../ui/capture-worklet.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{AudioWorkletProcessor:Base,sampleRate:48000,Int16Array,Math,registerProcessor:(_:string,c:any)=>Capture=c});
  const c=new Capture();for(let i=0;i<48000;i+=128){const data=new Float32Array(Math.min(128,48000-i)).fill(.5);c.process([[data]],[]);}
  assert.equal(packets.reduce((n,x)=>n+x.length,0),16000);assert.equal(packets[0][0],16383);
});
test('secret redaction does not expose configured provider keys',()=>{assert.equal(safeError(new Error('failed personal-secret'),['personal-secret']),'failed [已隐藏]');assert.ok(!safeError('Bearer tokenvalue').includes('tokenvalue'));});
test('filled, disabled and incomplete advanced configurations have distinct truthful states',()=>{
  const c=structuredClone(defaults);c.advanced.key='fixture-key';
  assert.match(advancedAvailability(c).message,/接口已填写.*开关关闭/);
  c.advanced.enabled=true;c.advanced.key='   ';assert.equal(advancedAvailability(c).state,'incomplete');assert.match(advancedAvailability(c).message,/缺少API Key/);
  c.advanced.key='fixture-key';assert.equal(advancedAvailability(c).state,'configured');
  assert.equal(parseIntervention(JSON.stringify({action:'capabilities',utterance:'高级模型启用了吗'})).action,'capabilities');
});
test('usage meter separates input/output and provider roles over an explicit observation duration',()=>{
  const meter=new UsageMeter();assert.equal(meter.snapshot(1000).since,null);meter.reset(1000);
  meter.record('gate',{input_tokens:1000,output_tokens:40,total_tokens:1040},2000);
  meter.record('speaker',{input_tokens:20,output_tokens:80},3000);
  meter.record('advanced',{prompt_tokens:100,completion_tokens:10},4000);
  meter.record('gate',{input_tokens:'bad',output_tokens:-1},5000);
  const s=meter.snapshot(61000);assert.equal(s.elapsedSeconds,60);assert.equal(s.byRole.gate.inputTokens,1000);assert.equal(s.byRole.gate.calls,1);
  assert.equal(s.byRole.speaker.outputTokens,80);assert.equal(s.byRole.advanced.inputTokens,100);assert.match(s.note,/粗估|外推/);
});
test('unstable configured voice connections back off instead of reconnecting every second',async t=>{
 const {a,voices}=assistantFixture(t);await a.start();t.mock.timers.enable({apis:['setTimeout']});
 voices[0].emit('disconnected',1006);t.mock.timers.tick(1000);await new Promise(setImmediate);assert.equal(voices.length,1);
 t.mock.timers.tick(5000);await new Promise(setImmediate);assert.equal(voices.length,2);
 voices[1].emit('disconnected',1006);t.mock.timers.tick(6000);await new Promise(setImmediate);assert.equal(voices.length,2);
 t.mock.timers.tick(6000);await new Promise(setImmediate);assert.equal(voices.length,3);
});
