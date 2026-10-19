// Desktop smoke: every vendor appears in both slots. No real cloud calls.
import assert from 'node:assert/strict';import path from 'node:path';import fs from 'node:fs';import os from 'node:os';
import { voiceFixture, until } from '../dist/tests/voice-fixture.js';
const {_electron}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixtures=Object.fromEntries(await Promise.all(['qwen','openai','gemini','doubao'].map(async p=>[p,await voiceFixture(p,true)])));
const personal=fs.mkdtempSync(path.join(os.tmpdir(),'ambient-desktop-matrix-')),errors=[],checks=[];let app;
try{
 app=await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),env:{...process.env,AMBIENT_TEST_MODE:'1',AMBIENT_TEST_REQUEST_TIMING:'fast',AMBIENT_TEST_PERSONAL:personal},args:['--no-sandbox','--ozone-platform=headless','--disable-gpu','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--mute-audio',process.env.AMBIENT_TEST_ENTRY||'.'],timeout:20000});
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1180,height:820});await page.waitForFunction(()=>window.ambient);
 for(const [low,high] of [['qwen','openai'],['openai','gemini'],['gemini','doubao'],['doubao','qwen']]){
   await page.locator('[data-page="settings"]').click();await page.evaluate(()=>document.querySelector('[name="high.model"]').closest('details').open=true);
   for(const [lane,p] of [['low',low],['high',high]]){
     await page.locator(`[name="${lane}.provider"]`).selectOption(p);
     assert.equal(await page.locator(`[name="${lane}.key"]`).inputValue(),'');
     await page.locator(`[name="${lane}.url"]`).fill(fixtures[p].url);await page.locator(`[name="${lane}.key"]`).fill(lane+'-fixture-key');await page.locator(`[name="${lane}.model"]`).fill(p==='doubao'?'1.2.1.1':'fixture-'+lane);
     if(p==='doubao'){assert.ok(await page.locator(`[name="${lane}.appId"]`).isVisible());await page.locator(`[name="${lane}.appId"]`).fill('fixture-app');}
   }
   const before=Object.values(fixtures).reduce((n,f)=>n+f.audioPackets,0);
   for(const id of ['test-voice','test-high-voice']){await page.locator('#'+id).click();await page.waitForFunction(id=>!document.querySelector('#'+id).disabled,id);assert.match(await page.locator('#toast').textContent(),/会话配置成功/);}
   assert.equal(Object.values(fixtures).reduce((n,f)=>n+f.audioPackets,0),before);
   await page.locator('#settings-form button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('设置已保存'));
   const saved=JSON.parse(fs.readFileSync(path.join(personal,'config.json'),'utf8'));assert.equal(saved.low.provider,low);assert.equal(saved.high.provider,high);assert.equal(saved.low.key,'low-fixture-key');assert.equal(saved.high.key,'high-fixture-key');
   await page.locator('[data-page="conversation"]').click();await page.locator('#start').click();await page.waitForFunction(()=>document.querySelector('#status-label').textContent.includes('音频上传中'));
   const send=async text=>{const count=await page.locator('.message.assistant').count();await page.locator('#message').fill(text);await page.locator('#send').click();await page.waitForFunction(count=>document.querySelectorAll('.message.assistant').length>count,count);await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message.assistant .delivery')).at(-1)?.textContent==='已播报',null,{timeout:10000});};
   await send('本地轻量问题');await page.locator('#switch-high').click();await page.waitForFunction(()=>document.querySelector('#mode-badge').textContent==='高级语音优先');const highPackets=fixtures[high].audioPackets,lowPackets=fixtures[low].audioPackets;await send('本地高级问题');assert.equal(fixtures[high].audioPackets,highPackets,'high must receive approved text only');assert.ok(fixtures[low].audioPackets>lowPackets,'low gate must continue to receive microphone audio');
   await page.locator('#back-ambient').click();await page.waitForFunction(()=>document.querySelector('#mode-badge').textContent==='轻量语音优先');await page.locator('#pause-header').click();
   checks.push({low,high,highRawMicrophonePackets:fixtures[high].audioPackets-highPackets,lowAudio:fixtures[low].audioPackets,highAudio:fixtures[high].audioPackets});
 }
 await page.locator('[data-page="settings"]').click();await page.locator('[name="high.provider"]').selectOption('inherit');assert.equal(await page.locator('[name="high.url"]').inputValue(),'');assert.equal(await page.locator('[name="high.key"]').inputValue(),'');assert.equal(await page.locator('[name="high.model"]').inputValue(),'');await page.locator('#settings-form button[type="submit"]').click();
 await page.locator('[name="low.provider"]').selectOption('gemini');assert.equal(await page.locator('[name="low.key"]').inputValue(),'');assert.ok(!(await page.locator('#voice-preset').isVisible()));assert.ok(!(await page.locator('[name="high.appId"]').isVisible()));
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.resolve('../ui-providers.png')});await page.setViewportSize({width:760,height:590});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.resolve('../ui-providers-compact.png')});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,rendererErrors:errors.length,tests:['two-independent-provider-selectors','both-connection-checks-no-mic','four-vendors-both-modes','native-PCM-playback-receipts','persistent-low-gate-approved-high-input','return-low','credential-clear-on-vendor-change','inheritance-reset','conditional-doubao-fields','no-horizontal-overflow-760']},null,2));
}catch(e){if(app){const p=await app.firstWindow();console.log(JSON.stringify({error:String(e),toast:await p.locator('#toast').textContent(),errors}));await p.screenshot({path:path.resolve('../ui-matrix-failure.png')});}throw e;}
finally{await app?.close();for(const f of Object.values(fixtures))f.close();fs.rmSync(personal,{recursive:true,force:true});}
