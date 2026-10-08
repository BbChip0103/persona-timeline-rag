import { createHash, randomBytes } from 'node:crypto';

/**
 * Approximate prefix table (routing , stage S5): what the gateway believes each upstream's prefix cache
 * holds, from its own routing decisions (no engine KV events). Message-boundary granularity: our prompts are built from
 * whole messages (policy, persona, state, history), so a coarse SGLang-radix / llm-d-approximate equivalent suffices.
 */
export interface ChainHash {
  /** H_k = sha256(salt ‖ message 1 ‖ … ‖ message k), each message length-prefixed (role, content); first 128 bits. */
  hash:string;
  /** Cumulative token estimate of messages 1..k: ceil(bytes / bytes-per-token), the same rule as T̂ and G. */
  tokens:number;
}
/**
 * Per-process random salt: the hashes (kept in memory, and the route log's request-key hash) cannot be checked against
 * guessed content or keys. They only need to agree within one gateway process.
 */
export const HASH_SALT=randomBytes(16);
/** H_1..H_{m−1}: every message but the last (the new user turn is never a cached prefix). One running hash, copied per k. */
export function chainHashes(messages:{role:string;content:string}[],bytesPerToken:number):ChainHash[] {
  const out:ChainHash[]=[], running=createHash('sha256').update(HASH_SALT);let bytes=0;
  for(const message of messages.slice(0,-1)) {
    const length=Buffer.byteLength(message.content,'utf8');
    // Length prefixes make the boundaries unambiguous whatever the content holds (NUL bytes included).
    running.update(`${Buffer.byteLength(message.role,'utf8')}:${message.role}${length}:`).update(message.content,'utf8');
    bytes+=length;
    out.push({hash:running.copy().digest('hex').slice(0,32),tokens:Math.ceil(bytes/bytesPerToken)});
  }
  return out;
}

export interface PrefixTableOptions {
  /** PTR_GATEWAY_PREFIX_TTL_MS (120000, Dynamo's approximate-mode default): an entry not seen for longer is gone. */
  ttlMs:number;
  /**
   * The upstream's KV capacity in tokens (null = unknown): the own tokens of the resident entries (each H_k counts the
   * tokens of message k only, so a shared prefix counts once) stay within it, like the engine's prefix cache.
   */
  capacityTokens:()=>number|null;
  /** Hard bound on entries (always applies; alone when the capacity is unknown). */
  maxEntries:number;
  now:()=>number;
}
/** One upstream's table: an LRU (Map insertion order = last seen) of H_k → its own tokens and last-seen time. */
export class PrefixTable {
  private readonly entries=new Map<string,{own:number;seen:number}>();
  private tokens=0;private cleared=0;
  constructor(private readonly options:PrefixTableOptions) {}
  /** The cumulative tokens of the longest fresh H_k of this request in the table (0 = none). */
  match(chain:ChainHash[]):number {
    const now=this.options.now();
    for(let k=chain.length-1;k>=0;k--) {
      const entry=this.entries.get(chain[k]!.hash);
      if(entry&&now-entry.seen<=this.options.ttlMs) return chain[k]!.tokens;
    }
    return 0;
  }
  /**
   * The request was sent to this upstream: its prefixes will be cached there. Recorded tail first so the request's
   * longest prefixes are the least recently seen and evicted first (vLLM frees a sequence's tail blocks first).
   */
  record(chain:ChainHash[]):void {
    const now=this.options.now();
    for(let k=chain.length-1;k>=0;k--) {
      const {hash,tokens}=chain[k]!, own=tokens-(k?chain[k-1]!.tokens:0), old=this.entries.get(hash);
      if(old) {this.entries.delete(hash);this.tokens-=old.own;}
      this.entries.set(hash,{own,seen:now});this.tokens+=own;
    }
    const capacity=this.options.capacityTokens();
    for(const [hash,entry] of this.entries) {
      const expired=now-entry.seen>this.options.ttlMs;
      if(!expired&&this.entries.size<=this.options.maxEntries&&(capacity===null||this.tokens<=capacity)) break;
      this.entries.delete(hash);this.tokens-=entry.own;
    }
  }
  /** The engine lost its cache (breaker opened, restart) or this table can no longer be trusted. */
  clear():void {this.entries.clear();this.tokens=0;this.cleared++;}
  metrics():{entries:number;tokens:number;cleared:number} {return {entries:this.entries.size,tokens:this.tokens,cleared:this.cleared};}
}
