import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Assistant } from '../assistant.js';
import { Store } from '../store.js';
import { RequestController } from '../requests.js';
import { voiceFixture, until } from './voice-fixture.js';

const tick = () => new Promise(r => setTimeout(r, 25));
async function rig(t: any, textEnabled = true) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-handoff-'));
    const store = new Store(folder), voice = await voiceFixture('qwen');
    const calls: { body: any; finish: (text: string) => void }[] = [], events: any[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', b => raw += b);
        req.on('end', () => calls.push({ body: JSON.parse(raw), finish: text => res.end(JSON.stringify({ choices: [{ message: { content: text } }] })) }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    store.config.low = { ...store.config.low, key: 'fixture', url: voice.url };
    store.config.high = { ...store.config.low, model: '' };
    store.config.advanced = { enabled: textEnabled, key: 'fixture', model: 'text-fixture', url: `http://127.0.0.1:${(server.address() as any).port}`, stream: false };
    const assistant = new Assistant(store, undefined, new RequestController(() => ({ origin: store.config.advanced.url, limit: 8 }), { minIntervalMs: 0 }));
    let receipt = true;
    t.after(async () => { receipt = false; assistant.stop(); voice.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await tick(); fs.rmSync(folder, { recursive: true, force: true }); });
    assistant.on('event', e => { events.push(e); if (e.type === 'audioEnd' && receipt) setImmediate(() => assistant.finishPlayback(e.playbackId, 'heard', 200, 200)); });
    voice.server.on('connection', ws => {
        const c = voice.connections.at(-1)!;
        ws.on('message', raw => { if (JSON.parse(String(raw)).type === 'response.create' && c.role === 'speaker') c.respond(); });
    });
    await assistant.start();
    const gate = voice.connections[0];
    const decide = (action: string, utterance: string, extra = {}) => gate.respond(JSON.stringify({ action, utterance, ...extra }));
    const speakers = () => voice.connections.filter(c => c.role === 'speaker');
    const launch = async () => { decide('delegate', '分析长期费用'); await until(() => calls.length === 1); await until(() => !assistant.outputActive); };
    return { assistant, store, voice, calls, events, gate, decide, speakers, launch, receipt: (v: boolean) => receipt = v };
}

test('a ready text result waits for foreground generation and its actual playback receipt', async t => {
    const r = await rig(t); await r.launch();
    r.decide('answer', '等着的时候聊两句');
    await until(() => r.voice.connections.some(c => c.role === 'reply' && c.messages.some(m => m.type === 'response.create')));
    const reply = r.voice.connections.find(c => c.role === 'reply')!, before = r.speakers().length;
    r.calls[0].finish('最终费用是三十六元。');
    await until(() => r.store.session.tasks[0].status === 'done'); await tick();
    assert.equal(r.speakers().length, before);
    r.receipt(false); reply.respond('我在，你平时喜欢聊什么？');
    await until(() => r.events.some(e => e.type === 'audioEnd' && r.store.session.turns.find(t => t.id === e.turnId)?.lane === '轻量语音'));
    assert.equal(r.speakers().length, before);
    const end = r.events.filter(e => e.type === 'audioEnd').at(-1);
    r.receipt(true); r.assistant.finishPlayback(end.playbackId, 'heard', 200, 200);
    await until(() => r.store.session.turns.some(t => t.text === '最终费用是三十六元。' && t.delivery === 'heard'));
    assert.equal(r.calls.length, 1);
});

for (const action of ['ignore', 'cancel']) test(`speech ending cannot release a ready result before the ${action} decision`, async t => {
    const r = await rig(t); await r.launch(); const before = r.speakers().length;
    r.gate.send({ type: 'input_audio_buffer.speech_started' });
    r.gate.send({ type: 'input_audio_buffer.speech_stopped' }); await tick();
    r.calls[0].finish('判断期间返回的结果');
    await until(() => r.store.session.tasks[0].status === 'done'); await tick();
    assert.equal(r.speakers().length, before);
    r.decide(action, action === 'ignore' ? '' : '不用回答了');
    if (action === 'ignore') await until(() => r.store.session.turns.some(t => t.text === '判断期间返回的结果' && t.delivery === 'heard'));
    else { await until(() => r.store.session.turns.some(t => t.lane === '任务取消' && t.delivery === 'heard')); assert.equal(r.store.session.turns.some(t => t.text === '判断期间返回的结果'), false); }
    assert.equal(r.calls.length, 1);
});

test('a high conversation keeps native input and high speech while one text model owns reasoning', async t => {
    const r = await rig(t);
    r.store.config.high = { ...r.store.config.low, model: 'high-fixture' };
    await r.assistant.switchHigh(); await until(()=>r.assistant.receiver==='high');
    const highGate=r.voice.connections.filter(c=>c.role==='gate').at(-1)!;
    highGate.respond(JSON.stringify({action:'delegate',utterance:'分析长期费用'}));
    await until(()=>r.calls.length===1); await until(()=>!r.assistant.outputActive);
    highGate.respond(JSON.stringify({action:'answer',utterance:'那就陪我聊会儿'}));
    await until(()=>r.voice.connections.some(c=>c.role==='high'&&c.messages.some(m=>m.type==='response.create')));
    const c=r.voice.connections.find(c=>c.role==='high')!;
    assert.match(c.messages.find(m=>m.type==='session.update').session.instructions,/不重算该问题/);
    c.respond('我在，我们先聊聊。'); await until(()=>!r.assistant.outputActive);
    assert.equal(r.assistant.receiver,'high'); assert.equal(r.calls.length,1);
    r.calls[0].finish('分析完成'); await until(()=>r.store.session.turns.some(t=>t.text==='分析完成'&&t.delivery==='heard'));
    const speaker=r.speakers().at(-1)!; assert.match(speaker.url,/model=high-fixture/);
});

test('text disabled: low first response precedes native high takeover without a text call', async t => {
    const r=await rig(t,false);r.store.config.high={...r.store.config.low,model:'high-fixture'};
    r.decide('delegate','分析这个复杂问题');
    await until(()=>r.voice.connections.some(c=>c.role==='reply'&&c.messages.some(m=>m.type==='response.create')));
    assert.equal(r.assistant.receiver,'low');r.voice.connections.find(c=>c.role==='reply')!.respond('我来看看这个问题。');
    await until(()=>r.assistant.receiver==='high');
    await until(()=>r.voice.connections.some(c=>c.role==='high'&&c.messages.some(m=>m.type==='response.create')));
    assert.equal(r.calls.length,0);r.voice.connections.find(c=>c.role==='high')!.respond('高级语音给出分析');
    await until(()=>r.store.session.turns.some(t=>t.lane==='高级语音'&&t.delivery==='heard'));
    assert.equal(r.assistant.mode,'high');
});

test('revising a running task aborts the old request; late results cannot speak or erase the replacement', async t => {
    const r = await rig(t); await r.launch(); const old = r.store.session.tasks[0];
    r.decide('delegate', '改成二十个小时', { replaceTaskId: old.id });
    await until(() => r.calls.length === 2);
    assert.equal(old.status, 'cancelled');
    assert.match(JSON.stringify(r.calls[1].body), /原问题：分析长期费用/);
    assert.match(JSON.stringify(r.calls[1].body), /补充条件：改成二十个小时/);
    r.calls[0].finish('已经过期的旧结果'); await tick();
    assert.equal(r.assistant.advancedStatus.state, 'running');
    r.calls[1].finish('修订后的新结果');
    await until(() => r.store.session.turns.some(t => t.text === '修订后的新结果' && t.delivery === 'heard'));
    assert.equal(r.store.session.turns.some(t => t.text === '已经过期的旧结果'), false);
    assert.equal(r.calls.length, 2);
});

test('task replay selects the actual result even when an old bridge carries the same task identifier', async t => {
    const r = await rig(t); await r.launch(); const task = r.store.session.tasks[0];
    // Imported sessions may contain the pre-fix task marker on the initial bridge.
    r.store.session.turns.find(t => t.lane === '对话衔接')!.taskId = task.id;
    r.calls[0].finish('应当重播的最终结果');
    await until(() => r.store.session.turns.some(t => t.text === task.result && t.delivery === 'heard'));
    r.assistant.stop(); const before = r.speakers().length;
    r.assistant.speakTask(task.id);
    await until(() => r.speakers().length > before);
    await until(() => r.speakers().at(-1)!.messages.some(m => m.type === 'conversation.item.create'));
    assert.equal(r.speakers().at(-1)!.messages.find(m => m.type === 'conversation.item.create').item.content[0].text, task.result);
    await until(() => r.store.session.turns.some(t => t.text === task.result && t.delivery === 'heard'));
    assert.equal(r.calls.length, 1);
});

test('a late duplicate playback receipt cannot change a completed answer to unheard', async t => {
    const r = await rig(t);
    r.decide('answer', '你好');
    await until(() => r.voice.connections.some(c => c.role === 'reply' && c.messages.some(m => m.type === 'response.create')));
    r.voice.connections.find(c => c.role === 'reply')!.respond('你好，我在。');
    await until(() => r.store.session.turns.some(t => t.text === '你好，我在。' && t.delivery === 'heard'));
    const end = r.events.filter(e => e.type === 'audioEnd').at(-1)!;
    r.assistant.finishPlayback(end.playbackId, 'unheard', 0, 0);
    assert.equal(r.store.session.turns.find(t => t.id === end.turnId)?.delivery, 'heard');
    assert.equal(r.assistant.outputActive, false);
});
