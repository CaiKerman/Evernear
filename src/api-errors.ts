// Keep protocol failures useful without logging keys, prompts or whole HTML pages.
export interface ErrorHeaders {get(name:string):string|null;}
export function redactDiagnostic(value:string,secrets:string[]=[]){
  let s=value;
  for(const key of secrets.filter(Boolean))for(const variant of [key,encodeURIComponent(key)])s=s.split(variant).join('[已隐藏]');
  return s.replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [已隐藏]')
    .replace(/([?&](?:key|api_key|access_token)=)[^&#\s]+/gi,'$1[已隐藏]')
    .replace(/(["']?(?:api[-_]?key|authorization|access[-_]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s;&}]+)/gi,'$1[已隐藏]')
    .replace(/\bsk-[a-zA-Z0-9_-]{6,}/g,'[已隐藏]');
}
const string=(v:unknown)=>typeof v==='string'?v:typeof v==='number'?String(v):'';
export class ApiFailure extends Error {
  readonly status?:number;readonly code:string;readonly requestId:string;readonly retryAfter:string;
  constructor(status:number|undefined,payload:any,headers?:ErrorHeaders,secrets:string[]=[]){
    const error=payload?.error??payload;
    let message=typeof error==='string'?error:string(error?.message)||string(payload?.message)||string(payload?.msg)||string(error?.detail);
    const clean=(s:string,max:number)=>redactDiagnostic(s,secrets).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
    // A proxy may return an HTML error page rather than JSON. Show its title,
    // not scripts, page markup, tracking parameters or an entire response body.
    if(/^\s*</.test(message))message=message.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]||'服务端返回 HTML 错误页';
    message=clean(message,600);
    const code=clean(string(error?.code)||string(error?.type)||string(payload?.code),80);
    const requestId=clean(headers?.get('x-request-id')||headers?.get('x-oneapi-request-id')||headers?.get('request-id')||headers?.get('x-tt-logid')||string(error?.request_id)||string(payload?.request_id),120);
    const retryAfter=clean(headers?.get('retry-after')||'',80);
    const clue=(code+' '+message).toLowerCase();
    const quota=/insufficient_quota|quota_exceeded|insufficient.balance|insufficient.credit|billing|spend.limit|余额不足|额度不足|配额不足|欠费/.test(clue);
    const rpm=message.match(/(?:1|一)\s*分钟[^。；;\n]{0,30}?(?:最多请求|最多|上限(?:为)?)\s*(\d+)\s*次/);
    const hint=status&&status>=300&&status<400?'接口返回重定向，已停止自动跟随以避免隐式重复请求；请填写服务方提供的最终 HTTPS API 地址。':status===429?(quota?'额度或余额不足，请查看中转站 / 厂商账户额度。':rpm?`服务端明确限制每分钟 ${rpm[1]} 次请求；该限额的统计范围由服务端决定，不等同于本机发出的次数。`:'请求频率、并发或上游负载受限；具体原因以服务端信息为准。'):
      status&&status>=500?'中转站或上游服务处理失败；持续出现时请将请求编号交给服务方排查。':
      status===401?'鉴权失败，请核对该服务的密钥。':status===403?'访问被拒绝，请核对模型权限与令牌分组。':
      status===404?'接口路径或模型资源不存在，请核对地址和模型名称。':status===400||status===422?'请求被拒绝，请依据服务端信息核对参数与模型兼容性。':'';
    super([status?`接口返回 HTTP ${status}`:'文字接口报告错误',code?'错误码：'+code:'',message?'服务端：'+message:'',requestId?'请求编号：'+requestId:'',retryAfter?'Retry-After（重试等待）：'+retryAfter:'',hint].filter(Boolean).join('\n'));
    this.name='ApiFailure';this.status=status;this.code=code;this.requestId=requestId;this.retryAfter=retryAfter;
  }
}
export async function readFailureBody(body:AsyncIterable<Uint8Array>|null){
  if(!body)return undefined;const chunks:Uint8Array[]=[];let size=0;
  try{for await(const chunk of body){size+=chunk.length;if(size>8192)return {message:'错误正文超过 8 KiB，未展示正文；可凭请求编号联系服务方。'};chunks.push(chunk);}}
  catch{return {message:'读取错误正文失败；可凭请求编号联系服务方。'};}
  const text=Buffer.concat(chunks).toString('utf8').trim();if(!text)return undefined;
  try{return JSON.parse(text);}catch{return /^[{\[]/.test(text)?{message:'服务端错误正文不是完整的 JSON'}:text;}
}
