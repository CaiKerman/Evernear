// Keep full text in the conversation. Only normalize its spoken representation.
// Short consecutive requests share one speaker transport, rather than creating
// one WebSocket for every paragraph of a long reasoning result.
export function speechChunks(text:string,limit=350):string[]{
  const plain=text.replace(/```[^\n]*\n?/g,'').replace(/\[([^\]]+)\]\([^\s)]+\)/g,'$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/\*\*|__|`/g,'')
    .replace(/^\s*[-*+]\s+/gm,'').replace(/^\s*\|?\s*:?-{3,}.*$/gm,'').replace(/\|/g,'，').trim();
  const chunks:string[]=[];let current='';
  for(const part of plain.split(/(?<=[。！？!?；;\n])/u)){
    for(const section of part.match(new RegExp(`[\\s\\S]{1,${limit}}`,'gu'))||[]){
      if(Array.from(current+section).length>limit){if(current.trim())chunks.push(current.trim());current='';}
      current+=section;
    }
  }
  if(current.trim())chunks.push(current.trim());return chunks;
}
