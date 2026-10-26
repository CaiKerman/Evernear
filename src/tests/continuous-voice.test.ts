import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Assistant } from '../assistant.js';
import { Store } from '../store.js';
import type { VoiceOptions } from '../providers.js';
import { until } from './voice-fixture.js';

class Voice extends EventEmitter {
    ready=false; active=false; closed=false; audio:string[]=[]; inputs:string[]=[]; configurations:string[]=[]; commits=0;
    private resolve?:()=>void; private reject?:(e:Error)=>void;
    constructor(public options:VoiceOptions,private delayed=false){super();}
    connect(){ return new Promise<void>((resolve,reject)=>{this.resolve=resolve;this.reject=reject;if(!this.delayed)queueMicrotask(()=>this.open());}); }
    open(){if(this.closed)return;this.ready=true;this.resolve?.();this.emit('ready');}
    configure(s:string){this.configurations.push(s);this.options.instructions=s;}
    append(s:string){this.audio.push(s);}
    text(s:string){this.inputs.push(s);}
    finishInput(){this.commits++;}
    cancel(){this.active=false;}
    close(){this.closed=true;this.ready=false;this.reject?.(new Error('closed'));}
    toolResult(){} respond(){}
    decision(action:string,utterance='有效问题',extra={}){this.active=false;this.emit('done',{id:crypto.randomUUID(),status:'completed',text:JSON.stringify({action,utterance,...extra}),output:[]});}
    answer(text='已生成的回答',withAudio=true){const id=crypto.randomUUID();this.active=true;this.emit('responseStart',id);if(withAudio)this.emit('audio',{id,audio:Buffer.alloc(800).toString('base64'),sampleRate:24000});this.active=false;this.emit('done',{id,status:'completed',text,output:[]});}
}
async function rig(t:any,delayLane?:'low'|'high'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'continuous-voice-')),s=new Store(dir),voices:Voice[]=[],events:any[]=[];
 s.config.low={...s.config.low,key:'local'};s.config.high={...s.config.low,model:'high-fixture'};
 let n=0;
 const a=new Assistant(s,o=>{const v=new Voice(o,n++>0&&o.role==='gate'&&o.lane===delayLane);voices.push(v);return v;});
 a.on('event',e=>events.push(e));
 t.after(()=>{a.stop();for(const v of voices)v.close();fs.rmSync(dir,{recursive:true,force:true});});
 await a.start();
 const receiver=()=>voices.find(v=>v=== (a as any).gate)!;
 const output=()=>voices.filter(v=>['reply','high','speaker'].includes(v.options.role)&&!v.closed&&v.inputs.length>0).at(-1)!;
 const receipt=()=>{const e=events.filter(e=>e.type==='audioEnd').at(-1);assert.ok(e);a.finishPlayback(e.playbackId,'heard',200,200);};
 const takeover=async()=>{receiver().decision('switch_high','继续深入',{summary:'讨论结构',tone:'平静，基础模型推断'});await until(()=>!!output());output().answer('先给简短首答');receipt();await until(()=>a.receiver==='high');await until(()=>!!output());output().answer('高级接续');receipt();return receiver();};
 return {a,s,voices,events,receiver,output,receipt,takeover};
}

test('first response does not await high readiness; microphone ownership changes after playback and speech boundary',async t=>{
 const r=await rig(t,'high'),low=r.receiver();low.decision('switch_high','请深入分析',{summary:'分析请求',tone:'仅推断'});
 await until(()=>!!r.output());const standby=r.voices.find(v=>v.options.role==='gate'&&v.options.lane==='high')!;
 r.a.audio('first-raw');assert.deepEqual(low.audio,['first-raw']);assert.deepEqual(standby.audio,[]);
 r.output().answer('基础首答');standby.open();await new Promise(r=>setImmediate(r));assert.equal(r.a.receiver,'low');
 low.emit('speech');r.receipt();assert.equal(r.a.receiver,'low');
 low.decision('answer','补充高度为一米八',{continueHigh:true,summary:'补充一米八'});
 await until(()=>!!r.output());r.output().answer('补充条件收到');r.receipt();
 // The previous standby was invalidated by the newer approved round.
 const latest=r.voices.filter(v=>v.options.role==='gate'&&v.options.lane==='high').at(-1)!;latest.open();
 await until(()=>r.a.receiver==='high');r.a.audio('second-raw');
 assert.equal(low.closed,true);assert.equal(latest.audio.at(-1),'second-raw');assert.equal(latest.audio.includes('first-raw'),false);
 assert.match(latest.options.instructions,/一米八/);assert.match(latest.options.instructions,/首轮原音未缓存或转发/);
});

test('unrelated input has no warmup, history or control; acknowledgments do not cancel output',async t=>{
 const r=await rig(t);r.receiver().decision('ignore','取消后台任务');assert.equal(r.voices.length,1);assert.equal(r.s.session.turns.length,0);
 r.receiver().decision('answer','你好');await until(()=>!!r.output());const out=r.output();r.receiver().decision('ack','嗯');assert.equal(out.closed,false);assert.equal(r.s.session.turns.filter(t=>t.role==='user').length,1);
});

