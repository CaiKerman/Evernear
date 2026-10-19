// Only translate documented Qwen hosts. An arbitrary HTTP provider is not
// assumed to implement a realtime protocol just because its URL looks similar.
function endpoint(value:string){
  let u:URL;try{u=new URL(value.trim());}catch{throw new Error('接口地址格式不正确，请填写完整 URL');}
  if(u.username||u.password)throw new Error('接口地址中不要放账号或密钥，请使用 API Key 字段');
  return u;
}
export function normalizeChatURL(value:string){
  const u=endpoint(value);if(!['http:','https:'].includes(u.protocol))throw new Error('文字接口需要 HTTP(S) Base URL 或完整 Chat Completions 地址');
  const p=u.pathname.replace(/\/+$/,'');
  if(p.endsWith('/chat/completions'))u.pathname=p;
  else if(p.endsWith('/v1')||p.endsWith('/compatible-mode'))u.pathname=p+(p.endsWith('/v1')?'/chat/completions':'/v1/chat/completions');
  else if(!p)u.pathname='/compatible-mode/v1/chat/completions';
  // Leave custom non-standard completion paths intact.
  u.hash='';return u.toString();
}
export function normalizeRealtimeURL(value:string){
  if(/\{workspaceid\}/i.test(value))throw new Error('这是尚未填写的百炼业务空间地址。千问 AI 平台请改填 wss://maas.qianwenaiapi.com/api-ws/v1/realtime；百炼用户需填写真实业务空间 ID');
  const u=endpoint(value);
  if(['ws:','wss:'].includes(u.protocol)){if(u.pathname==='/')u.pathname='/api-ws/v1/realtime';u.hash='';return u.toString();}
  if(!['http:','https:'].includes(u.protocol))throw new Error('实时语音需要 WebSocket 地址');
  const known=u.hostname==='maas.qianwenaiapi.com'||/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/i.test(u.hostname)||['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com'].includes(u.hostname);
  if(!known)throw new Error('这个 HTTP 地址不能自动转换为实时语音接口，请填写供应商提供的 WebSocket 地址');
  const p=u.pathname.replace(/\/+$/,'');
  if(!['','/compatible-mode','/compatible-mode/v1','/compatible-mode/v1/chat/completions','/api-ws/v1/realtime'].includes(p))throw new Error('该路径不是已知的千问实时或 Chat Completions 地址');
  u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname='/api-ws/v1/realtime';u.search='';u.hash='';return u.toString();
}
export function assertRealtimeModel(model:string){
  if(/^qwen3\.8-omni-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(model))throw new Error(`${model} 仅输出文本，不能作为实时语音模型。请使用 qwen3.8-omni-flash-realtime；原型号可填到“高级文字推理”中。`);
}
