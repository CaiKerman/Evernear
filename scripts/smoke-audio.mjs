import fs from 'node:fs';
import path from 'node:path';
// Native fake microphone defaults to a continuous tone. Use silence so tests can
// exercise a genuine sentence boundary without bypassing the local PCM guard.
export function silentMicrophone(folder) {
  const pcm=Buffer.alloc(16000*2*8),header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  const file=path.join(folder,'fake-microphone.wav');fs.writeFileSync(file,Buffer.concat([header,pcm]));return '--use-file-for-fake-audio-capture='+file;
}
