const {contextBridge,ipcRenderer}=require('electron');
const channels=new Set(['snapshot','config:save','connection:test','text:save','start','stop','text:send','high','ambient','tasks:cancel','tasks:clear','speech:replay','tasks:speak','memory:organize','memory:add','folder:open','interrupt','context','quit','quick:toggle','text:cancel-active','capture:failed']);
contextBridge.exposeInMainWorld('ambient',{
  invoke:(name,...args)=>{if(!channels.has(name))return Promise.reject(new Error('无效调用'));return ipcRenderer.invoke(name,...args);},
  audio:(audio)=>ipcRenderer.send('audio',audio),
  playback:(event)=>ipcRenderer.send('playback',event),
  subscribe:(callback)=>{const handler=(_,event)=>callback(event);ipcRenderer.on('assistant:event',handler);return()=>ipcRenderer.removeListener('assistant:event',handler);}
});