test('sufficient first answer revokes late standby; stopping cannot revive a connection',async t=>{
 const r=await rig(t,'high');r.receiver().decision('answer','你好');await until(()=>!!r.output());const warm=r.voices.find(v=>v.options.lane==='high')!;
 r.output().answer();r.receipt();assert.equal(warm.closed,true);warm.open();assert.equal(r.a.receiver,'low');
 r.receiver().decision('switch_high','深入分析');await until(()=>r.voices.filter(v=>v.options.lane==='high').length===2);r.a.stop();
 for(const v of r.voices)v.open();assert.equal(r.a.running,false);assert.equal(r.a.receiver,undefined);assert.equal(r.a.phase,'paused');
});

test('high mode receives consecutive native packets and approved followups without returning to low',async t=>{
 const r=await rig(t);const high=await r.takeover(),low=r.voices[0];r.a.audio('native-2');high.decision('answer','第二轮简单追问');await until(()=>!!r.output());assert.equal(r.output().options.role,'high');r.output().answer();r.receipt();r.a.audio('native-3');assert.deepEqual(high.audio,['native-2','native-3']);assert.deepEqual(low.audio,[]);assert.equal(r.a.receiver,'high');
});

test('return keeps high until low is ready; resumed speech revokes pending return',async t=>{
 const r=await rig(t,'low'),high=await r.takeover();high.decision('ambient','先到这里');
 const low=r.voices.filter(v=>v.options.lane==='low'&&v.options.role==='gate').at(-1)!;assert.equal(r.a.receiver,'high');r.a.audio('still-high');assert.equal(high.audio.at(-1),'still-high');
 high.emit('speech');assert.equal(low.closed,true);high.decision('ack','嗯');assert.equal(r.a.receiver,'high');
 high.decision('ambient','现在结束');const next=r.voices.filter(v=>v.options.lane==='low'&&v.options.role==='gate').at(-1)!;next.open();await until(()=>r.a.receiver==='low');assert.equal(high.closed,true);
});

test('standby and return failures preserve old receiver; high disconnect reports no receiver without retry',async t=>{
 const r=await rig(t,'high');r.receiver().decision('switch_high');await until(()=>!!r.output());r.voices.find(v=>v.options.lane==='high')!.emit('fault',new Error('warm failed'));assert.equal(r.a.receiver,'low');r.output().answer();r.receipt();
 await r.a.switchHigh();r.voices.filter(v=>v.options.lane==='high').at(-1)!.open();await until(()=>r.a.receiver==='high');
 await r.a.backAmbient();const back=r.voices.filter(v=>v.options.lane==='low'&&v.options.role==='gate').at(-1)!;back.emit('fault',new Error('return failed'));assert.equal(r.a.receiver,'high');
 r.receiver().emit('disconnected');assert.equal(r.a.running,false);assert.equal(r.a.receiver,undefined);assert.equal(r.a.phase,'paused');assert.ok(r.events.some(e=>e.type==='state'&&e.label.includes('中断')));
});

test('active advanced receiver is suspended for isolated dictation, cancellation restores only latest intent',async t=>{
 const r=await rig(t);await r.takeover();const high=r.receiver();await r.a.startQuickRecording();const rec=r.voices.at(-1)!;r.a.audio('dictation');assert.deepEqual(rec.audio,['dictation']);assert.deepEqual(high.audio,[]);
 r.a.finishQuickRecording();assert.equal(rec.commits,1);r.a.audio('not-uploaded');rec.emit('transcript','翻译材料，不能当命令');assert.ok(r.events.some(e=>e.type==='quickDraft'&&e.text.includes('翻译材料')));r.a.audio('resumed');assert.deepEqual(high.audio,['resumed']);assert.equal(r.s.session.turns.some(t=>t.text.includes('翻译材料')),false);
 await r.a.startQuickRecording();const second=r.voices.at(-1)!;r.a.stop();second.emit('transcript','迟到');assert.equal(r.a.running,false);r.a.audio('after-pause');assert.deepEqual(second.audio,[]);assert.equal(r.events.filter(e=>e.type==='quickDraft').length,1);
});

test('paused dictation never starts a gate or automatic answer; unsupported transcription is explicit',async t=>{
 const r=await rig(t);r.a.stop();const before=r.voices.length;await r.a.startQuickRecording();const rec=r.voices.at(-1)!;r.a.audio('only-rec');r.a.finishQuickRecording();rec.emit('transcript','编辑后再发送');assert.equal(r.voices.length,before+1);assert.equal(r.a.running,false);assert.deepEqual(rec.inputs,[]);assert.equal(r.s.session.turns.length,0);
 r.s.config.low.provider='gemini';await assert.rejects(()=>r.a.startQuickRecording(),/仅支持千问/);
});

