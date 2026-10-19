// Streaming box-filter resampling preserves phase across worklet callbacks.
// 16 kHz mono PCM is accumulated into 40 ms packets; no raw recording is saved.
class AmbientCapture extends AudioWorkletProcessor {
  constructor(){super();this.ratio=sampleRate/16000;this.phase=0;this.sum=0;this.count=0;this.packet=new Int16Array(640);this.offset=0;}
  process(inputs,outputs){const data=inputs[0]?.[0];if(!data)return true;
    let energy=0;
    for(let i=0;i<data.length;i++){
      const x=data[i];energy+=x*x;this.sum+=x;this.count++;this.phase++;
      if(this.phase>=this.ratio){this.phase-=this.ratio;const y=Math.max(-1,Math.min(1,this.sum/this.count));this.sum=0;this.count=0;
        this.packet[this.offset++]=y<0?y*32768:y*32767;
        if(this.offset===640){const buffer=this.packet.buffer;this.port.postMessage({type:'pcm',buffer},[buffer]);this.packet=new Int16Array(640);this.offset=0;}
      }
    }
    this.port.postMessage({type:'level',value:Math.sqrt(energy/data.length)});
    return true;
  }
}
registerProcessor('ambient-capture',AmbientCapture);
