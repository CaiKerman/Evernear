import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmPlayer, type Delivery } from '../playback.js';

const tick=()=>new Promise(r=>setTimeout(r,0));
const pcm=btoa('\x00\x20'.repeat(2400));
class FakeContext {
  state='running';currentTime=0;destination={};onstatechange?:()=>void;
  sinks:string[]=[];sources:any[]=[];resumeCount=0;
  resume=async()=>{this.resumeCount++;this.state='running';};
  async close(){this.state='closed';}
  async setSinkId(id:string){this.sinks.push(id);}
  createBuffer(_channels:number,length:number,rate:number){return {duration:length/rate,copyToChannel(){}};}
  createBufferSource(){const source={buffer:null as any,onended:null as any,started:false,connect(){},disconnect(){},start(){this.started=true;},stop(){}};this.sources.push(source);return source;}
}
function setup(timeout=50){
  const ctx=new FakeContext(),deliveries:Delivery[]=[],errors:unknown[]=[];let sink='speaker-1';
  const player=new PcmPlayer(()=>sink,p=>deliveries.push(p),e=>errors.push(e),()=>ctx as any,timeout);
  return {ctx,deliveries,errors,player,setSink:(id:string)=>sink=id};
}
test('output device changes once; streamed chunks finish only after audio ends',async()=>{
  const {ctx,player,deliveries,setSink}=setup();
  player.enqueue({turnId:'one',audio:pcm});player.enqueue({turnId:'one',audio:pcm});player.end('one');await tick();
  assert.deepEqual(ctx.sinks,['speaker-1']);assert.equal(deliveries.length,0);
  ctx.sources[0].onended();assert.equal(deliveries.length,0);ctx.sources[1].onended();assert.equal(deliveries[0].delivery,'heard');assert.equal(deliveries[0].durationMs,200);
  setSink('');await player.prepare();assert.deepEqual(ctx.sinks,['speaker-1','']);
});
test('background suspension resumes an already queued answer',async()=>{
  const {ctx,player,deliveries}=setup();player.enqueue({turnId:'hidden',audio:pcm});player.end('hidden');await tick();
  ctx.state='suspended';ctx.onstatechange?.();await tick();
  assert.equal(ctx.resumeCount,1);assert.equal(ctx.state,'running');assert.equal(deliveries.length,0);
  ctx.sources[0].onended();assert.equal(deliveries[0].delivery,'heard');
});
test('interrupt during pending resume cannot play stale audio',async()=>{
  const {ctx,player,deliveries}=setup();ctx.state='suspended';let release!:()=>void;
  ctx.resume=()=>new Promise<void>(r=>{release=()=>{ctx.state='running';r();};});
  player.enqueue({turnId:'stale',audio:pcm});await tick();player.interrupt();release();await tick();
  assert.equal(ctx.sources.length,0);assert.equal(deliveries[0].delivery,'unheard');
  player.enqueue({turnId:'fresh',audio:pcm});player.end('fresh');await tick();
  assert.equal(ctx.sources.length,1);ctx.sources[0].onended();assert.equal(deliveries[1].delivery,'heard');
});
test('resume timeout releases queue and reports unheard instead of success',async()=>{
  const {ctx,player,deliveries,errors}=setup(10);ctx.state='suspended';ctx.resume=()=>new Promise(()=>{});
  player.enqueue({turnId:'failed',audio:pcm});player.end('failed');await new Promise(r=>setTimeout(r,30));
  assert.equal(errors.length,1);assert.equal(deliveries[0].delivery,'unheard');assert.equal(ctx.sources.length,0);
  ctx.state='running';player.enqueue({turnId:'retry',audio:pcm});player.end('retry');await tick();
  ctx.sources[0].onended();assert.equal(deliveries[1].delivery,'heard');
});
