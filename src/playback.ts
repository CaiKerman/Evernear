// PCM playback is driven by the audio clock, independently of window painting.
export interface Delivery { id:string; delivery:'heard'|'partial'|'unheard'; heardMs:number; durationMs:number; }
interface Playback { id:string; sources:AudioBufferSourceNode[]; start:number; end:number; duration:number; done:boolean; count:number; }
export class PcmPlayer {
  private context?:AudioContext;
  private preparing?:Promise<AudioContext>;
  private sink='';
  private epoch=0;
  private chain=Promise.resolve();
  private playing=new Map<string,Playback>();
  private pending=new Set<string>();
  private monitor?:ReturnType<typeof setInterval>;
  private clock=0;
  private progressAt=0;
  constructor(private output:()=>string,private delivered:(p:Delivery)=>void,private failed:(e:unknown)=>void,
    private create:()=>AudioContext=()=>new AudioContext({sampleRate:24000}),private timeoutMs=4000){}

  private async bounded<T>(operation:Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('音频设备未能恢复，请检查输出设备后暂停并重新开始')),this.timeoutMs);})]);}
    finally{clearTimeout(timer);}
  }
  prepare():Promise<AudioContext>{
    if(this.preparing)return this.preparing;
    const operation=(async()=>{
      if(!this.context||this.context.state==='closed'){
        this.context=this.create();this.sink='';
        this.context.onstatechange=()=>{if(this.pending.size)this.wake();};
      }
      const ctx=this.context;
      // setSinkId can interrupt output. Apply it only when the selection changes.
      const sink=this.output();
      if(sink!==this.sink){
        const selectable=ctx as AudioContext&{setSinkId?:(id:string)=>Promise<void>};
        if(!selectable.setSinkId)throw new Error('当前音频环境不支持选择输出设备');
        await this.bounded(selectable.setSinkId(sink));this.sink=sink;
      }
      if(ctx.state!=='running')await this.bounded(ctx.resume());
      return ctx;
    })();
    this.preparing=operation;
    void operation.finally(()=>{if(this.preparing===operation)this.preparing=undefined;}).catch(()=>{});
    return operation;
  }
  wake(){
    if(!this.pending.size)return;
    const epoch=this.epoch;
    void this.prepare().catch(e=>this.fail(e,epoch));
  }
  enqueue(event:{turnId:string;audio:string;sampleRate?:number}){
    const epoch=this.epoch;this.pending.add(event.turnId);
    this.chain=this.chain.then(async()=>{
      if(epoch!==this.epoch)return;
      const ctx=await this.prepare();
      // An interrupt can arrive while resume() or setSinkId() is pending.
      if(epoch!==this.epoch)return;
      const binary=atob(event.audio),view=new DataView(new ArrayBuffer(binary.length));
      for(let i=0;i<binary.length;i++)view.setUint8(i,binary.charCodeAt(i));
      const samples=new Float32Array(Math.floor(binary.length/2));
      for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
      if(!samples.length)return;
      const buffer=ctx.createBuffer(1,samples.length,event.sampleRate||24000);buffer.copyToChannel(samples,0);
      let p=this.playing.get(event.turnId);
      if(!p){const start=ctx.currentTime+.055;p={id:event.turnId,sources:[],start,end:start,duration:0,done:false,count:0};this.playing.set(p.id,p);}
      const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);
      const start=Math.max(ctx.currentTime+.008,p.end);p.end=start+buffer.duration;p.duration+=buffer.duration;p.count++;p.sources.push(source);
      const ref=p;source.onended=()=>{source.disconnect();ref.count--;if(ref.done&&ref.count===0)this.finish(ref);};source.start(start);
      if(!this.monitor){this.clock=ctx.currentTime;this.progressAt=Date.now();this.monitor=setInterval(()=>this.checkClock(),1000);}
    }).catch(e=>this.fail(e,epoch));
  }
  end(id:string){
    const epoch=this.epoch;
    this.chain=this.chain.then(()=>{
      if(epoch!==this.epoch)return;
      const p=this.playing.get(id);
      if(!p){if(this.pending.delete(id))this.delivered({id,delivery:'unheard',heardMs:0,durationMs:0});return;}
      p.done=true;if(p.count===0)this.finish(p);
    }).catch(e=>this.fail(e,epoch));
  }
  private finish(p:Playback){
    if(!this.playing.delete(p.id))return;
    this.pending.delete(p.id);this.delivered({id:p.id,delivery:'heard',heardMs:Math.round(p.duration*1000),durationMs:Math.round(p.duration*1000)});
    if(!this.playing.size)this.clearMonitor();
  }
  private checkClock(){
    const ctx=this.context;if(!ctx||!this.playing.size)return;
    if(ctx.currentTime>this.clock){this.clock=ctx.currentTime;this.progressAt=Date.now();}
    if(Date.now()-this.progressAt>5000){this.fail(new Error('音频播放时钟已停止，请检查输出设备后暂停并重新开始'),this.epoch);return;}
    if(ctx.state!=='running')this.wake();
  }
  private clearMonitor(){clearInterval(this.monitor);this.monitor=undefined;}
  private fail(e:unknown,epoch:number){
    if(epoch!==this.epoch)return;
    this.interrupt();
    const old=this.context;this.context=undefined;this.preparing=undefined;
    if(old){old.onstatechange=null;void old.close().catch(()=>{});}
    this.failed(e);
  }
  interrupt(){
    this.epoch++;this.chain=Promise.resolve();this.clearMonitor();
    for(const id of this.pending){
      const p=this.playing.get(id),heard=p?Math.min(p.duration,Math.max(0,(this.context?.currentTime||0)-p.start)):0;
      for(const source of p?.sources||[]){source.onended=null;try{source.stop();source.disconnect();}catch{}}
      this.delivered({id,delivery:heard>0?'partial':'unheard',heardMs:Math.round(heard*1000),durationMs:Math.round((p?.duration||0)*1000)});
    }
    this.pending.clear();this.playing.clear();
  }
}
