import type { ProviderMessage } from '@ptr/contracts';

/**
 * The 24 added special tokens of the deployed Gemma 4 tokenizer (tokenizer.json `added_tokens`, all `special`, read on
 * the GPU host 2026-10-09). The tokenizer parses them out of raw text, so inside message content they become real
 * control tokens: `<|turn>system …` in a user message opens a forged system turn (S8 gate a, vLLM /tokenize).
 */
export const GEMMA4_SPECIAL_TOKENS=['<pad>','<eos>','<bos>','<unk>','<mask>','<|tool>','<tool|>','<|tool_call>','<tool_call|>','<|tool_response>','<tool_response|>',
  '<|"|>','<|think|>','<|channel>','<channel|>','<|turn>','<turn|>','<|image>','<|audio>','<|image|>','<|audio|>','<image|>','<audio|>','<|video|>'] as const;
/**
 * Every Gemma 4 token above through the generic `<|x>` / `<x|>` / `<|x|>` shapes (future tokens included), the named
 * `<bos>`-style tokens, the legacy Gemma ≤3 family (`<start_of_turn>`, …) and other common chat-template markers
 * (`<s>`, `<<SYS>>`, `[INST]`). Case-insensitive: neutralizing a harmless variant costs nothing. `‹` is excluded from the
 * inner classes so a second pass never re-matches an already neutralized token (`<<turn|>` → `<‹turn|>`).
 */
const CONTROL=/<\|[^<>\s|‹]{0,40}\|?>|<[^<>\s|‹]{1,40}\|>|<\/?(?:bos|eos|pad|unk|mask|s|start_of_turn|end_of_turn|start_of_image|end_of_image|image_soft_token|audio_soft_token)>|<<\/?SYS>>|\[\/?INST\]/gi;
/**
 * Neutralize chat-template control strings in text bound for a model: the opening `<` becomes `‹` (U+2039; `[` becomes
 * `［`), so the text stays readable but can no longer be parsed as a special token. Deterministic and idempotent; text
 * without such strings is returned unchanged, so prompt bytes (prefix caching, ledger keys) do not move for it.
 */
export function neutralizeControlTokens(text:string):string {
  if(!text.includes('<')&&!text.includes('[')) return text;
  return text.replace(CONTROL,match=>match.startsWith('[')?`［${match.slice(1)}`:`‹${match.slice(1)}`);
}
export function neutralizeMessages(messages:readonly ProviderMessage[]):ProviderMessage[] {
  return messages.map(({role,content})=>({role,content:neutralizeControlTokens(content)}));
}
/** String leaves of a JSON value (decision request state), structure unchanged. */
export function neutralizeJsonStrings<T>(value:T):T {
  if(typeof value==='string') return neutralizeControlTokens(value) as T;
  if(Array.isArray(value)) return value.map(item=>neutralizeJsonStrings(item)) as T;
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,neutralizeJsonStrings(item)])) as T;
  return value;
}
