import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';
import { RequestController, LocalRequestLimit } from '../requests.js';import { ApiFailure } from '../api-errors.js';import { TextModel, postJSON } from '../providers.js';import { defaults,validateConfig } from '../store.js';
const info=(source='advanced-task')=>({url:'https://fixture.invalid/v1/chat/completions?key=private-query-key',model:'fixture',source,channel:'advanced' as const});
const fast=(limit=8)=>new RequestController(()=>({origin:'https://fixture.invalid',limit}),{windowMs:100,minIntervalMs:0,cooldownMs:60});
const signal=()=>new AbortController().signal;
async function server(t:any,handler:http.RequestListener){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${(s.address() as any).port}/v1/chat/completions`;}

test('reasoning, connection tests and memory share one rolling request budget including failures',async()=>{
 const c=fast(3);let sent=0;const send=async()=>{sent++;return 'ok';};await c.run(info('connection-test'),signal(),send);await c.run(info('memory-auto'),signal(),send);
 await assert.rejects(()=>c.run(info(),signal(),async()=>{sent++;throw new ApiFailure(500,{error:{message:'fixture'}});}));
 await assert.rejects(()=>c.run(info(),signal(),send),LocalRequestLimit);assert.equal(sent,3);assert.equal(c.snapshot().counts.advanced,3);assert.equal(c.snapshot().blocked,1);
 await new Promise(r=>setTimeout(r,120));await c.run(info(),signal(),send);assert.equal(sent,4);
});
test('production defaults space real requests by at least one second',async()=>{
 const c=new RequestController(),starts:number[]=[];for(let i=0;i<2;i++)await c.run(info(),signal(),async()=>starts.push(Date.now()));assert.ok(starts[1]-starts[0]>=950);
});
test('queued requests are serialized and cancelling a waiter cannot release another active request',async()=>{
 const c=fast();let release!:()=>void,active=0,maxActive=0,sent=0;
 const first=c.run(info(),signal(),async()=>{sent++;active++;maxActive=Math.max(maxActive,active);await new Promise<void>(r=>release=r);active--;});
 await new Promise(r=>setTimeout(r,5));const abort=new AbortController();const second=c.run(info(),abort.signal,async()=>{sent++;});const rejected=assert.rejects(()=>second);abort.abort(new Error('cancel queued'));
 const third=c.run(info(),signal(),async()=>{sent++;active++;maxActive=Math.max(maxActive,active);active--;});await rejected;assert.equal(sent,1);release();await Promise.all([first,third]);assert.equal(sent,2);assert.equal(maxActive,1);
});
test('429 applies a default 60 second cooldown and further attempts stay local',async()=>{
 const c=new RequestController();let sent=0;
 await assert.rejects(()=>c.run(info(),signal(),async()=>{sent++;throw new ApiFailure(429,{error:{message:'limit'}});}));
 await assert.rejects(()=>c.run(info('connection-test'),signal(),async()=>{sent++;}),/冷却/);assert.equal(sent,1);
 const end=c.snapshot().latest.find(x=>x.cooldownUntil);assert.ok(Date.parse(end.cooldownUntil)-Date.now()>59000);
});
test('Retry-After extends cooldown and does not schedule an automatic retry',async()=>{
 const c=fast();let sent=0;await assert.rejects(()=>c.run(info(),signal(),async()=>{sent++;throw new ApiFailure(429,{}, {get:n=>n==='retry-after'?'3':null});}));
 const until=c.snapshot().latest.find(x=>x.cooldownUntil).cooldownUntil;assert.ok(Date.parse(until)-Date.now()>2900);await new Promise(r=>setTimeout(r,30));assert.equal(sent,1);
});
test('voice handshakes are observed separately from the advanced HTTP cap; audio packets are not requests',async()=>{
 const c=fast(2),done=c.voice({...info(),url:'wss://fixture.invalid/live',channel:'voice',source:'voice-gate'});done('connected');
 await c.run(info(),signal(),async()=>{});c.voice({...info(),url:'wss://fixture.invalid/live',channel:'voice',source:'voice-speaker'})('connected');await c.run(info(),signal(),async()=>{});await assert.rejects(()=>c.run(info(),signal(),async()=>{}),LocalRequestLimit);
 c.voice({...info(),url:'wss://other.invalid/live',channel:'voice',source:'voice-gate'})('connected');assert.equal(c.snapshot().counts.voice,3);assert.equal(c.snapshot().counts.advanced,2);
 const text=JSON.stringify(c.snapshot());assert.doesNotMatch(text,/private-query-key|\?key=/);
});
test('each explicit task sends one text request without a tool loop',async t=>{
 const bodies:any[]=[];const url=await server(t,(req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const body=JSON.parse(raw);bodies.push(body);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:body.tools?{role:'assistant',tool_calls:[{id:'call-'+bodies.length,type:'function',function:{name:'calculate',arguments:'{"expression":"2+2"}'}}]}:{content:'完成'}}]}));});});
 const c=structuredClone(defaults);c.advanced={enabled:true,url,key:'fixture-key',model:'fixture',stream:false};const guard=fast();
 await new TextModel(c,undefined,{requests:guard,source:'connection-test'}).complete([{role:'user',content:'test'}],signal());assert.equal(bodies.length,1);
 await new TextModel(c,undefined,{requests:guard,source:'advanced-task'}).complete([{role:'user',content:'test'}],signal());assert.equal(bodies.length,2);assert.equal(bodies.at(-1).tools,undefined);
 assert.equal(guard.snapshot().counts.advanced,2);assert.doesNotMatch(JSON.stringify(guard.snapshot()),/fixture-key/);
});
test('old configs gain an eight request default and invalid caps are rejected',()=>{
 const c=structuredClone(defaults);delete c.advanced.requestsPerMinute;assert.equal(validateConfig(c).advanced.requestsPerMinute,8);assert.throws(()=>validateConfig({...defaults,advanced:{...defaults.advanced,requestsPerMinute:0}}),/每分钟/);
});

test('voice handshake 429 cools that origin down even when text uses another provider',()=>{
 const c=new RequestController(()=>({origin:'https://text.invalid',limit:8}));c.voice({...info(),url:'wss://voice.invalid/live',channel:'voice'})('failed',429);
 assert.throws(()=>c.voice({...info(),url:'wss://voice.invalid/live',channel:'voice'}),/冷却/);assert.equal(c.snapshot().counts.voice,1);
});
test('optional blank advanced URL never prevents an independent voice provider connecting',()=>{
 const c=new RequestController(()=>({origin:'',limit:8}));assert.doesNotThrow(()=>c.voice({...info(),url:'wss://voice.invalid/live',channel:'voice'})('connected'));
});


test('HTTP redirects are surfaced rather than silently issuing more requests',async t=>{
 let received=0;const url=await server(t,(req,res)=>{req.resume();received++;res.writeHead(307,{location:'/redirect-loop'});res.end();});
 await assert.rejects(()=>postJSON(url,'fixture',{},'',signal()),/重定向/);assert.equal(received,1);
});

test('first HTTP 429 reports one actual task call and makes no retry, even when gateway claims ten per minute',async t=>{
 let sent=0;const url=await server(t,(req,res)=>{sent++;req.resume();res.writeHead(429,{'content-type':'application/json','x-request-id':'first-turn-fixture'});res.end(JSON.stringify({error:{code:'new_api_error',message:'您已达到请求数限制：1分钟内最多请求10次'}}));});
 const config=structuredClone(defaults);config.advanced={enabled:true,url,key:'private-fixture',model:'reasoner',stream:false};const c=new RequestController();
 await assert.rejects(()=>new TextModel(config,undefined,{requests:c,source:'advanced-task',taskId:'first'}).complete([{role:'user',content:'第一句话'}],signal()),e=>{assert.match(String(e),/本机该站近60秒实际发出 1 次/);assert.match(String(e),/本任务文字第 1 次请求/);assert.match(String(e),/不自动重试/);return true;});
 await assert.rejects(()=>new TextModel(config,undefined,{requests:c,source:'advanced-task',taskId:'second'}).complete([{role:'user',content:'请重试'}],signal()),/冷却/);
 assert.equal(sent,1);const evidence=c.snapshot().latest.find(r=>r.status===429).localEvidence;assert.equal(evidence.total,1);assert.equal(evidence.taskRequests,1);assert.doesNotMatch(JSON.stringify(c.snapshot()),/private-fixture|第一句话/);
});
