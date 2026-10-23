const {contextBridge,ipcRenderer}=require('electron');
const channels=new Set(['quick:snapshot','quick:send','quick:cancel','quick:copy','quick:settings','quick:hide','quick:expand','quick:mode']);
contextBridge.exposeInMainWorld('quick',{
  invoke:(name,...args)=>channels.has(name)?ipcRenderer.invoke(name,...args):Promise.reject(new Error('无效调用')),
  subscribe:callback=>{const handler=(_,state)=>callback(state);ipcRenderer.on('quick:change',handler);return()=>ipcRenderer.removeListener('quick:change',handler);}
});
