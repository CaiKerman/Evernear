import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import { once } from 'node:events';
import { ApiFailure, readFailureBody } from '../api-errors.js';import { postJSON, readChatStream, TextModel } from '../providers.js';import { defaults } from '../store.js';
async function fixture(t:any,handler:http.RequestListener){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${(s.address() as any).port}/v1/chat/completions`;}
const signal=()=>AbortSignal.timeout(3000);
async function* bytes(s:string){for(const value of Buffer.from(s))yield Uint8Array.of(value);}

test('HTTP 429 rate limit keeps message, type, request ID and Retry-After without retrying',async t=>{
 let calls=0;const url=await fixture(t,(req,res)=>{req.resume();calls++;res.writeHead(429,{'Content-Type':'application/json','x-request-id':'req-fixture-429','retry-after':'45'});res.end(JSON.stringify({error:{type:'rate_limit_exceeded',message:'当前分组上游负载已饱和'}}));});
 await assert.rejects(()=>postJSON(url,'fixture-key',{model:'fixture'},'',signal()),e=>{assert.ok(e instanceof ApiFailure);assert.equal(e.status,429);assert.match(e.message,/上游负载已饱和/);assert.match(e.message,/rate_limit_exceeded/);assert.match(e.message,/req-fixture-429/);assert.match(e.message,/45/);assert.doesNotMatch(e.message,/余额不足/);return true;});assert.equal(calls,1);
});
test('HTTP 429 quota exhaustion is distinct from temporary rate limit',()=>{
 const e=new ApiFailure(429,{error:{code:'insufficient_quota',message:'Your account balance is insufficient'}});assert.match(e.message,/额度或余额不足/);assert.doesNotMatch(e.message,/请求频率/);
});
test('HTTP 500 retains upstream parameter errors and redacts credentials before display',async t=>{
 const url=await fixture(t,(req,res)=>{req.resume();res.writeHead(500,{'Content-Type':'application/json','x-oneapi-request-id':'proxy-request-500'});res.end(JSON.stringify({error:{code:'upstream_error',message:'Unsupported parameter max_tokens; use max_completion_tokens. credential=fixture/private+key; encoded=fixture%2Fprivate%2Bkey; Bearer unrelated-secret'}}));});
 await assert.rejects(()=>postJSON(url,'fixture/private+key',{},'',signal()),e=>{assert.ok(e instanceof Error);assert.match(e.message,/max_completion_tokens/);assert.match(e.message,/proxy-request-500/);assert.doesNotMatch(e.message,/fixture\/private|fixture%2Fprivate|unrelated-secret/);return true;});
});
test('empty, plaintext, HTML and excessive error bodies remain bounded and readable',async()=>{
 assert.equal(await readFailureBody(bytes('')),undefined);assert.equal(await readFailureBody(bytes('upstream unavailable')),'upstream unavailable');
 const e=new ApiFailure(502,await readFailureBody(bytes('<html><title>Bad Gateway</title><script>private script</script></html>')));assert.match(e.message,/Bad Gateway/);assert.doesNotMatch(e.message,/script/);
 const large=await readFailureBody(bytes('secret'.repeat(2000)));assert.match(large.message,/8 KiB/);assert.doesNotMatch(new ApiFailure(500,large).message,/secret/);
 assert.ok(new ApiFailure(500,'x'.repeat(9000)).message.length<1000);
});
test('UTF-8 Chinese error split across chunks is decoded intact',async()=>{
 const body=await readFailureBody(bytes('{"error":{"message":"模型暂时不可用"}}'));assert.equal(body.error.message,'模型暂时不可用');
});
test('HTTP 200 JSON error envelope is not mistaken for an empty successful model reply',async t=>{
 const url=await fixture(t,(req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'application/json','x-request-id':'req-semantic-error'});res.end('{"error":{"code":"model_not_found","message":"Model route is not available"}}');});
 await assert.rejects(()=>postJSON(url,'fixture',{},'',signal()),/Model route is not available/);
});
test('SSE error preserves upstream code and message instead of generic streaming failure',async()=>{
 await assert.rejects(()=>readChatStream(bytes('data: {"error":{"code":"rate_limit_exceeded","message":"TPM limit exceeded for fixture-secret"}}\n\n'),signal(),{secrets:['fixture-secret'],headers:{get:n=>n==='x-request-id'?'req-sse':''}}),e=>{assert.ok(e instanceof ApiFailure);assert.match(e.message,/TPM limit exceeded/);assert.match(e.message,/req-sse/);assert.doesNotMatch(e.message,/fixture-secret/);return true;});
});
test('actual advanced model task request has no tool payload and surfaces response diagnostics',async t=>{
 let toolRequest=false;const url=await fixture(t,(req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{toolRequest=Boolean(JSON.parse(raw).tools?.length);res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":{"code":"unsupported_tools","message":"This channel does not support tool calling"}}');});});
 const c=structuredClone(defaults);c.advanced={enabled:true,url,key:'fixture',model:'fixture',stream:false};await assert.rejects(()=>new TextModel(c).complete([{role:'user',content:'test'}],signal()),/does not support tool calling/);assert.equal(toolRequest,false);
});
