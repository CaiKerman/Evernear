import type { Config, VoiceConfig, VoiceProvider } from './types.js';
import { normalizeRealtimeURL } from './endpoints.js';

export const voicePresets={
  qwen:{label:'千问 Qwen Realtime',url:'wss://maas.qianwenaiapi.com/api-ws/v1/realtime',model:'qwen3.8-omni-flash-realtime',voice:'Tina'},
  openai:{label:'OpenAI Realtime',url:'wss://api.openai.com/v1/realtime',model:'gpt-realtime-2.1',voice:'marin'},
  gemini:{label:'Google Gemini Live',url:'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',model:'gemini-3.8-live',voice:'Aoede'},
  doubao:{label:'豆包实时语音（O / SC 2.0）',url:'wss://openspeech.bytedance.com/api/v3/realtime/dialogue',model:'1.2.1.1',voice:'zh_female_vv_jupiter_bigtts'}
} as const;
export function voiceProvider(c:VoiceConfig):VoiceProvider{return c.provider&&c.provider!=='inherit'?c.provider:'qwen';}
export function resolveVoiceConfig(config:Config,lane:'low'|'high'):VoiceConfig{
  const low=config.low,chosen=config[lane];
  const provider=lane==='high'&&(!chosen.provider||chosen.provider==='inherit')?voiceProvider(low):voiceProvider(chosen);
  const same=provider===voiceProvider(low);
  const result:VoiceConfig={...chosen,provider};
  for(const key of ['url','key','voice','appId','appKey','resourceId'] as const){
    if(!result[key])result[key]=lane==='high'&&same?low[key]||'':'';
  }
  result.url=result.url||voicePresets[provider].url;
  result.voice=result.voice||voicePresets[provider].voice;
  return result;
}
export function normalizeVoiceURL(provider:VoiceProvider,value:string){
  if(provider==='qwen')return normalizeRealtimeURL(value||voicePresets.qwen.url);
  let u:URL;try{u=new URL(value.trim()||voicePresets[provider].url);}catch{throw new Error('语音接口地址格式不正确');}
  if(u.username||u.password)throw new Error('不要在语音地址中填写凭据，请使用独立凭据字段');
  if(u.protocol==='https:')u.protocol='wss:';else if(u.protocol==='http:')u.protocol='ws:';
  if(!['ws:','wss:'].includes(u.protocol))throw new Error('实时语音接口需要 WebSocket 地址');
  if(!u.pathname||u.pathname==='/'||provider==='openai'&&u.pathname.replace(/\/$/,'')==='/v1')u.pathname=new URL(voicePresets[provider].url).pathname;
  // Keys stay out of endpoint previews and saved URL strings.
  if(['key','api_key','access_token'].some(k=>u.searchParams.has(k)))throw new Error('请把地址里的密钥移到 API Key 字段');
  u.hash='';return u.toString();
}
export function assertVoiceReady(c:VoiceConfig){
  if(!c.key?.trim()||!c.model?.trim())throw new Error('请填写所选语音厂商的 API Key / Access Token 和模型');
  if(voiceProvider(c)==='doubao'&&!c.appId?.trim())throw new Error('豆包实时语音还需要 App ID 和 Access Token，请使用语音服务控制台的凭据');
  if(voiceProvider(c)==='openai'&&/^gpt-live(?:-|$)/.test(c.model))throw new Error('GPT-Live 使用独立的 Live Sessions 协议，不能填入 OpenAI Realtime。本版 OpenAI 适配实时 Realtime 系列模型。');
}

// Doubao's persona field has a smaller limit than our local context packet.
// Preserve routing rules, current question and explicit capability facts first.
export function boundVoiceInstructions(instructions:string,limit:number){
  if(instructions.length<=limit)return instructions;
  const start=instructions.indexOf('{"purpose":'),end=instructions.lastIndexOf('}');
  if(start>=0&&end>start){
    try{
      const p=JSON.parse(instructions.slice(start,end+1)),r=p.runtime||{};
      const compact:any={purpose:p.purpose,now:p.now,query:String(p.query||'').slice(0,800),instructions:String(p.instructions||'').slice(0,400),
        backgroundNote:p.backgroundNote,runtime:{advanced:r.advanced,routing:r.routing?{preferredVoice:r.routing.preferredVoice,input:r.routing.input,waitingTasks:(r.routing.waitingTasks||[]).slice(-2).map((t:any)=>({id:t.id,query:String(t.query||'').slice(0,80)}))}:undefined,pendingReasoning:r.pendingReasoning?{query:String(r.pendingReasoning.query||'').slice(0,300)}:undefined},
        memory:(p.memory||[]).slice(0,2).map((m:string)=>m.slice(0,220)),summary:String(p.summary||'').slice(0,250),recent:(p.recent||[]).slice(-4).map((t:any)=>({role:t.role,at:t.at,text:String(t.text||'').slice(0,220)}))};
      const pack=()=>instructions.slice(0,start)+JSON.stringify(compact)+instructions.slice(end+1);
      while(pack().length>limit&&compact.recent.length)compact.recent.shift();
      while(pack().length>limit&&compact.memory.length)compact.memory.pop();
      if(pack().length>limit){compact.summary='';compact.instructions=compact.instructions.slice(0,180);}
      if(pack().length<=limit)return pack();
    }catch{/* Custom instructions may not contain an application context object. */}
  }
  const marker='\n[背景因厂商长度上限省略]\n',head=Math.floor((limit-marker.length)*.6);
  return instructions.slice(0,head)+marker+instructions.slice(-(limit-marker.length-head));
}
