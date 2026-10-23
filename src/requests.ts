import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ApiFailure } from './api-errors.js';
import fs from 'node:fs';
import path from 'node:path';
export interface RequestInfo {url:string;model:string;source:string;channel:'advanced'|'voice'|'search';taskId?:string;round?:number;limit?:number;}
interface Group {starts:number[];lastStart:number;cooldown:number;busy:boolean;waiters:{resolve:()=>void;reject:(e:unknown)=>void;signal:AbortSignal;abort:()=>void}[];}
export class LocalRequestLimit extends Error {constructor(message:string){super('本地请求保护：'+message+'；本次没有向服务器发送请求。');this.name='LocalRequestLimit';}}
export const requestOrigin=(value:string)=>{try{return new URL(value).origin.replace(/^ws/,'http');}catch{return '';}};
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{signal.throwIfAborted();const done=()=>{signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason||new Error('已取消'));};signal.addEventListener('abort',abort,{once:true});});
export class RequestController extends EventEmitter {
  private groups=new Map<string,Group>();private records:any[]=[];private persistenceWarning='';private audioSeconds=new Map<number,number>();
  constructor(private policy:()=>{origin:string;limit:number}=()=>({origin:'',limit:8}),private timing:{windowMs?:number;minIntervalMs?:number;cooldownMs?:number}={},private stateFile?:string){super();this.restore();}
  // Persist only request metadata. No credentials, prompts or audio are stored here.
  // The request log also restores pre-upgrade counts and a start saved just before a crash.
  private restore(){
    if(!this.stateFile)return;const entries:any[]=[],now=Date.now();
    if(fs.existsSync(this.stateFile))try{const x=JSON.parse(fs.readFileSync(this.stateFile,'utf8'));if(x.version!==1||!Array.isArray(x.records))throw new Error('invalid state');entries.push(...x.records);}catch{try{if(!fs.existsSync(this.stateFile+'.invalid.bak'))fs.copyFileSync(this.stateFile,this.stateFile+'.invalid.bak');}catch{}this.persistenceWarning='请求计数缓存无法读取，已尝试从请求日志恢复；原缓存会备份。';}
    const folder=path.join(path.dirname(this.stateFile),'requests');
    try{for(const name of fs.readdirSync(folder).filter(n=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().slice(-2)){
      const f=path.join(folder,name),fd=fs.openSync(f,'r');try{const size=fs.fstatSync(fd).size,offset=Math.max(0,size-512*1024),buffer=Buffer.alloc(size-offset);fs.readSync(fd,buffer,0,buffer.length,offset);let lines=buffer.toString('utf8').split('\n');if(offset)lines=lines.slice(1);for(const line of lines){if(!line.trim())continue;try{entries.push(JSON.parse(line));}catch{/* A truncated last log line is not a sent request. */}}}finally{fs.closeSync(fd);}
    }}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')this.persistenceWarning='部分请求日志无法读取，已保留可恢复的请求计数。';}
    const unique=new Map<string,any>();
    for(const r of entries){
      if(!r||!['start','finish','blocked','protocol'].includes(r.phase)||!['advanced','voice','search'].includes(r.channel)||typeof r.origin!=='string'||!/^https?:\/\//.test(r.origin))continue;
      const at=Date.parse(r.at),cooldown=Date.parse(r.cooldownUntil||'');if(!Number.isFinite(at)||at>now+1000||now-at>this.windowMs&&!(cooldown>now))continue;
      try{if(new URL(r.origin).origin!==r.origin)continue;}catch{continue;}
      // Rebuild an allowlisted record so an edited cache cannot expose arbitrary fields in UI.
      const clean={at:new Date(at).toISOString(),origin:r.origin,path:typeof r.path==='string'?r.path.split('?')[0].slice(0,300):'',channel:r.channel,source:String(r.source||'').slice(0,100),model:String(r.model||'').slice(0,200),phase:r.phase,...(typeof r.id==='string'?{id:r.id.slice(0,100)}:{}),...(typeof r.taskId==='string'?{taskId:r.taskId.slice(0,100)}:{}),...(Number.isInteger(r.round)?{round:r.round}:{}),...(cooldown>now?{cooldownUntil:new Date(cooldown).toISOString()}:{}),...(r.status!==undefined?{status:r.status}:{}),...(typeof r.event==='string'?{event:r.event.slice(0,60)}:{}),...(r.direction==='sent'||r.direction==='received'?{direction:r.direction}:{})};
      unique.set(`${clean.phase}:${clean.id||clean.at+clean.origin+clean.source}`,clean);
    }
    this.records=[...unique.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-2000);
    for(const r of this.records){const g=this.group(r.origin,r.channel),at=Date.parse(r.at);if(r.phase==='start'&&now-at<this.windowMs){g.starts.push(at);g.lastStart=Math.max(g.lastStart,at);}g.cooldown=Math.max(g.cooldown,Date.parse(r.cooldownUntil||'')||0);}
  }
  private persist(){
    if(!this.stateFile)return;try{
      fs.mkdirSync(path.dirname(this.stateFile),{recursive:true});const now=Date.now(),records=this.records.filter(r=>now-Date.parse(r.at)<this.windowMs||Date.parse(r.cooldownUntil||'')>now);
      const temp=this.stateFile+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:1,records},null,2),'utf8');if(fs.existsSync(this.stateFile))fs.copyFileSync(this.stateFile,this.stateFile+'.bak');fs.renameSync(temp,this.stateFile);
    }catch{this.persistenceWarning='请求计数无法保存到个人文件夹；当前进程仍保留计数与冷却，重启可能无法恢复。';}
  }
  private failureEvidence(info:RequestInfo,error:ApiFailure){
    const origin=this.endpoint(info).origin,rows=this.records.filter(r=>r.phase==='start'&&r.origin===origin&&Date.now()-Date.parse(r.at)<this.windowMs);
    const counts={advanced:rows.filter(r=>r.channel==='advanced').length,voice:rows.filter(r=>r.channel==='voice').length,search:rows.filter(r=>r.channel==='search').length};
    const taskRequests=info.taskId?this.records.filter(r=>r.phase==='start'&&r.taskId===info.taskId&&r.channel==='advanced').length:undefined;
    error.message+=`\n本机该站近60秒实际发出 ${rows.length} 次：文字 ${counts.advanced}、语音建连 ${counts.voice}、搜索 ${counts.search}。${info.round?`本任务文字第 ${info.round} 次请求。`:''}\n本次失败请求不自动重试；本次文字／搜索接口至少冷却60秒。站点限额可能还包含其他客户端或同组账户；本机计数不代表服务端总数。`;
    return {origin,counts,total:rows.length,...(taskRequests!==undefined?{taskRequests}:{}),...(info.round?{round:info.round}:{})};
  }
  private get windowMs(){return this.timing.windowMs??60000;}
  private get minIntervalMs(){return this.timing.minIntervalMs??1000;}
  private endpoint(info:RequestInfo){const u=new URL(info.url);return {origin:u.origin.replace(/^ws/,'http'),path:u.pathname};}
  private group(origin:string,channel:RequestInfo['channel']){const key=origin+'|'+(channel==='voice'?'websocket':'http');let g=this.groups.get(key);if(!g){g={starts:[],lastStart:-Infinity,cooldown:0,busy:false,waiters:[]};this.groups.set(key,g);}g.starts=g.starts.filter(t=>Date.now()-t<this.windowMs);return g;}
  private record(info:RequestInfo,phase:string,extra:any={}){
    const endpoint=this.endpoint(info);const entry={at:new Date().toISOString(),...endpoint,channel:info.channel,source:info.source,model:info.model,...(info.taskId?{taskId:info.taskId}:{}),...(info.round!==undefined?{round:info.round}:{}),phase,...extra};
    this.records.push(entry);if(this.records.length>2000)this.records.splice(0,this.records.length-2000);this.persist();this.emit('record',entry);return entry;
  }
  private check(g:Group,limit:number){const now=Date.now();if(g.cooldown>now)throw new LocalRequestLimit(`该接口正在冷却，请约 ${Math.ceil((g.cooldown-now)/1000)} 秒后再试`);if(g.starts.length>=limit)throw new LocalRequestLimit(`该接口最近 ${this.windowMs/1000} 秒已发出 ${g.starts.length} 次请求，上限 ${limit} 次，请约 ${Math.max(1,Math.ceil((g.starts[0]+this.windowMs-now)/1000))} 秒后再试`);}
  private async lock(g:Group,signal:AbortSignal){signal.throwIfAborted();if(!g.busy){g.busy=true;return;}await new Promise<void>((resolve,reject)=>{const row={resolve:()=>{signal.removeEventListener('abort',row.abort);resolve();},reject,signal,abort:()=>{g.waiters=g.waiters.filter(x=>x!==row);reject(signal.reason||new Error('已取消'));}};g.waiters.push(row);signal.addEventListener('abort',row.abort,{once:true});});}
  private unlock(g:Group){const next=g.waiters.shift();if(next)next.resolve();else g.busy=false;}
  async run<T>(info:RequestInfo,signal:AbortSignal,send:()=>Promise<T>,immediate=false):Promise<T>{
    const {origin}=this.endpoint(info),g=this.group(origin,info.channel),limit=info.limit??this.policy().limit;let locked=false,id='',started=0;
    try{
      this.check(g,limit);if(immediate&&(g.busy||Date.now()-g.lastStart<this.minIntervalMs))throw new LocalRequestLimit(g.busy?'文字接口忙，请稍后手动提交':'文字请求间隔不足，请稍后手动提交');await this.lock(g,signal);locked=true;
      const delay=this.minIntervalMs-(Date.now()-g.lastStart);if(delay>0)await wait(delay,signal);
      signal.throwIfAborted();this.group(origin,info.channel);this.check(g,limit);
      started=Date.now();id=randomUUID();g.starts.push(started);g.lastStart=started;this.record(info,'start',{id});
      const value=await send();this.record(info,'finish',{id,status:'success',durationMs:Date.now()-started});return value;
    }catch(e){
      if(e instanceof ApiFailure&&e.status===429){const retry=Number(e.retryAfter),date=Date.parse(e.retryAfter);g.cooldown=Math.max(g.cooldown,Date.now()+Math.max(this.timing.cooldownMs??60000,Number.isFinite(retry)&&retry>0?retry*1000:Number.isFinite(date)?Math.max(0,date-Date.now()):0));}
      const evidence=e instanceof ApiFailure&&e.status===429?this.failureEvidence(info,e):undefined;
      this.record(info,id?'finish':'blocked',{...(id?{id,durationMs:Date.now()-started}:{}),...(evidence?{localEvidence:evidence}:{}),status:signal.aborted?'cancelled':e instanceof ApiFailure?e.status||'api-error':e instanceof LocalRequestLimit?'local-limit':'error',...(e instanceof ApiFailure?{code:e.code,requestId:e.requestId}:{}),...(g.cooldown>Date.now()?{cooldownUntil:new Date(g.cooldown).toISOString()}:{} )});throw e;
    }finally{if(locked)this.unlock(g);}
  }
  voice(info:RequestInfo){
    const {origin}=this.endpoint(info),g=this.group(origin,'voice');
    try{this.check(g,Infinity);}catch(e){this.record(info,'blocked',{status:'local-limit'});throw e;}
    const id=randomUUID(),started=Date.now();g.starts.push(started);g.lastStart=started;this.record(info,'start',{id});let finished=false;
    return (status:string,httpStatus?:number)=>{if(finished)return;finished=true;if(httpStatus===429)g.cooldown=Math.max(g.cooldown,Date.now()+(this.timing.cooldownMs??60000));this.record(info,'finish',{id,status,...(httpStatus?{httpStatus}:{}),...(g.cooldown>Date.now()?{cooldownUntil:new Date(g.cooldown).toISOString()}:{}),durationMs:Date.now()-started});};
  }
  protocol(info:RequestInfo,event:string,direction:'sent'|'received'){
    if(event==='input_audio_buffer.append'){const second=Math.floor(Date.now()/1000);this.audioSeconds.set(second,(this.audioSeconds.get(second)||0)+1);for(const t of this.audioSeconds.keys())if(second-t>=60)this.audioSeconds.delete(t);return;}
    if(!['session.update','session.updated','conversation.item.create','conversation.item.created','context.update','response.create','response.created','response.done','response.cancel','tool.response','error'].includes(event))return;
    this.record(info,'protocol',{event,direction});
  }
  snapshot(){const now=Date.now(),recent=this.records.filter(r=>now-Date.parse(r.at)<60000),starts=recent.filter(r=>r.phase==='start');return {at:new Date(now).toISOString(),...(this.persistenceWarning?{persistenceWarning:this.persistenceWarning}:{}),counts:{advanced:starts.filter(r=>r.channel==='advanced').length,voice:starts.filter(r=>r.channel==='voice').length,search:starts.filter(r=>r.channel==='search').length},blocked:recent.filter(r=>r.phase==='blocked').length,voiceProtocol:{clientResponseCreates:recent.filter(r=>r.phase==='protocol'&&r.event==='response.create'&&r.direction==='sent').length,serverResponses:recent.filter(r=>r.phase==='protocol'&&r.event==='response.created'&&r.direction==='received').length,sessionUpdates:recent.filter(r=>r.phase==='protocol'&&r.event==='session.update'&&r.direction==='sent').length,audioPackets:[...this.audioSeconds].filter(([t])=>now/1000-t<60).reduce((n,[,count])=>n+count,0)},latest:this.records.slice(-12)};}
}
