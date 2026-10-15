/** Split a reply only at sentence ends; keep all text and render at most three bubbles. */
export function splitReplyBubbles(content:string):string[] {
  const text=content.trim();
  if(!text)return [];
  const starts=[0];
  const sentences:string[]=[];
  for(let index=0;index<text.length;index++) {
    const char=text[index];
    if(char!=='.'&&char!=='!'&&char!=='?'&&char!=='。'&&char!=='！'&&char!=='？'&&char!=='\n')continue;
    if(char==='.'&&/\d/u.test(text[index-1]??'')&&/\d/u.test(text[index+1]??''))continue;
    while(/[.!?。！？”’"']/u.test(text[index+1]??''))index++;
    const end=index+1;
    const sentence=text.slice(starts.at(-1),end).trim();
    if(sentence){sentences.push(sentence);starts.push(end);}
  }
  const tail=text.slice(starts.at(-1)).trim();
  if(tail)sentences.push(tail);
  if(sentences.length<=3)return sentences;
  return [sentences[0]!,sentences[1]!,text.slice(starts[2]).trim()];
}
