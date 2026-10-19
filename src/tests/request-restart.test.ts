import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RequestController} from '../requests.js';import {ApiFailure} from '../api-errors.js';
const policy=()=>({origin:'https://fixture.invalid',limit:3});
const info={url:'https://fixture.invalid/v1/chat/completions',source:'advanced-task',channel:'advanced' as const,model:'fixture'};
function file(t:any){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-request-state-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'request-state.json');}
test('request cap and cooldown survive process recreation without resending anything',async t=>{
 const f=file(t);let sent=0;const first=new RequestController(policy,{minIntervalMs:0},f);
 await first.run(info,new AbortController().signal,async()=>sent++);await first.run(info,new AbortController().signal,async()=>sent++);
 const second=new RequestController(policy,{minIntervalMs:0},f);assert.equal(second.snapshot().counts.advanced,2);
 await assert.rejects(()=>second.run(info,new AbortController().signal,async()=>{sent++;throw new ApiFailure(429,{}, {get:n=>n==='retry-after'?'120':null});}),/HTTP 429/);
 const third=new RequestController(policy,{minIntervalMs:0},f);await assert.rejects(()=>third.run(info,new AbortController().signal,async()=>sent++),/冷却/);assert.equal(sent,3);assert.equal(third.snapshot().counts.advanced,3);
});
test('old request logs seed recent counts on upgrade; cache and logs do not double count a request',async t=>{
 const f=file(t),logdir=path.join(path.dirname(f),'requests');fs.mkdirSync(logdir);const log=path.join(logdir,'2026-10-18.jsonl');
 const r={at:new Date().toISOString(),origin:'https://fixture.invalid',path:'/v1/chat/completions',id:'old-start',phase:'start',channel:'advanced',source:'connection-test',model:'fixture'};fs.writeFileSync(log,JSON.stringify(r)+'\n');
 const a=new RequestController(policy,{minIntervalMs:0},f);a.on('record',x=>fs.appendFileSync(log,JSON.stringify(x)+'\n'));assert.equal(a.snapshot().counts.advanced,1);
 await a.run(info,new AbortController().signal,async()=>{});const b=new RequestController(policy,{minIntervalMs:0},f);assert.equal(b.snapshot().counts.advanced,2);
 await b.run(info,new AbortController().signal,async()=>{});const c=new RequestController(policy,{minIntervalMs:0},f);let sent=0;await assert.rejects(()=>c.run(info,new AbortController().signal,async()=>sent++),/上限 3/);assert.equal(sent,0);
});
test('expired starts do not block a new request, but a longer Retry-After remains after restart',async t=>{
 const f=file(t),old=Date.now()-70000;fs.writeFileSync(f,JSON.stringify({version:1,records:[{at:new Date(old).toISOString(),origin:'https://fixture.invalid',path:'/v1',id:'x',phase:'start',channel:'advanced',source:'advanced-task',model:'m'},{at:new Date(old).toISOString(),origin:'https://fixture.invalid',path:'/v1',id:'x',phase:'finish',channel:'advanced',source:'advanced-task',model:'m',cooldownUntil:new Date(Date.now()+120000).toISOString()}]}));
 const c=new RequestController(policy,{},f);assert.equal(c.snapshot().counts.advanced,0);await assert.rejects(()=>c.run(info,new AbortController().signal,async()=>{}),/冷却/);
});
test('corrupt state uses intact logs, preserves backup and excludes unknown fields from diagnostics',async t=>{
 const f=file(t);fs.writeFileSync(f,'{broken');const c=new RequestController(policy,{minIntervalMs:0},f);assert.match(c.snapshot().persistenceWarning||'',/缓存/);await c.run(info,new AbortController().signal,async()=>{});assert.equal(fs.readFileSync(f+'.invalid.bak','utf8'),'{broken');
 const data=JSON.parse(fs.readFileSync(f,'utf8'));data.records[0].api_key='do-not-expose';fs.writeFileSync(f,JSON.stringify(data));const d=new RequestController(policy,{minIntervalMs:0},f);assert.doesNotMatch(JSON.stringify(d.snapshot()),/do-not-expose|api_key/);
});
