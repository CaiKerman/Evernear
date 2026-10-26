import type { Config, Snapshot, Turn, AppEvent, ContextPacket, Task } from './types.js';
import { normalizeChatURL } from './endpoints.js';
import { voicePresets, voiceProvider, resolveVoiceConfig, normalizeVoiceURL } from './voice-config.js';
import { advancedAvailability } from './runtime.js';
import { PcmPlayer } from './playback.js';
declare global { interface Window { ambient:{invoke:(channel:string,...args:any[])=>Promise<any>;audio:(base64:string)=>void;playback:(p:any)=>void;subscribe:(f:(e:AppEvent)=>void)=>()=>void}; } }
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const bridge=window.ambient;
let snapshot:Snapshot,config:Config,running=false,starting=false,startGeneration=0,toastTimer:ReturnType<typeof setTimeout>;
let captureContext:AudioContext|undefined,stream:MediaStream|undefined,captureNode:AudioWorkletNode|undefined;
let levelLast=0, manualCapture=false;
let captureStarting: Promise<void>|undefined;
const messageElements=new Map<string,HTMLElement>();
const displayedTurns=new Map<string,Turn>();

function toast(message:string,error=false){const n=$('toast');n.textContent=message;n.classList.toggle('error',error);n.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>n.classList.add('hidden'),error?11000:6000);}
async function call(name:string,...args:any[]){try{return await bridge.invoke(name,...args);}catch(e){toast(String(e).replace(/^Error: Error invoking remote method '[^']+': Error: /,''),true);throw e;}}
function fire(name:string,...args:any[]){void call(name,...args).catch(()=>{});}
function page(name:string){window.scrollTo(0,0);for(const n of document.querySelectorAll('.page'))n.classList.toggle('active',n.id==='page-'+name);for(const n of document.querySelectorAll<HTMLElement>('.nav'))n.classList.toggle('active',n.dataset.page===name);$('page-title').textContent=({conversation:'对话空间',memory:'个人记忆',context:'本轮上下文',settings:'连接与偏好'} as any)[name];}
for(const n of document.querySelectorAll<HTMLElement>('.nav'))n.onclick=()=>page(n.dataset.page!);

const player=new PcmPlayer(()=>config?.outputDevice||'',p=>bridge.playback(p),e=>toast('音频播放失败：'+String(e),true));
const ensurePlayback=()=>player.prepare();
const stopPlayback=()=>player.interrupt();
function wakeAudio(){
  player.wake();
  if(!running&&!manualCapture)return;
  if(captureContext&&captureContext.state!=='running'&&captureContext.state!=='closed')void captureContext.resume().catch(e=>toast('麦克风恢复失败：'+String(e),true));
}
document.addEventListener('visibilitychange',wakeAudio);
window.addEventListener('focus',wakeAudio);

async function startCapture(){
  if (captureStarting) return captureStarting;
  if (stream) return;
  captureStarting=connectCapture().finally(()=>captureStarting=undefined); return captureStarting;
}
async function connectCapture(){
  stream=await navigator.mediaDevices.getUserMedia({video:false,audio:{...(config.microphone?{deviceId:{exact:config.microphone}}:{}),channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  captureContext=new AudioContext();await captureContext.audioWorklet.addModule(new URL('./ui/capture-worklet.js',import.meta.url));
  const source=captureContext.createMediaStreamSource(stream);captureNode=new AudioWorkletNode(captureContext,'ambient-capture');
  const mute=captureContext.createGain();mute.gain.value=0;source.connect(captureNode).connect(mute).connect(captureContext.destination);
  captureNode.port.onmessage=e=>{if(e.data.type==='pcm'&&(running||manualCapture)){const bytes=new Uint8Array(e.data.buffer);let b='';for(const x of bytes)b+=String.fromCharCode(x);bridge.audio(btoa(b));}
    if(e.data.type==='level'&&performance.now()-levelLast>100){levelLast=performance.now();const scale=Math.min(1.6,.65+e.data.value*12);document.querySelector<HTMLElement>('.wave')!.style.transform=`scaleY(${scale})`;}};
  captureContext.onstatechange=()=>{if((running||manualCapture)&&captureContext?.state==='suspended')wakeAudio();};
  await captureContext.resume();
}
async function stopCapture(){if(captureStarting)await captureStarting.catch(()=>{});stream?.getTracks().forEach(t=>t.stop());stream=undefined;captureNode?.disconnect();captureNode=undefined;const old=captureContext;captureContext=undefined;if(old&&old.state!=='closed')await old.close().catch(()=>{});}
function renderListenControls(){
  for(const id of ['start','pause-header']){
    const button=$<HTMLButtonElement>(id);button.disabled=starting;
    button.textContent=starting?'连接中…':running?(id==='start'?'■ 暂停全部听说':'■ 暂停全部'):(id==='start'?'▶ 开始倾听':'▶ 开始');
    button.setAttribute('aria-pressed',String(running));button.title=starting?'正在连接语音服务':running?'停止全部听说并取消语音分析任务':'开始倾听';
  }
}
async function start(){if(starting)return;if(running){await pause();return;}starting=true;renderListenControls();const generation=++startGeneration;
  try{await ensurePlayback();await startCapture();if(generation!==startGeneration){await stopCapture();return;}await call('start');if(generation!==startGeneration){await stopCapture();return;}running=true;updateState({type:'state',running:true,mode:'ambient',label:'基础值守 · 麦克风上传至基础语音'});toast('已开始收音与上传。Ctrl + Shift + Space 可随时暂停。');}
  catch(e){await stopCapture();fire('stop');toast(String(e),true);}finally{starting=false;renderListenControls();}}
async function pause(){startGeneration++;await call('stop');running=false;stopPlayback();await stopCapture();}
function updateState(e:AppEvent){if(!e.running&&starting)startGeneration++;running=e.running;renderListenControls();document.body.classList.toggle('listening',running);$('status-dot').classList.toggle('online',running);$('status-label').textContent=e.manualRecording?e.label:running?e.label||'正在倾听 · 音频上传中':'已暂停 · 尚未采集或上传音频';$('mode-badge').textContent=e.mode==='high'?'高级语音接收':'基础语音接收';$('back-ambient').classList.toggle('hidden',e.mode!=='high');$('switch-high').classList.toggle('hidden',e.mode==='high');$('art-label').textContent=running?'LISTENING WITH YOU':'READY TO LISTEN';if(e.tasks)renderTasks(e.tasks);if(!running&&!starting&&!manualCapture)void stopCapture();}
function addTurn(t:Turn){displayedTurns.set(t.id,t);$('welcome')?.remove();let el=messageElements.get(t.id);if(!el){el=document.createElement('div');el.className='message '+t.role;el.dataset.id=t.id;const meta=document.createElement('div');meta.className='message-meta';const name=document.createElement('span');name.textContent=t.role==='user'?'你':'伴语';const lane=document.createElement('span');lane.textContent=t.lane;const delivery=document.createElement('span');delivery.className='delivery';meta.append(name,lane,delivery);const body=document.createElement('div');body.className='message-body';el.append(meta,body);if(t.role==='assistant'){const button=document.createElement('button');button.className='link replay-turn';button.onclick=()=>{void ensurePlayback().then(()=>call('speech:replay',t.id)).catch(()=>{});};el.append(button);}$('chat').append(el);messageElements.set(t.id,el);}
  el.querySelector('.message-body')!.textContent=t.text||(t.delivery==='unheard'?'本次语音未生成。':'正在说话…');const d=el.querySelector<HTMLElement>('.delivery')!;d.textContent=t.delivery?({generated:'待播报',heard:'已播报',partial:'部分播报',unheard:'未播报'}[t.delivery]):'';d.title=t.deliveryReason||'';const button=el.querySelector<HTMLButtonElement>('.replay-turn');if(button){button.textContent=t.delivery==='generated'?'等待播报':'重新播报';button.disabled=t.delivery==='generated'||!t.text;button.title=t.deliveryReason||'朗读已生成的文字；会调用语音接口，不会重新请求文字推理';}let reason=el.querySelector<HTMLElement>('.delivery-reason');if(!reason){reason=document.createElement('small');reason.className='delivery-reason';el.append(reason);}reason.textContent=t.deliveryReason&&t.delivery!=='generated'?t.deliveryReason:'';$('chat').scrollTop=$('chat').scrollHeight;
}
function renderTasks(tasks:Task[]){const root=$('tasks');$<HTMLButtonElement>('cancel-tasks').disabled=!tasks.some(t=>t.status==='running');$<HTMLButtonElement>('clear-tasks').disabled=!tasks.some(t=>t.status!=='running');root.replaceChildren();if(!tasks.length){root.textContent='暂时没有任务';root.className='muted';return;}root.className='';for(const t of tasks.slice(-4).reverse()){
  const el=document.createElement('div');el.className='task';const label=document.createElement('div');label.textContent=t.query.slice(0,90);const status=document.createElement('span');status.className='task-status';status.textContent=({running:'处理中…',done:'已完成',cancelled:'已取消',failed:'失败：'+(t.error||'')}[t.status]);
  el.append(label,status);if(t.status==='done'&&t.result){const read=document.createElement('button');read.className='link';read.textContent='播报结果';read.onclick=e=>{e.stopPropagation();void ensurePlayback().then(()=>call('tasks:speak',t.id)).catch(()=>{});};el.append(read);}if(t.status==='running'){const b=document.createElement('button');b.textContent='取消';b.dataset.cancel=t.id;b.onclick=()=>fire('tasks:cancel',t.id);el.append(b);}if(t.result){el.title=t.result;el.onclick=()=>{const n=document.createElement('div');n.className='message assistant';const body=document.createElement('div');body.className='message-body';body.textContent=t.result||'';n.append(body);$('chat').append(n);page('conversation');$('chat').scrollTop=$('chat').scrollHeight;};}root.append(el);}}
function renderContext(p:ContextPacket){$('context-purpose').textContent=p.purpose;$('context-size').textContent=`${p.chars.toLocaleString()} / ${p.limit.toLocaleString()}`;$('context-memories').textContent=String(p.memory.length);$('context-json').textContent=JSON.stringify({instructions:p.instructions,...JSON.parse(p.text)},null,2);}
function nested(obj:any,key:string){return key.split('.').reduce((o,k)=>o?.[k],obj);}
function assign(obj:any,key:string,value:any){const keys=key.split('.');let o=obj;for(const k of keys.slice(0,-1))o=o[k];o[keys.at(-1)!]=value;}
function readSettings(includeQuickParameters=true):Config{const next=structuredClone(config);for(const n of document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#settings-form [name]')){const val=n instanceof HTMLInputElement&&n.type==='checkbox'?n.checked:n instanceof HTMLInputElement&&n.type==='number'?(n.value===''&&/^(prices|highPrices|advancedPrices)\./.test(n.name)?null:Number(n.value)):n.value.trim();assign(next,n.name,val);}next.sensitivity=$<HTMLSelectElement>('sensitivity').value as Config['sensitivity'];try{if(includeQuickParameters)next.quickInput.parameters=JSON.parse($<HTMLTextAreaElement>('quick-parameters').value);}catch{throw new Error('快捷栏预设参数不是有效的 JSON');}return next;}
const field=(name:string)=>document.querySelector<HTMLInputElement|HTMLSelectElement>(`[name="${name}"]`)!;
function endpointPreview(){
  if(!config)return;const draft=readSettings(false);
  for(const [lane,id] of [['low','voice-preview'],['high','high-voice-preview']] as const){
    try{const resolved=resolveVoiceConfig(draft,lane);$(id).textContent='实际实时地址：'+normalizeVoiceURL(voiceProvider(resolved),resolved.url);}
    catch(e){$(id).textContent=String(e).replace(/^Error: /,'');}
  }
  try{$('text-preview').textContent='实际文字地址：'+normalizeChatURL(draft.advanced.url);}catch(e){$('text-preview').textContent=String(e).replace(/^Error: /,'');}
}
const providerHelp={
  qwen:'Qwen 使用 -realtime 系列模型；普通 Omni 的 HTTP 文本接口不能填在这里。百炼业务空间入口可在轻量地域预设中填写。',
  openai:'使用 OpenAI Realtime 系列模型和相应音色。GPT-Live 属于另一套 Live Sessions 协议，本版尚未适配。',
  gemini:'使用 Gemini Live 原生音频模型。轻量模式通过函数提交决策；本机屏蔽决策音频，但服务端仍可能收取生成费用。',
  doubao:'填写实时语音的模型版本号（例如 O 2.0：1.2.1.1；SC 2.0：2.2.0.0）和匹配音色。高级模式支持完整命令“返回轻量模式”“取消后台任务”“交给高级文字，问题”“记住，事实”。本机打断不保证停止云端生成。'
};
function providerUI(){
  const low=field('low.provider').value;const high=field('high.provider').value;const qwen=low==='qwen';
  $('qwen-region-label').classList.toggle('hidden',!qwen);
  $('workspace-label').classList.toggle('hidden',!qwen||!['beijing','singapore'].includes($<HTMLSelectElement>('voice-preset').value));
  for(const lane of ['low','high'] as const){const p=(lane==='low'?low:high==='inherit'?low:high) as keyof typeof providerHelp;
    $(lane+'-provider-help').textContent=providerHelp[p];for(const el of document.querySelectorAll('.'+lane+'-doubao'))el.classList.toggle('hidden',p!=='doubao');
  }
  endpointPreview();
}
function providerDefaults(lane:'low'|'high',changed=false){
  const selected=field(lane+'.provider').value;const p=(selected==='inherit'?field('low.provider').value:selected) as keyof typeof voicePresets;
  if(changed){for(const key of ['key','appId','appKey','resourceId'])field(lane+'.'+key).value='';}
  for(const key of ['url','model','voice'] as const)field(lane+'.'+key).value=selected==='inherit'&&changed?'':voicePresets[p][key];
  if(lane==='low'){$<HTMLSelectElement>('voice-preset').value='qianwen';$<HTMLInputElement>('workspace-id').value='';}
  providerUI();advancedPreview();
}
function inferPreset(){const url=config.low.url;const preset=$<HTMLSelectElement>('voice-preset');const m=url.match(/^wss:\/\/([a-z0-9-]+|\{workspaceId\})\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com/i);
  preset.value=url.includes('maas.qianwenaiapi.com')?'qianwen':m?(m[2]==='cn-beijing'?'beijing':'singapore'):'custom';$<HTMLInputElement>('workspace-id').value=m&&!m[1].includes('{')?m[1]:'';$('workspace-label').classList.toggle('hidden',!['beijing','singapore'].includes(preset.value));endpointPreview();
}
function applyPreset(){const type=$<HTMLSelectElement>('voice-preset').value;const id=$<HTMLInputElement>('workspace-id').value.trim();$('workspace-label').classList.toggle('hidden',!['beijing','singapore'].includes(type));const input=document.querySelector<HTMLInputElement>('[name="low.url"]')!;
  if(type==='qianwen')input.value='wss://maas.qianwenaiapi.com/api-ws/v1/realtime';
  else if(type==='beijing'||type==='singapore')input.value=`wss://${id||'{workspaceId}'}.${type==='beijing'?'cn-beijing':'ap-southeast-1'}.maas.aliyuncs.com/api-ws/v1/realtime`;
  endpointPreview();
}
function renderBilling(billing:import('./billing.js').BillingSnapshot){
  $('token-count').replaceChildren(document.createTextNode(billing.totalTokens.toLocaleString()),Object.assign(document.createElement('small'),{textContent:' tokens'}));
  $('cost-label').textContent=billing.rows.length?`${billing.incomplete?'已计价部分':'已报告用量估算'} ¥${billing.knownCost.toFixed(4)}${billing.incomplete?' · 含未计价用量':''}`:'费用未估算 · 可在设置分别填写三组单价';
  const root=$('cost-breakdown');root.replaceChildren();
  for(const [group,label] of [['low','轻量语音（监听＋分流＋播报）'],['high','高级语音'],['advanced','高级文字（推理＋记忆）']] as const){
    const rows=billing.rows.filter(r=>r.group===group);const el=document.createElement('div');el.className='cost-row';
    const title=document.createElement('strong');title.textContent=label;
    const body=document.createElement('span');
    if(!rows.length)body.textContent='尚无用量报告';
    else{const cost=rows.reduce((n,r)=>n+r.cost,0),input=rows.reduce((n,r)=>n+r.inputTokens,0),output=rows.reduce((n,r)=>n+r.outputTokens,0),missing=rows.some(r=>r.unpricedTokens||r.unclassifiedTokens||r.missingUsageReports);
      body.textContent=`输入 ${input.toLocaleString()} / 输出 ${output.toLocaleString()} 词元 · ${missing?'已计价部分 ':''}¥${cost.toFixed(4)}${missing?'；其余未计价':''}`;}
    el.append(title,body);
    if(rows.length&&group!=='advanced'){
      const detail=document.createElement('span');const sum=(part:'textInput'|'audioInput'|'textOutput'|'audioOutput')=>rows.reduce((n,r)=>n+r.tokens[part],0).toLocaleString();
      detail.textContent=`已分项报告：文字入 ${sum('textInput')} / 音频入 ${sum('audioInput')} / 文字出 ${sum('textOutput')} / 音频出 ${sum('audioOutput')}`;el.append(detail);
    }
    root.append(el);
  }
  $('billing-note').textContent=billing.note;
}
function renderRequests(r:any){const at=new Date(r.at).toLocaleTimeString();$('request-status').textContent=`截至 ${at}，近 60 秒本机发出：高级文字 ${r.counts.advanced} 次、语音建连 ${r.counts.voice} 次、搜索 ${r.counts.search} 次；本地拦截 ${r.blocked} 次。失败也计数，音频包不计作新请求。${r.voiceProtocol?`实时生成指令 ${r.voiceProtocol.clientResponseCreates} 次、服务端响应事件 ${r.voiceProtocol.serverResponses} 次；配置更新 ${r.voiceProtocol.sessionUpdates} 次。`:''}逐次来源记录在 personal/requests/。${r.persistenceWarning?' '+r.persistenceWarning:''}`;}
function showAdvancedStatus(status:{state:string;message:string}){const el=$('advanced-status');el.textContent=status.message;el.classList.toggle('warning',['disabled','incomplete','failed'].includes(status.state));}
function advancedPreview(){
  if(!config)return;
  const draft=readSettings(false),saved=advancedAvailability(config),status=advancedAvailability(draft);
  const dirty=JSON.stringify(draft.advanced)!==JSON.stringify(config.advanced)||draft.proxy!==config.proxy;
  const el=$('advanced-config-status');el.textContent=(dirty?'未保存的编辑：'+status.message.replace('已保存启用','填写完整，保存后启用')+'\n当前生效：'+saved.message:saved.message);
  el.classList.toggle('warning',dirty||status.state!=='configured');
}
async function testConnection(lane:'voice'|'high-voice'|'text'){
  if(lane==='text'&&(running||starting)){toast('请先暂停倾听，再测试、启用并保存文字设置',true);return;}
  const b=$<HTMLButtonElement>(lane==='voice'?'test-voice':lane==='high-voice'?'test-high-voice':'test-text'),old=b.textContent;b.disabled=true;b.textContent='正在检查…';
  try{
    const draft=readSettings(),original=JSON.stringify(draft),candidate=structuredClone(draft);
    if(lane==='text')candidate.advanced.enabled=true;
    const result=await call('connection:test',lane,candidate);
    if(lane==='text'){
      if(original!==JSON.stringify(readSettings())){toast('文字接口测试成功，但设置已更改，未自动保存。请重新点击测试、启用并保存。',true);return;}
      config=await call('config:save',candidate);fillSettings();showAdvancedStatus(advancedAvailability(config));
      toast('文字接口测试成功，已启用并保存。可以开始倾听，或继续刚才的问题。');
    }else toast(result.message);
  }catch(e){toast(String(e),true);}finally{b.disabled=false;b.textContent=old;}
}
function fillSettings(){$<HTMLTextAreaElement>('quick-parameters').value=JSON.stringify(config.quickInput.parameters,null,2);for(const n of document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#settings-form [name]')){const v=nested(config,n.name);if(n instanceof HTMLInputElement&&n.type==='checkbox')n.checked=Boolean(v);else n.value=String(v??'');}$<HTMLSelectElement>('sensitivity').value=config.sensitivity;inferPreset();providerUI();advancedPreview();}
async function devices(ask=false){try{if(ask){const s=await navigator.mediaDevices.getUserMedia({audio:true,video:false});s.getTracks().forEach(t=>t.stop());}const ds=await navigator.mediaDevices.enumerateDevices();for(const [id,kind,key] of [['microphone','audioinput','microphone'],['output-device','audiooutput','outputDevice']] as const){const sel=$<HTMLSelectElement>(id);sel.replaceChildren(new Option('系统默认',''));for(const d of ds.filter(d=>d.kind===kind))sel.add(new Option(d.label||`设备 ${d.deviceId.slice(0,6)}`,d.deviceId));if(config[key]&&!Array.from(sel.options).some(o=>o.value===config[key]))sel.add(new Option('已保存的设备（当前未检测到）',config[key]));sel.value=config[key];}}catch(e){if(ask)toast('无法获取音频设备：'+String(e),true);}}

bridge.subscribe(e=>{
  if(e.type==='capture'){manualCapture=!!e.active;if(manualCapture)void startCapture().catch(error=>{manualCapture=false;fire('capture:failed');void stopCapture();toast('主动录音失败：'+String(error),true);});else if(!running)void stopCapture();}
  if(e.type==='settingsOpen'){void call('snapshot').then((s:Snapshot)=>{config=s.config;fillSettings();page('settings');}).catch(()=>{});}
  if(e.type==='quickSettings'&&config){config.quickInput=e.settings;const checkbox=document.querySelector<HTMLInputElement>('[name="quickInput.visible"]');if(checkbox)checkbox.checked=e.settings.visible;}
  if(e.type==='requests')renderRequests(e.requests);
  if(e.type==='state'){updateState(e);if(e.advancedStatus)showAdvancedStatus(e.advancedStatus);if(e.billing)renderBilling(e.billing);if(e.requests)renderRequests(e.requests);}
  if(e.type==='error')toast(e.message,true);
  if(e.type==='notice')toast(e.message);
  if(e.type==='interrupt')stopPlayback();
  if(e.type==='turn'||e.type==='turnUpdate')addTurn(e.turn);
  if(e.type==='delivery'){const turn=displayedTurns.get(e.id);if(turn)addTurn({...turn,delivery:e.delivery,heardMs:e.heardMs});}
  if(e.type==='audio')player.enqueue({...e,turnId:e.playbackId||e.turnId} as any);
  if(e.type==='audioEnd')player.end(e.playbackId||e.turnId);
  if(e.type==='audioWake')wakeAudio();
  if(e.type==='decision'){const labels:any={ignore:'保持沉默',answer:'直接回答',delegate:'高级推理',switch_high:'高级语音',ambient:'轻量语音优先',cancel:'取消任务',remember:'写入记忆',recall:'检索记忆',capabilities:'查询能力状态'};$('decision-label').textContent=labels[e.decision.action];const n=document.createElement('div');n.className='decision';const b=document.createElement('b');b.textContent=labels[e.decision.action];n.append(b,document.createTextNode(e.decision.reason));$('decisions').prepend(n);while($('decisions').children.length>4)$('decisions').lastElementChild?.remove();}
  if(e.type==='context')renderContext(e.packet);
  if(e.type==='memory')$<HTMLTextAreaElement>('memory-editor').value=e.text;
  if(e.type==='taskResult')toast('后台任务已完成，可以在任务列表查看完整结果');
  if(e.type==='usage'&&e.billing)renderBilling(e.billing);
  if(e.type==='summary'){$('summary').textContent=e.text;toast('较早对话摘要已更新');}
});

$('start').onclick=$('pause-header').onclick=()=>void start().catch(()=>{});
$('interrupt').onclick=()=>{stopPlayback();fire('interrupt');};$('switch-high').onclick=()=>fire('high');$('back-ambient').onclick=()=>fire('ambient');$('cancel-tasks').onclick=()=>fire('tasks:cancel');
$('clear-tasks').onclick=()=>{void call('tasks:clear').then((count:number)=>toast(count?`已清空 ${count} 条已结束任务记录；运行中的任务会保留。`:'没有可清空的已结束任务记录。')).catch(()=>{});};
$('quick-toggle').onclick=()=>fire('quick:toggle');
$('cancel-text-work').onclick=()=>fire('text:cancel-active');
$('open-folder').onclick=()=>fire('folder:open');$('quit').onclick=()=>fire('quit');
$('refresh-context').onclick=()=>void call('context').then(renderContext).catch(()=>{});
$('refresh-devices').onclick=()=>void devices(true);
for(const lane of ['low','high'] as const){$(lane+'-provider').onchange=()=>providerDefaults(lane,true);$(lane+'-defaults').onclick=()=>providerDefaults(lane);}
$('voice-preset').onchange=applyPreset;$('workspace-id').oninput=applyPreset;
for(const name of ['low.url','high.url','advanced.url'])document.querySelector<HTMLInputElement>(`[name="${name}"]`)!.oninput=endpointPreview;
$('settings-form').addEventListener('input',advancedPreview);
$('settings-form').addEventListener('change',advancedPreview);
$('test-high-voice').onclick=()=>void testConnection('high-voice');$('test-voice').onclick=()=>void testConnection('voice');$('test-text').onclick=()=>void testConnection('text');
$('save-memory').onclick=()=>void call('text:save','memory.md',$<HTMLTextAreaElement>('memory-editor').value).then(()=>toast('记忆已保存，下一次组装上下文时生效')).catch(()=>{});
$('save-instructions').onclick=()=>void call('text:save','instructions.md',$<HTMLTextAreaElement>('instructions-editor').value).then(()=>toast('行为指令已保存；重新连接或下次刷新会话时生效')).catch(()=>{});
$('organize').onclick=()=>fire('memory:organize');
$('add-memory').onclick=()=>{const input=$<HTMLInputElement>('new-memory');if(input.value.trim())void call('memory:add',input.value).then(m=>{$<HTMLTextAreaElement>('memory-editor').value=m;input.value='';toast('已保存到 memory.md');}).catch(()=>{});};
$<HTMLFormElement>('settings-form').onsubmit=e=>{e.preventDefault();let candidate:Config;try{candidate=readSettings();}catch(error){toast(String(error),true);return;}void call('config:save',candidate).then(c=>{config=c;fillSettings();const status=advancedAvailability(config);showAdvancedStatus(status);toast('设置已保存。'+status.message,status.state==='incomplete'||status.state==='disabled'&&status.missing.length===0);}).catch(()=>{});};
$<HTMLSelectElement>('sensitivity').onchange=()=>{if(running){toast('请先暂停，再保存介入积极程度');$<HTMLSelectElement>('sensitivity').value=config.sensitivity;return;}const next={...config,sensitivity:$<HTMLSelectElement>('sensitivity').value};void call('config:save',next).then(c=>config=c).catch(()=>{});};
$<HTMLFormElement>('composer').onsubmit=e=>{e.preventDefault();const n=$<HTMLInputElement>('message'),text=n.value.trim();if(!text)return;if(!running){toast('请先开始倾听',true);return;}void call('text:send',text).then(()=>{n.value='';}).catch(()=>{});};
document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.shiftKey&&e.code==='Space'){e.preventDefault();void pause();}});

void call('snapshot').then(async(s:Snapshot)=>{snapshot=s;config=s.config;fillSettings();showAdvancedStatus(s.advancedStatus||advancedAvailability(config));if(s.billing)renderBilling(s.billing);if(s.requests)renderRequests(s.requests);$<HTMLTextAreaElement>('memory-editor').value=s.memoryText;$<HTMLTextAreaElement>('instructions-editor').value=s.instructions;$('summary').textContent=s.session.summary||'尚无恢复摘要';for(const t of s.session.turns.slice(-30))addTurn(t);renderTasks(s.session.tasks);await devices();}).catch(()=>{});
