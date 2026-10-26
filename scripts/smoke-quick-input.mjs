// Local HTTP fixture and Electron only. No cloud calls or personal credentials.
import { voiceFixture } from '../dist/tests/voice-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
const { _electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const calls = [], errors = [], checks = [];
const voice=await voiceFixture('qwen',true);
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', b => raw += b);
  req.on('end', () => { calls.push({ body: JSON.parse(raw), res }); });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evernear-quick-desktop-'));
const until = async check => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('desktop fixture timeout'); };
let app;
const delta = (i, text) => { const res = calls[i].res; if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`); };
const done = i => calls[i].res.end('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
try {
  app = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron'),
    env: { ...process.env, AMBIENT_TEST_MODE: '1', AMBIENT_TEST_REQUEST_TIMING: 'fast', AMBIENT_TEST_PERSONAL: dir },
    args: ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1280,800', '--disable-gpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', process.env.AMBIENT_TEST_ENTRY || '.'], timeout: 20000 });
  app.on('window', page => page.on('pageerror', e => errors.push(e.message)));
  await until(() => app.windows().some(p => p.url().endsWith('/index.html')) && app.windows().some(p => p.url().endsWith('/quick.html')));
  const main = app.windows().find(p => p.url().endsWith('/index.html')), quick = app.windows().find(p => p.url().endsWith('/quick.html'));
  for (const page of [main, quick]) page.on('pageerror', e => errors.push(e.message));
  await main.waitForFunction(() => window.ambient && document.querySelector('#quick-parameters').value);
  await quick.waitForFunction(() => window.quick && document.querySelector('#status').textContent.includes('无上下文'));
  await main.evaluate(async url => {
    const s = await window.ambient.invoke('snapshot'); s.config.advanced = { ...s.config.advanced, url, key: 'fixture', model: 'fixture', enabled: false, stream: true };
    s.config.quickInput.visible = true; await window.ambient.invoke('config:save', s.config);
  }, `http://127.0.0.1:${server.address().port}`);
  assert.equal(await quick.evaluate(() => typeof window.ambient), 'undefined');
  assert.equal(await quick.evaluate(() => window.quick.invoke('snapshot').then(() => false, () => true)), true);
  const levels = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), top: w.isAlwaysOnTop() })));
  assert.ok(levels.every(w => !w.top)); checks.push('separate-IPC-normal-window-level');

  await quick.locator('#input').fill('中文输入法确认');
  await quick.locator('#input').evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart'));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    el.dispatchEvent(new CompositionEvent('compositionend'));
  });
  assert.equal(calls.length, 0);
  await quick.locator('#input').press('Enter'); await until(() => calls.length === 1);
  assert.equal(calls[0].body.messages.length, 2); assert.equal(calls[0].body.messages[1].content, '中文输入法确认');
  delta(0, 'The input method'); await quick.waitForFunction(() => document.querySelector('#result').textContent === 'The input method');
  assert.equal(await quick.locator('#cancel').isVisible(), true);
  delta(0, ' confirmation.'); done(0); await quick.waitForFunction(() => document.querySelector('#result-label').textContent === '结果');
  await quick.locator('#copy').click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'The input method confirmation.');
  checks.push('IME-confirm-does-not-send-and-stream-copy');

  await quick.locator('#context').check();
  const send = async (text, result) => { const index = calls.length; await quick.locator('#input').fill(text); await quick.locator('#send').click(); await until(() => calls.length > index); delta(index, result); done(index); await quick.waitForFunction(result => document.querySelector('#result').textContent === result && document.querySelector('#result-label').textContent === '结果', result); };
  await send('one', 'ONE'); await send('two', 'TWO');
  assert.deepEqual(calls[2].body.messages.slice(1).map(m => m.content), ['one', 'ONE', 'two']);
  await quick.locator('#context').uncheck(); await send('fresh', 'FRESH'); assert.equal(calls[3].body.messages.length, 2);
  checks.push('local-context-toggle-isolation');

  await quick.locator('#input').fill('cancel this'); await quick.locator('#send').click(); await until(() => calls.length === 5); delta(4, 'partial');
  await quick.waitForFunction(() => document.querySelector('#result').textContent === 'partial');
  await quick.locator('#cancel').click(); await quick.waitForFunction(() => document.querySelector('#status').textContent.includes('取消'));
  await until(() => calls[4].res.destroyed); checks.push('cancel-aborts-HTTP');

  await quick.locator('#preset').selectOption('polish');
  await quick.locator('#settings').click(); await main.waitForFunction(() => document.querySelector('#page-settings').classList.contains('active'));
  assert.equal(await main.locator('[name="advanced.enabled"]').isChecked(), false);
  await main.locator('#quick-parameters').fill('{broken'); await main.locator('#settings-form button[type="submit"]').click();
  await main.waitForFunction(() => document.querySelector('#toast').textContent.includes('有效的 JSON'));
  // Restore valid settings; stale main-window state must not revert the quick mode.
  await main.locator('#quick-parameters').fill(JSON.stringify({ translate: { temperature: 0.2 }, polish: { temperature: 0.3 }, answer: {} }));
  await main.locator('#settings-form button[type="submit"]').click();
  await main.waitForFunction(() => document.querySelector('#toast').textContent.includes('设置已保存'));
  assert.equal((await main.evaluate(() => window.ambient.invoke('snapshot'))).config.quickInput.preset, 'polish');
  checks.push('settings-entry-JSON-errors-and-shared-config');

  await quick.locator('#hide').click();
  await until(() => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().find(w => w.getTitle().includes('快捷输入')).isVisible()));
  await main.locator('#quick-toggle').click();
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle().includes('快捷输入')).isVisible()));
  assert.equal((await main.evaluate(() => window.ambient.invoke('snapshot'))).config.quickInput.visible, true);
  checks.push('hide-show-persists-without-starting-listening');
  await main.evaluate(async url => {
    const s=await window.ambient.invoke('snapshot');s.config.low={...s.config.low,provider:'qwen',url,key:'fixture'};
    await window.ambient.invoke('config:save',s.config);
  },voice.url);
  const textCalls=calls.length;
  await quick.locator('#record').click();await quick.waitForFunction(()=>document.querySelector('#record').textContent==='结束录入');
  await until(()=>voice.audioPackets>0);
  await quick.locator('#record').click();await quick.waitForFunction(()=>document.querySelector('#input').value==='主动录入测试文本');
  assert.equal(calls.length,textCalls,'dictation must not submit text');
  const transcription=voice.connections.find(c=>c.role==='transcribe');
  assert.equal(transcription.messages.filter(m=>m.type==='response.create').length,0);
  await quick.locator('#input').fill('可编辑的转写文本');
  await quick.locator('#record').click();await quick.waitForFunction(()=>document.querySelector('#record').textContent==='结束录入');
  await main.evaluate(()=>window.ambient.invoke('stop'));
  await quick.waitForFunction(()=>document.querySelector('#record-cancel').hidden);
  assert.equal(await main.evaluate(()=>document.querySelector('#start').getAttribute('aria-pressed')),'false');
  checks.push('one-microphone-isolated-transcription-edit-and-global-pause');

  // Explicit playback works while the main listener is paused and does not add
  // translated source material to the primary conversation.
  await quick.locator('#speak').click();
  await quick.waitForFunction(()=>document.querySelector('#audio-status').textContent==='已播放');
  const generated=voice.connections.length;
  await quick.locator('#speak').click();await quick.waitForFunction(()=>document.querySelector('#audio-status').textContent==='已播放');
  assert.equal(voice.connections.length,generated,'same result reuses generated PCM');
  checks.push('manual-audio-receipt-cache-and-no-main-history');
  if (process.env.AMBIENT_TEST_SCREENSHOT) await quick.screenshot({ path: process.env.AMBIENT_TEST_SCREENSHOT });
  assert.equal((await main.evaluate(() => window.ambient.invoke('snapshot'))).session.turns.length, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, rendererErrors: errors.length, textCalls: calls.length, platform: process.platform, windowsTaskbarAndDefender: 'not verified' }, null, 2));
} catch (error) {
  console.error('Completed checks:', checks, 'Renderer errors:', errors);
  if (app) for (const page of app.windows()) if (page.url().endsWith('/quick.html')) {
    console.error(await page.evaluate(() => ({ innerWidth, innerHeight, copy: document.querySelector('#copy')?.getBoundingClientRect().toJSON(), panel: document.querySelector('#result-panel')?.getBoundingClientRect().toJSON(), scroll: [scrollX, scrollY] })));
    await page.screenshot({ path: path.join(os.tmpdir(), 'evernear-quick-failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await app?.close(); voice.close(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true });
}
