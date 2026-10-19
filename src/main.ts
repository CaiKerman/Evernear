import { RequestController } from './requests.js';
import { app, BrowserWindow, ipcMain, shell, dialog, session, Tray, Menu, nativeImage, globalShortcut, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, validateConfig } from './store.js';
import { Assistant } from './assistant.js';
import { safeError, TextModel } from './providers.js';
import { createVoice } from './voice/index.js';
import { resolveVoiceConfig } from './voice-config.js';

// Audio and microphone work must continue when the only window is minimized.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let audioBlocker:number|undefined;
function keepAudioActive(active:boolean){
  if(active&&audioBlocker===undefined)audioBlocker=powerSaveBlocker.start('prevent-app-suspension');
  if(!active&&audioBlocker!==undefined){powerSaveBlocker.stop(audioBlocker);audioBlocker=undefined;}
}

const base=app.isPackaged?path.dirname(process.execPath):fileURLToPath(new URL('../',import.meta.url));
const personal=process.env.AMBIENT_TEST_MODE==='1'&&process.env.AMBIENT_TEST_PERSONAL?process.env.AMBIENT_TEST_PERSONAL:path.join(base,'personal');fs.mkdirSync(path.join(personal,'.runtime'),{recursive:true});
app.setPath('userData',path.join(personal,'.runtime'));app.setPath('sessionData',path.join(personal,'.runtime'));
let window:BrowserWindow|undefined,assistant:Assistant,store:Store,tray:Tray|undefined,quitting=false;
const gotLock=process.env.AMBIENT_TEST_MODE==='1'||app.requestSingleInstanceLock();if(!gotLock)app.quit();
function show(){window?.show();window?.focus();}
const on=(name:string,handler:(...args:any[])=>unknown)=>ipcMain.handle(name,(e,...args)=>{if(e.sender!==window?.webContents)throw new Error('不允许的调用来源');return handler(...args);});