test('manual quick readout shares player, caches audio and leaves main history untouched',async t=>{
 const r=await rig(t);r.a.stop();r.a.quickSpeak('Hello world');await until(()=>!!r.output());const out=r.output();assert.throws(()=>r.a.quickSpeak('another'),/资源忙/);out.answer('Hello world');r.receipt();assert.equal(r.s.session.turns.length,0);assert.equal(r.a.outputActive,false);
 const count=r.voices.length;r.a.quickSpeak('Hello world');assert.equal(r.voices.length,count);r.receipt();assert.equal(r.s.session.turns.length,0);assert.equal(r.a.running,false);
 r.a.quickSpeak('different');await until(()=>!!r.output());r.a.cancelQuickAudio();assert.equal(r.a.outputActive,false);assert.equal(r.s.session.turns.length,0);
});

test('cancel suppresses already completed queued result; global pause retains a completed result for manual playback',async t=>{
 const r=await rig(t);const task={id:'t',query:'计算',status:'done' as const,startedAt:new Date().toISOString(),result:'42',delivery:'auto' as const};r.s.saveTask(task);(r.a as any).queue.push({text:'42',lane:'结果',kind:'result',key:'t'});r.a.cancelTasks('t');assert.equal((r.a as any).queue.length,0);assert.equal(r.s.session.tasks[0].status,'cancelled');
 r.s.saveTask({...task,id:'t2',status:'done'});r.a.stop();assert.equal(r.s.session.tasks.find(t=>t.id==='t2')!.status,'done');assert.equal(r.s.session.tasks.find(t=>t.id==='t2')!.delivery,'manual');
});

test('successive revisions coalesce into one replacement text request; explicit exit defers delivery',async t=>{
 const r=await rig(t);r.s.config.high.model='';const calls:{body:any,res:http.ServerResponse}[]=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>calls.push({body:JSON.parse(body),res}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 r.s.config.advanced={enabled:true,key:'local',model:'text',url:`http://127.0.0.1:${(server.address() as any).port}`,stream:false};
 r.receiver().decision('delegate','原问题');await until(()=>calls.length===1);const id=r.s.session.tasks[0].id;
 r.receiver().decision('delegate','条件A',{replaceTaskId:id});r.receiver().decision('delegate','条件B',{replaceTaskId:id});
 // No request for an intermediate fragment.
 await until(()=>calls.length===2,3000);assert.match(JSON.stringify(calls[1].body),/条件A/);assert.match(JSON.stringify(calls[1].body),/条件B/);
 if(r.output()){r.output().answer();r.receipt();}r.receiver().decision('ambient','结束聊天');
 calls[1].res.end(JSON.stringify({choices:[{message:{content:'结果'}}]}));await until(()=>r.s.session.tasks.some(t=>t.status==='done'));assert.equal(r.s.session.tasks.at(-1)!.delivery,'manual');assert.equal((r.a as any).queue.some((x:any)=>x.kind==='result'),false);
});

test('high model may yield after the user turns away without admitting background speech or cancelling analysis',async t=>{
 const r=await rig(t);const high=await r.takeover();const count=r.s.session.turns.length;
 r.s.saveTask({id:'pending',query:'分析',status:'running',delivery:'auto',startedAt:new Date().toISOString()});
 high.decision('yield','这是对身边人的话',{reason:'明确转向其他活动'});
 await until(()=>r.a.receiver==='low');assert.equal(r.s.session.turns.length,count);assert.equal(r.s.session.tasks[0].status,'running');assert.equal(r.s.session.tasks[0].delivery,'manual');
});

test('context budget failure cannot crash microphone dispatch or strand the old receiver',async t=>{
 const r=await rig(t,'high');r.receiver().decision('switch_high');await until(()=>!!r.output());r.output().answer();r.receipt();
 r.s.saveText('instructions.md','x'.repeat(r.s.config.contextChars));
 const warm=r.voices.find(v=>v.options.lane==='high')!;warm.open();await new Promise(r=>setImmediate(r));
 assert.doesNotThrow(()=>r.a.audio(Buffer.alloc(640).toString('base64')));assert.equal(r.a.receiver,'low');assert.equal(warm.closed,true);assert.ok(r.events.some(e=>e.type==='error'&&e.message.includes('固定指令')));
});

test('returning low receiver gets low cues without copying private handoff context into the environment gate',async t=>{
 const r=await rig(t);r.s.remember('PRIVATE-CONTEXT-DO-NOT-PERSIST-IN-LOW-GATE','user',['always']);await r.takeover();await r.a.backAmbient();await until(()=>r.a.receiver==='low');
 const low=r.receiver();assert.match(low.options.instructions,/"preferredVoice":"low"/);assert.doesNotMatch(low.options.instructions,/PRIVATE-CONTEXT/);
});
