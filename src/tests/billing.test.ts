import test from 'node:test';
import assert from 'node:assert/strict';
import { BillingMeter } from '../billing.js';
import { defaults, validateConfig } from '../store.js';
const voiceUsage={input_tokens:1000,output_tokens:200,input_tokens_details:{text_tokens:100,audio_tokens:900},output_tokens_details:{text_tokens:20,audio_tokens:180}};
test('three independent rate tables and high-voice speaker routing price actual reported modalities',()=>{
  const c=structuredClone(defaults);c.prices={textInput:1,audioInput:10,textOutput:2,audioOutput:20};
  c.highPrices={textInput:3,audioInput:30,textOutput:4,audioOutput:40};c.advancedPrices={input:27,output:107};
  const b=new BillingMeter();b.record({role:'gate',model:'same-model',usage:voiceUsage},c);b.record({role:'speaker',model:'same-model',usage:voiceUsage},c);
  b.record({role:'speaker',model:'same-model',priceGroup:'high',usage:voiceUsage},c);
  b.record({role:'advanced',model:'text-model',usage:{prompt_tokens:1000,completion_tokens:100}},c);
  const s=b.snapshot();assert.equal(s.rows.length,3);assert.equal(s.incomplete,false);assert.equal(s.totalTokens,4700);
  assert.ok(Math.abs(s.rows.find(r=>r.group==='low')!.cost-.02548)<1e-12);
  assert.ok(Math.abs(s.rows.find(r=>r.group==='high')!.cost-.03458)<1e-12);
  assert.ok(Math.abs(s.rows.find(r=>r.group==='advanced')!.cost-.0377)<1e-12);
});
test('blank rates are unpriced, explicit zero rates are free, and unused models add no costs',()=>{
  const c=structuredClone(defaults),b=new BillingMeter();b.record({role:'advanced',usage:{prompt_tokens:100,completion_tokens:10}},c);
  assert.equal(b.snapshot().incomplete,true);assert.equal(b.snapshot().rows[0].unpricedTokens,110);
  b.reset();c.advancedPrices={input:0,output:0};b.record({role:'advanced',usage:{prompt_tokens:100,completion_tokens:10}},c);
  assert.equal(b.snapshot().incomplete,false);assert.equal(b.snapshot().knownCost,0);assert.equal(b.snapshot().rows.length,1);
});
test('voice totals without modality breakdown and absent usage never masquerade as zero-cost complete billing',()=>{
  const c=structuredClone(defaults);c.prices={textInput:1,audioInput:10,textOutput:2,audioOutput:20};
  const b=new BillingMeter();b.record({role:'gate',usage:{input_tokens:1000,output_tokens:30}},c);
  assert.equal(b.snapshot().incomplete,true);assert.equal(b.snapshot().rows[0].unclassifiedTokens,1030);assert.equal(b.snapshot().knownCost,0);
  b.record({role:'gate',usage:{total_tokens:45}},c);assert.equal(b.snapshot().totalTokens,1075);
  b.record({role:'advanced',usage:{}},c);assert.ok(b.snapshot().rows[1].missingUsageReports>0);
});
test('legacy rates migrate to the low slot only; new slot prices and explicit zero survive validation',()=>{
  const legacy:any=structuredClone(defaults);delete legacy.pricingVersion;delete legacy.highPrices;delete legacy.advancedPrices;
  legacy.prices={textInput:0,audioInput:27,textOutput:0,audioOutput:107};const c=validateConfig(legacy);
  assert.equal(c.prices.audioInput,27);assert.equal(c.prices.audioOutput,107);assert.equal(c.prices.textInput,null);assert.equal(c.highPrices.audioInput,null);assert.equal(c.advancedPrices.input,null);
  assert.equal(validateConfig({...defaults,advancedPrices:{input:0,output:0}}).advancedPrices.input,0);
  assert.throws(()=>validateConfig({...defaults,highPrices:{...defaults.highPrices,audioInput:-1}}),/价格/);
});
