import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { normalizeChatURL,normalizeRealtimeURL } from '../endpoints.js';
import { TextModel,readChatStream,voiceURL } from '../providers.js';
import { defaults,validateConfig } from '../store.js';

test('official Qianwen Base URL expands to a completion path without duplicate suffixes',()=>{
  for(const value of ['https://maas.qianwenaiapi.com/compatible-mode/v1','https://maas.qianwenaiapi.com/compatible-mode/v1/','https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'])
    assert.equal(normalizeChatURL(value),'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions');
  assert.equal(normalizeChatURL('https://example.test/v1'),'https://example.test/v1/chat/completions');
  assert.equal(normalizeChatURL('http://127.0.0.1:1234/custom-path'),'http://127.0.0.1:1234/custom-path');
});
test('Qianwen unified realtime endpoint needs no workspace and only known HTTP hosts are translated',()=>{
  assert.equal(normalizeRealtimeURL('https://maas.qianwenaiapi.com/compatible-mode/v1'),'wss://maas.qianwenaiapi.com/api-ws/v1/realtime');
  assert.equal(normalizeRealtimeURL('https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'),'wss://maas.qianwenaiapi.com/api-ws/v1/realtime');
  assert.equal(normalizeRealtimeURL('wss://maas.qianwenaiapi.com'),'wss://maas.qianwenaiapi.com/api-ws/v1/realtime');
  assert.equal(normalizeRealtimeURL('https://my-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),'wss://my-space.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime');
  assert.throws(()=>normalizeRealtimeURL('https://unrelated.test/v1'),/不能自动转换/);
  assert.throws(()=>normalizeRealtimeURL('wss://{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime'),/尚未填写/);
});
test('text-only Omni model is rejected in realtime lane with an actionable message',()=>{
  assert.throws(()=>voiceURL({...defaults.low,key:'fixture',model:'qwen3.8-omni-flash'}),/仅输出文本/);
  assert.equal(new URL(voiceURL({...defaults.low,key:'fixture'})).searchParams.get('model'),'qwen3.8-omni-flash-realtime');
  const c=validateConfig({...defaults,low:{...defaults.low,url:'https://maas.qianwenaiapi.com/compatible-mode/v1'}});
  assert.equal(c.low.url,'wss://maas.qianwenaiapi.com/api-ws/v1/realtime');assert.equal(c.advanced.stream,true);
});
async function* bytes(text:string){const all=new TextEncoder().encode(text);for(let i=0;i<all.length;i++)yield all.slice(i,i+1);}
test('SSE aggregation handles UTF-8 and CRLF split at every byte plus usage-only final frame',async()=>{
  const stream='data: '+JSON.stringify({choices:[{index:0,delta:{content:'连接'}}]})+'\r\n\r\n'+'data: '+JSON.stringify({choices:[{index:0,delta:{content:'成功。'},finish_reason:'stop'}]})+'\r\n\r\n'+'data: '+JSON.stringify({choices:[],usage:{total_tokens:17}})+'\r\n\r\n'+'data: [DONE]\r\n\r\n';
  const r=await readChatStream(bytes(stream),new AbortController().signal);assert.equal(r.choices[0].message.content,'连接成功。');assert.equal(r.usage.total_tokens,17);
});
test('SSE tool argument fragments are reassembled before tool execution',async()=>{
  const frames=[{choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'calculate',arguments:'{"expression":"20/'}}]}}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'275*500"}'}}]},finish_reason:'tool_calls'}]}];
  const r=await readChatStream(bytes(frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n'),new AbortController().signal);
  const c=r.choices[0].message.tool_calls![0];assert.equal(c.id,'call_a');assert.equal(c.function.name,'calculate');assert.equal(JSON.parse(c.function.arguments).expression,'20/275*500');
});
test('SSE truncated output and API error events fail rather than masquerade as complete answers',async()=>{
  await assert.rejects(()=>readChatStream(bytes('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),new AbortController().signal),/提前中断/);
  await assert.rejects(()=>readChatStream(bytes('data: {"error":{"message":"test"}}\n\n'),new AbortController().signal),/报告错误/);
});
test('the supplied official Python example is matched by the actual HTTP request',async t=>{
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    assert.equal(req.url,'/compatible-mode/v1/chat/completions');const b=JSON.parse(body);assert.equal(b.model,'qwen3.8-omni-flash');assert.equal(b.stream,true);assert.deepEqual(b.modalities,['text']);assert.deepEqual(b.stream_options,{include_usage:true});
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'我是千问。'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{total_tokens:9}})+'\n\ndata: [DONE]\n\n');
  });});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const c=structuredClone(defaults);c.advanced={enabled:true,url:`http://127.0.0.1:${(server.address() as any).port}/compatible-mode/v1`,key:'fixture',model:'qwen3.8-omni-flash',stream:true};let tokens=0;
  const result=await new TextModel(c,r=>tokens+=r.usage.total_tokens).complete([{role:'user',content:'你是谁？'}],new AbortController().signal);
  assert.equal(result,'我是千问。');assert.equal(tokens,9);
});
