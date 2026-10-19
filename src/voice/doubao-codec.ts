import { gunzipSync } from 'node:zlib';
const int=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
export function encodeDoubao(event:number,payload:unknown={},sessionId='',type=1){
  const raw=Buffer.isBuffer(payload),body=raw?payload:Buffer.from(JSON.stringify(payload));
  const fields:Buffer[]=[Buffer.from([0x11,(type<<4)|4,raw?0:0x10,0]),int(event)];
  if(event>=100){const id=Buffer.from(sessionId);fields.push(int(id.length),id);}
  fields.push(int(body.length),body);return Buffer.concat(fields);
}
export function decodeDoubao(data:Buffer){
  if(data.length<8||data.length>8*1024*1024)throw new Error('豆包二进制帧长度无效');
  const version=data[0]>>4,header=(data[0]&15)*4,type=data[1]>>4,flags=data[1]&15,serialization=data[2]>>4,compression=data[2]&15;
  if(version!==1||header<4||header>data.length||![0,1].includes(serialization)||![0,1].includes(compression))throw new Error('不支持的豆包二进制帧格式');
  let offset=header,code:number|undefined,event=0,sessionId='';
  const read=()=>{if(offset+4>data.length)throw new Error('豆包二进制帧被截断');const n=data.readUInt32BE(offset);offset+=4;return n;};
  if(type===15)code=read();
  if(flags&1)read();
  if(flags&4)event=read();
  if(event>=100){const length=read();if(length>16384||offset+length>data.length)throw new Error('豆包会话标识无效');sessionId=data.subarray(offset,offset+length).toString();offset+=length;}
  else if([50,51,52].includes(event)){
    // Connect acknowledgments may carry a connection ID before the payload.
    const length=offset+4<=data.length?data.readUInt32BE(offset):0;
    if(length<=16384&&offset+8+length<=data.length&&offset+8+length+data.readUInt32BE(offset+4+length)===data.length){offset+=4;sessionId=data.subarray(offset,offset+length).toString();offset+=length;}
  }
  const size=read();if(size!==data.length-offset)throw new Error('豆包负载长度与帧不符');
  const body=compression===1?gunzipSync(data.subarray(offset),{maxOutputLength:8*1024*1024}):data.subarray(offset);
  return {type,flags,event,sessionId,code,body,json:serialization===1?JSON.parse(body.toString()):undefined};
}
