import { createHash } from 'node:crypto';
import type { ProviderMessage } from '@ptr/contracts';
import type { TextProvider } from '@ptr/core';
import { ProviderError } from './budget';
import { EMBEDDING_DIMENSIONS } from './openrouter';

/** Synthetic deterministic behavior only; never asserts actual biography or activities. */
export class FakeTextProvider implements TextProvider {
  calls=0;
  async generate(messages:ProviderMessage[],options:{signal:AbortSignal;onServed?:(upstream:string)=>void}):Promise<string> {
    if(options.signal.aborted) throw new ProviderError('CANCELLED');
    this.calls++;
    // Recorded in reply.serving, so turns answered by the fake model are never mistaken for real ones.
    options.onServed?.('fake');
    if(messages.some(message=>message.role==='system'&&message.content.includes('AGENT_JSON_REPLY'))) {
      const input=messages.find(message=>message.role==='user'&&message.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '));
      let data:unknown=[];try{data=input?JSON.parse(input.content.slice('UNTRUSTED_EVIDENCE_JSON_DATA '.length)):[];}catch{/* No synthetic evidence on malformed context. */}
      const source=Array.isArray(data)?data.find(value=>value&&typeof value.sourceId==='string'&&typeof value.quoteCandidate==='string'&&value.quoteCandidate):undefined;
      return JSON.stringify({status:source?'answered':'insufficient_evidence',message:source?'합성 자료의 캡션을 참고해 이야기해요.':'연구용 AI 시뮬레이션이에요. 편하게 이야기해 주세요.',evidenceRefs:source?[{sourceId:source.sourceId,quote:source.quoteCandidate}]:[],variableUpdates:{}});
    }
    if(messages.some(message=>message.role==='system'&&message.content.includes('TIMELINE_JSON_REPLY'))) {
      const input=messages.find(message=>message.role==='user'&&message.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '));
      let sources:unknown=[];
      try { sources=input?JSON.parse(input.content.slice('UNTRUSTED_EVIDENCE_JSON_DATA '.length)):[]; } catch { /* No fabricated evidence. */ }
      const source=Array.isArray(sources)?sources.find(value=>value&&typeof value.sourceId==='string'&&typeof value.caption==='string'&&value.caption.length):undefined;
      if(source) return JSON.stringify({status:'answered',answer:'',evidenceRefs:[{sourceId:source.sourceId,quote:source.caption}]});
      return JSON.stringify({status:'insufficient_evidence',answer:'',evidenceRefs:[]});
    }
    const last=messages.filter(message=>message.role==='user').at(-1)?.content??'';
    const variant=createHash('sha256').update(last).digest()[0]!%3;
    return ['이 대화는 연구용 AI 시뮬레이션이에요. 어떤 이야기를 나눠 볼까요?','좋아요! 편하게 이야기해 주세요. 실제 활동에 대한 확인은 별도의 자료가 필요해요.','반가워요! 연구용 AI 페르소나와 천천히 대화를 이어 가요.'][variant]!;
  }
}
export class FakeEmbeddingProvider {
  readonly model='synthetic/hash-1536-v1';
  readonly dimensions=EMBEDDING_DIMENSIONS;
  calls=0;
  async embed(inputs:string[],options:{signal:AbortSignal}):Promise<number[][]> {
    if(options.signal.aborted) throw new ProviderError('CANCELLED');
    this.calls++;
    return inputs.map(input=>{
      const bytes=createHash('sha256').update(input).digest();
      const vector=Array.from({length:this.dimensions},(_,index)=>(bytes[index%bytes.length]!-127.5)/127.5);
      const norm=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0));
      return vector.map(value=>value/norm);
    });
  }
}