if(gotLock)void app.whenReady().then(()=>{
  try{store=new Store(personal);}catch(e){dialog.showErrorBox('个人文件无法读取',String(e));app.quit();return;}
  const fastRequests=process.env.AMBIENT_TEST_MODE==='1'&&process.env.AMBIENT_TEST_REQUEST_TIMING==='fast';
  const requests=new RequestController(()=>({origin:store.config.advanced.url,limit:store.config.advanced.requestsPerMinute??8}),fastRequests?{windowMs:1,minIntervalMs:0,cooldownMs:1}:{},path.join(personal,'request-state.json'));
  assistant=new Assistant(store,undefined,requests);
  session.defaultSession.setPermissionRequestHandler((wc,permission,callback,details)=>{callback(wc===window?.webContents&&permission==='media'&&!('mediaTypes' in details&&(details.mediaTypes||[]).includes('video')));});
  session.defaultSession.setPermissionCheckHandler((wc,permission)=>wc===window?.webContents&&permission==='media');
  window=new BrowserWindow({width:1180,height:820,minWidth:760,minHeight:590,backgroundColor:'#10191d',title:'伴语 · Ambient Companion',icon:fileURLToPath(new URL('./ui/icon.png',import.meta.url)),show:false,
    webPreferences:{preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
  window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',e=>e.preventDefault());
  assistant.on('event',e=>{if(['state','audio','delivery','interrupt'].includes(e.type))keepAudioActive(assistant.running||assistant.outputActive);if(window&&!window.isDestroyed())window.webContents.send('assistant:event',e);});
  on('snapshot',()=>({config:store.config,memoryText:store.memoryText(),instructions:store.instructions(),session:store.session,folder:personal,advancedStatus:assistant.advancedStatus,billing:assistant.billing,requests:assistant.requests.snapshot()}));
  on('config:save',(c)=>{if(assistant.running)throw new Error('请先暂停，再修改接口配置');const saved=store.saveConfig(c);assistant.refreshConfig();return saved;});
  on('connection:test',async(lane,c)=>{
    const cfg=validateConfig(c);if(lane==='voice'||lane==='high-voice'){
      const voice=createVoice({role:lane==='voice'?'gate':'high',config:resolveVoiceConfig(cfg,lane==='voice'?'low':'high'),appConfig:cfg,requests:assistant.requests,instructions:'连接检查，不主动生成回复。'});voice.on('fault',()=>{});
      try{await voice.connect();return {ok:true,message:'握手与会话配置成功；尚未验证模型生成或声音播放。'};}finally{voice.close();}
    }
    if(lane!=='text')throw new Error('无效的连接检查类型');
    if(assistant.running)throw new Error('请先暂停倾听，再测试、启用并保存文字设置');
    const model=new TextModel(cfg,undefined,{requests:assistant.requests,source:'connection-test'});
    const text=await model.complete([{role:'user',content:'请只回复“连接成功”。'}],AbortSignal.timeout(30000));
    return {ok:true,message:'文字接口调用成功：'+text.slice(0,160)};
  });
  on('text:save',(name,text)=>{if(!['memory.md','instructions.md'].includes(name))throw new Error('无效文件');store.saveText(name,text);return true;});
  on('start',()=>assistant.start());on('stop',()=>assistant.stop());
  on('text:send',(text)=>assistant.text(String(text)));
  on('high',()=>assistant.switchHigh());on('ambient',()=>assistant.backAmbient());
  on('tasks:cancel',(id)=>assistant.cancelTasks(id));on('tasks:clear',()=>assistant.clearTaskRecords());on('memory:organize',()=>assistant.organize());
  on('speech:replay',(id)=>assistant.replayTurn(String(id)));on('tasks:speak',(id)=>assistant.speakTask(String(id)));
  on('memory:add',(text)=>{store.remember(String(text),'用户在界面确认');return store.memoryText();});
  on('folder:open',()=>shell.openPath(personal));on('interrupt',()=>assistant.interrupt());
  on('context',()=>assistant.context||assistant.packet('','上下文预览'));
  on('quit',()=>{quitting=true;app.quit();});
  ipcMain.on('audio',(e,a)=>{if(e.sender===window?.webContents)assistant.audio(a);});
  ipcMain.on('playback',(e,p)=>{if(e.sender!==window?.webContents||!p||typeof p.id!=='string'||!['heard','partial','unheard'].includes(p.delivery)||!Number.isFinite(p.heardMs)||!Number.isFinite(p.durationMs))return;assistant.finishPlayback(p.id,p.delivery,p.heardMs,p.durationMs);});
  const wakeAudio=()=>window?.webContents.send('assistant:event',{type:'audioWake'});
  window.on('minimize',wakeAudio);window.on('hide',wakeAudio);window.on('restore',wakeAudio);window.on('show',wakeAudio);
  window.on('close',e=>{if(!quitting){e.preventDefault();window?.hide();}});
  window.once('ready-to-show',show);void window.loadFile(fileURLToPath(new URL('./ui/index.html',import.meta.url)));
  // Small original PNG tray icon; all user data and Electron caches live under personal/.
  const icon=nativeImage.createFromPath(fileURLToPath(new URL('./ui/icon.png',import.meta.url)));
  if(process.env.AMBIENT_TEST_MODE!=='1'){
    tray=new Tray(icon);tray.setToolTip('伴语 · Ambient Companion');tray.setContextMenu(Menu.buildFromTemplate([{label:'显示伴语',click:show},{label:'暂停并停止上传',click:()=>assistant.stop()},{type:'separator'},{label:'退出',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',show);
  }
  globalShortcut.register('CommandOrControl+Shift+Space',()=>{assistant.stop();show();});
  app.on('second-instance',show);
}).catch(e=>{dialog.showErrorBox('启动失败',safeError(e));app.quit();});
app.on('before-quit',()=>{quitting=true;assistant?.stop();keepAudioActive(false);globalShortcut.unregisterAll();});
