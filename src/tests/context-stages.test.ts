import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {EventEmitter} from 'node:events';import {Assistant} from '../assistant.js';import {Store} from '../store.js';import {buildContext,gateContext,parseIntervention} from '../context.js';
import {voiceFixture,until} from './voice-fixture.js';import {voicePresets} from '../voice-config.js';import type {VoiceProvider} from '../types.js';
function store(t:any){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-stages-'));const s=new Store(dir);t.after(()=>{(s as any).cleanup?.();fs.rmSync(dir,{recursive:true,force:true});});return s;}
test('history on disk and in model packets contains only role, at and text; native completion and replay do not duplicate entries',t=>{
  const s=store(t);const u=s.addTurn('user','短问题','lane'),v=s.addTurn('assistant','','native','generated');v.text='最终文字';s.saveSession();s.delivery(v.id,'heard',100,100);s.delivery(v.id,'heard',100,100);
  const rows=fs.readdirSync(s.file('history')).flatMap(f=>fs.readFileSync(s.file('history/'+f),'utf8').trim().split('\n').map(x=>JSON.parse(x)));assert.equal(rows.length,2);for(const r of rows)assert.deepEqual(Object.keys(r).sort(),['at','role','text']);
  const p=buildContext(s.config,'唯一固定规则',[],s.session,'新问题','test');const data=JSON.parse(p.text);assert.equal(p.chars,p.text.length+'唯一固定规则'.length);assert.doesNotMatch(p.text,/唯一固定规则|delivery|heardMs|durationMs|lane|taskId/);for(const r of data.recent)assert.deepEqual(Object.keys(r).sort(),['at','role','text']);assert.equal(data.recent[0].text,u.text);
});
test('legacy history migrates with backup and malformed archive is preserved',t=>{
  const s=store(t);fs.writeFileSync(s.file('history/old.jsonl'),JSON.stringify({id:'x',role:'user',at:'then',text:'原话',lane:'old'})+'\n'+JSON.stringify({kind:'delivery',id:'x',heardMs:12})+'\n');fs.writeFileSync(s.file('history/broken.jsonl'),'{broken');
  new Store(s.folder);assert.deepEqual(JSON.parse(fs.readFileSync(s.file('history/old.jsonl'),'utf8')),{role:'user',at:'then',text:'原话'});assert.ok(fs.existsSync(s.file('history/old.jsonl.legacy.bak')));assert.equal(fs.readFileSync(s.file('history/broken.jsonl'),'utf8'),'{broken');
});
test('long history produces a bounded digest plus recent exact turns with no summarizer API',t=>{
  const s=store(t);for(let i=0;i<135;i++)s.addTurn('user',`条件${i} `+'资料'.repeat(40),'test');assert.ok(s.session.summary);const p=buildContext({...s.config,contextChars:4000},'规则',[],s.session,'新问题','test');assert.ok(p.chars<=4000);assert.match(p.summary,/较早对话摘录/);assert.equal(p.turns.at(-1)?.text,s.session.turns.at(-1)?.text);assert.ok(p.turns.length<=s.config.recentTurns);assert.ok(p.summary.length<2800);
  s.session.summary='旧摘要';s.session.summaryThrough=s.session.turns[100].id;const q=buildContext(s.config,'规则',[],s.session,'新问题','test');assert.ok(q.turns.every(t=>Date.parse(t.at)>=Date.parse(s.session.turns[100].at)));assert.doesNotMatch(q.text,/"text":"条件0 /);
});

test('handoff trims optional context as whole JSON while preserving turn identity and partial delivery', async () => {
    const { handoffText } = await import('../context.js');
    const info={version:9,interaction:4,answers:[{text:'generated answer',delivery:'partial',note:'部分播放，具体边界未知'}]};
    const packet={text:JSON.stringify({recent:Array.from({length:20},()=>({role:'user',text:'x'.repeat(500)})),memory:['y'.repeat(1000)],summary:'z'.repeat(1000)}),instructions:'behavior'} as any;
    const raw=handoffText(info,packet,1000);assert.ok(raw.length<=1000);const value=JSON.parse(raw);assert.equal(value.version,9);assert.equal(value.answers[0].delivery,'partial');assert.equal(value.context.instructions,'behavior');
});
