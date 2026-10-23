import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Store, validateConfig, defaults } from '../store.js';
import { QuickInput } from '../quick-input.js';
import { RequestController } from '../requests.js';
import { TextWork } from '../text-work.js';
import { Assistant } from '../assistant.js';

async function until(check: () => boolean) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('fixture timeout'); }
async function fixture(t: { after: (fn: () => unknown) => void }) {
    const calls: { body: any; res: http.ServerResponse }[] = [];
    const server = http.createServer((req, res) => { let raw = ''; req.on('data', b => raw += b); req.on('end', () => calls.push({ body: JSON.parse(raw), res })); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evernear-quick-')), store = new Store(dir);
    store.saveConfig({ ...store.config, advanced: { ...store.config.advanced, enabled: false, url: `http://127.0.0.1:${(server.address() as any).port}`, key: 'fixture-secret', model: 'fixture', stream: true } });
    store.saveText('memory.md', 'PRIVATE_MEMORY'); store.saveText('instructions.md', 'PRIVATE_INSTRUCTIONS');
    store.addTurn('user', 'PRIVATE_HISTORY', 'test'); store.session.summary = 'PRIVATE_SUMMARY'; store.saveSession();
    const requests = new RequestController(() => ({ origin: store.config.advanced.url, limit: 120 }), { minIntervalMs: 0, windowMs: 1, cooldownMs: 1 });
    const assistant = new Assistant(store, () => { throw new Error('quick input must not create voice sessions'); }, requests);
    const usage: any[] = [], quick = new QuickInput(store, assistant.textWork, requests, record => usage.push(record));
    const settings = (patch: any) => { const before = store.config; store.saveConfig({ ...before, quickInput: { ...before.quickInput, ...patch } }); quick.settingsChanged(before); };
    const delta = (i: number, text: string) => { const res = calls[i].res; if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`); };
    const done = (i: number, reason = 'stop') => calls[i].res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    const send = async (text: string, result: string) => { const i = calls.length, promise = quick.send(text); await until(() => calls.length > i); delta(i, result); done(i); await promise; };
    t.after(() => { quick.cancel(); assistant.stop(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { calls, store, requests, assistant, quick, usage, settings, delta, done, send, dir };
}

test('old configs gain independent quick defaults and reserved request fields are rejected', () => {
    const legacy = structuredClone(defaults) as any; delete legacy.quickInput;
    const migrated = validateConfig(legacy); assert.equal(migrated.quickInput.context, false); assert.equal(migrated.quickInput.visible, false);
    for (const parameters of [[], null, { messages: [] }, { model: 'other' }, { stream: false }, { tools: [] }, { n: 2 }, { audio: {} }]) {
        assert.throws(() => validateConfig({ ...migrated, quickInput: { ...migrated.quickInput, parameters: { translate: parameters } } }));
    }
    assert.equal(defaults.quickInput.context, false);
});

test('text-only quick request streams before completion, never reads personal context or creates voice', async t => {
    const f = await fixture(t), promise = f.quick.send('你好');
    await until(() => f.calls.length === 1);
    assert.equal(f.assistant.textWork.source, '快捷输入');
    const body = f.calls[0].body;
    assert.equal(body.messages.length, 2); assert.equal(body.messages[1].content, '你好');
    assert.ok(!JSON.stringify(body).includes('PRIVATE_')); assert.equal(body.temperature, 0.2); assert.equal(body.stream, true);
    f.delta(0, 'Hello'); await until(() => f.quick.snapshot().result === 'Hello');
    assert.equal(f.quick.snapshot().status, 'running'); assert.notEqual(f.quick.snapshot().firstMs, null);
    f.done(0); await promise;
    assert.equal(f.quick.snapshot().status, 'done'); assert.equal(f.quick.snapshot().historyTurns, 0); assert.equal(f.usage.length, 1);
    assert.equal(f.assistant.running, false); assert.equal(f.store.session.turns.length, 1); assert.equal(f.assistant.textWork.source, undefined);
    assert.ok(!fs.readFileSync(f.store.file('session.json'), 'utf8').includes('Hello'));
});

test('split UTF-8 and CRLF event boundaries preserve exact streamed text', async t => {
    const f = await fixture(t), promise = f.quick.send('hello'); await until(() => f.calls.length === 1);
    const res = f.calls[0].res; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    for (const byte of bytes) res.write(Buffer.from([byte])); res.end(); await promise;
    assert.equal(f.quick.snapshot().result, '你好'); assert.equal(f.quick.snapshot().status, 'done');
});

test('JSON response fallback finishes normally without requiring voice or automatic delegation', async t => {
    const f = await fixture(t); f.store.saveConfig({ ...f.store.config, advanced: { ...f.store.config.advanced, stream: false } });
    const pending = f.quick.send('plain'); await until(() => f.calls.length === 1);
    assert.equal(f.calls[0].body.stream, false); assert.equal(f.calls[0].body.stream_options, undefined);
    f.calls[0].res.writeHead(200, { 'Content-Type': 'application/json' }); f.calls[0].res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Plain reply' } }] }));
    await pending; assert.equal(f.quick.snapshot().status, 'done'); assert.equal(f.quick.snapshot().result, 'Plain reply');
});

test('missing text credentials produce an actionable error and no request', async t => {
    const f = await fixture(t); f.store.saveConfig({ ...f.store.config, advanced: { ...f.store.config.advanced, key: '' } });
    await f.quick.send('unconfigured'); assert.match(f.quick.snapshot().error, /缺少API Key/); assert.equal(f.calls.length, 0);
});



test('cancelled partial result cannot contaminate the next turn', async t => {
    const f = await fixture(t); f.settings({ context: true });
    const pending = f.quick.send('cancel me'); await until(() => f.calls.length === 1); f.delta(0, 'partial'); await until(() => f.quick.snapshot().result === 'partial');
    f.quick.cancel(); await pending; assert.equal(f.quick.snapshot().status, 'cancelled'); assert.equal(f.quick.snapshot().historyTurns, 0);
    f.done(0); await f.send('next', 'complete'); assert.equal(f.calls[1].body.messages.length, 2); assert.equal(f.quick.snapshot().result, 'complete');
});

test('provider rejects parameters once, with no automatic parameter deletion or retry', async t => {
    const f = await fixture(t); f.settings({ parameters: { ...f.store.config.quickInput.parameters, translate: { vendor_option: false } } });
    const pending = f.quick.send('hello'); await until(() => f.calls.length === 1);
    f.calls[0].res.writeHead(400, { 'Content-Type': 'application/json' }); f.calls[0].res.end(JSON.stringify({ error: { message: 'unsupported vendor_option' } })); await pending;
    assert.equal(f.quick.snapshot().status, 'error'); assert.match(f.quick.snapshot().error, /vendor_option/); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.vendor_option, false); assert.equal(f.quick.snapshot().historyTurns, 0);
});

test('truncated stream and token-limit termination remain incomplete and outside context', async t => {
    const f = await fixture(t); f.settings({ context: true });
    for (const reason of ['disconnected', 'length']) {
        const i = f.calls.length, pending = f.quick.send(reason); await until(() => f.calls.length > i); f.delta(i, 'unfinished');
        if (reason === 'length') f.done(i, 'length'); else f.calls[i].res.end();
        await pending; assert.equal(f.quick.snapshot().status, 'error'); assert.equal(f.quick.snapshot().historyTurns, 0);
    }
});

test('quick input and existing assistant helpers share one occupied text slot in both directions', async t => {
    const f = await fixture(t), owner = new AbortController(), release = f.assistant.textWork.claim('语音委托', owner);
    await assert.rejects(f.quick.send('busy'), /文字任务忙：语音委托/); assert.equal(f.calls.length, 0); release();
    const pending = f.quick.send('held'); await until(() => f.calls.length === 1);
    f.store.saveConfig({ ...f.store.config, advanced: { ...f.store.config.advanced, enabled: true }, recentTurns: 2 });
    f.store.addTurn('user', 'older 1', 'test'); f.store.addTurn('assistant', 'older 2', 'test');
    await assert.rejects(f.assistant.organize(), /文字任务忙：快捷输入/);
    const notices: any[] = []; f.assistant.on('event', e => notices.push(e));
    assert.equal((f.assistant as any).startTask('another problem'), false); assert.ok(notices.some(e => e.message?.includes('文字任务忙：快捷输入')));
    assert.equal(f.calls.length, 1); f.delta(0, 'done'); f.done(0); await pending;
});

test('late cleanup of cancelled text work cannot release newer ownership', () => {
    const work = new TextWork(), first = new AbortController(), releaseOld = work.claim('old', first);
    work.cancel(); const second = new AbortController(), releaseNew = work.claim('new', second); releaseOld();
    assert.equal(work.source, 'new'); assert.throws(() => work.claim('third', new AbortController()), /new/); releaseNew(); assert.equal(work.source, undefined);
});


test('quick requests report rate protection immediately instead of waiting or scheduling', async () => {
    const requests = new RequestController(() => ({ origin: '', limit: 1 }), { minIntervalMs: 60000 });
    const info = { url: 'http://127.0.0.1', model: 'fixture', source: 'quick-input', channel: 'advanced' as const };
    await requests.run(info, new AbortController().signal, async () => 'ok', true);
    let sent = false;
    await assert.rejects(requests.run(info, new AbortController().signal, async () => sent = true, true), /本地请求保护/);
    assert.equal(sent, false);
});
