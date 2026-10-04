import { AgentResponseSchema, AgentVariablesSchema, parseAgentResponse } from '../src/agent-protocol';
import { CoreError } from '../src/ports';

const final = { message: 'Synthetic response.', status: 'answered', evidenceRefs: [], variableUpdates: {} };
const tool = { ...final, message: '', function: { name: 'timeline_search', arguments: { query: 'Synthetic ceramic class' } } };
const parse = (value: unknown) => parseAgentResponse(JSON.stringify(value));
function rejects(value: unknown): void {
  try { parse(value); throw new Error('Expected parse rejection'); }
  catch (error) { expect(error).toBeInstanceOf(CoreError); expect(error).toMatchObject({ code: 'TURN_FAILED', message: 'TURN_FAILED' }); }
}
test('final responses preserve allowed fields and parsing is idempotent without coercion', () => {
  const value = { ...final, reasoning: 'Answer using the supplied synthetic record.', variableUpdates: { conversationTopic: 'ceramics', tone: 'warm' },
    evidenceRefs: [{ sourceId: 'synthetic-post', annotationId: 'synthetic-image', quote: 'Synthetic quote.' }] };
  expect(parse(value)).toEqual(value); expect(parse(parse(value))).toEqual(value); expect(AgentResponseSchema.parse(value)).toEqual(value);
  for (const status of ['answered', 'insufficient_evidence', 'needs_clarification', 'out_of_scope']) expect(parse({ ...final, status }).status).toBe(status);
});
test('initial defaults are distinct from empty updates and state is strict', () => {
  expect(AgentVariablesSchema.parse({})).toEqual({ conversationTopic: '', tone: 'neutral' });
  expect(AgentVariablesSchema.parse(undefined)).toEqual({ conversationTopic: '', tone: 'neutral' });
  expect(parse({ message: 'Hello.', status: 'answered', evidenceRefs: [] }).variableUpdates).toEqual({});
  expect(parse({ ...final, variableUpdates: { tone: 'playful' } }).variableUpdates).toEqual({ tone: 'playful' });
  expect(AgentVariablesSchema.safeParse({ ownerId: 'synthetic' }).success).toBe(false);
  expect(AgentVariablesSchema.safeParse({ conversationTopic: 'x'.repeat(201) }).success).toBe(false);
  expect(AgentVariablesSchema.safeParse({ tone: 'angry' }).success).toBe(false);
});
test('pending function requires empty message and no evidence; final needs real content', () => {
  expect(parse(tool).function).toEqual(tool.function);
  for (const message of ['', ' ', '\n\t']) rejects({ ...final, message });
  rejects({ ...tool, message: 'Still answering.' }); rejects({ ...tool, message: ' ' });
  rejects({ ...tool, evidenceRefs: [{ sourceId: 'synthetic', quote: 'Synthetic' }] });
});
test('query is trimmed and bounded by Unicode codepoints rather than UTF16 units', () => {
  expect(parse({ ...tool, function: { ...tool.function, arguments: { query: '  Synthetic query\n' } } }).function?.arguments.query).toBe('Synthetic query');
  const query = '🧪'.repeat(500); expect(parse({ ...tool, function: { ...tool.function, arguments: { query } } }).function?.arguments.query).toBe(query);
  rejects({ ...tool, function: { ...tool.function, arguments: { query: '🧪'.repeat(501) } } });
  for (const query of ['', ' \n ', 42, null]) rejects({ ...tool, function: { ...tool.function, arguments: { query } } });
});
test('unknown keys, tools and state fields are rejected at every nested boundary', () => {
  for (const key of ['answer', 'sessionId', 'ownerId', 'personId', 'sourceContext', 'toolCalls', 'memory']) rejects({ ...final, [key]: 'synthetic' });
  rejects({ ...final, variableUpdates: { ownerId: 'synthetic' } });
  rejects({ ...tool, function: { ...tool.function, extra: true } });
  rejects({ ...tool, function: { name: 'web_search', arguments: tool.function.arguments } });
  rejects({ ...tool, function: { ...tool.function, arguments: { query: 'Synthetic', personId: 'synthetic' } } });
  rejects({ ...final, evidenceRefs: [{ sourceId: 'synthetic', quote: 'Synthetic', start: 0 }] });
});
test('wrong types, missing fields, oversized fields and evidence lists fail without coercion', () => {
  for (const key of ['message', 'status', 'evidenceRefs']) { const value: Record<string, unknown> = { ...final }; delete value[key]; rejects(value); }
  for (const change of [{ message: 7 }, { status: 'success' }, { evidenceRefs: null }, { variableUpdates: null }, { reasoning: 2 }, { function: null },
    { message: 'x'.repeat(8001) }, { reasoning: 'x'.repeat(161) }, { variableUpdates: { conversationTopic: 'x'.repeat(201) } }, { variableUpdates: { tone: 'cold' } }]) rejects({ ...final, ...change });
  const ref = { sourceId: 'synthetic', quote: 'Synthetic' };
  rejects({ ...final, evidenceRefs: [ref, ref, ref] });
  for (const change of [{ sourceId: '' }, { sourceId: 'x'.repeat(201) }, { sourceId: 42 }, { quote: '' }, { quote: 'x'.repeat(97) }, { annotationId: '' }, { annotationId: 'x'.repeat(201) }])
    rejects({ ...final, evidenceRefs: [{ ...ref, ...change }] });
  expect(parse({ ...final, message: 'x'.repeat(180), reasoning: 'x'.repeat(160), variableUpdates: { conversationTopic: 'x'.repeat(200) },
    evidenceRefs: [{ sourceId: 'x'.repeat(200), annotationId: 'x'.repeat(200), quote: 'x'.repeat(96) }] }).message).toHaveLength(180);
});
test('malformed JSON, fenced output, nonobjects and oversized raw bytes fail with sanitized errors', () => {
  for (const raw of ['{', '```json\n' + JSON.stringify(final) + '\n```', JSON.stringify(final) + '\ntrailing', '', 'null', '[]', '42', 'true', '"synthetic"', ' '.repeat(65537)])
    expect(() => parseAgentResponse(raw)).toThrow('TURN_FAILED');
  // Size is measured in UTF8 bytes, including legal insignificant whitespace.
  const raw = JSON.stringify(final) + ' '.repeat(65536 - Buffer.byteLength(JSON.stringify(final)));
  expect(parseAgentResponse(raw)).toEqual(final); expect(() => parseAgentResponse(raw + ' ')).toThrow(CoreError);
  expect(() => parseAgentResponse(undefined as unknown as string)).toThrow(CoreError);
});
test('credential patterns anywhere are rejected including escaped decoded strings', () => {
  const secret = 'synthetic-credential';
  for (const value of [{ ...final, message: secret }, { ...final, reasoning: 'Bearer synthetic-token' },
    { ...final, variableUpdates: { conversationTopic: 'password=synthetic' } },
    { ...final, evidenceRefs: [{ sourceId: secret, quote: 'Synthetic' }] },
    { ...tool, function: { ...tool.function, arguments: { query: 'api_key: synthetic' } } }]) rejects(value);
  const raw = JSON.stringify({ ...final, message: secret }).replace('sk-', '\\u0073\\u006b\\u002d');
  expect(() => parseAgentResponse(raw)).toThrow('TURN_FAILED');
  const whitespace = JSON.stringify({ ...final, message: 'Bearer\nsynthetic-token' });
  expect(() => parseAgentResponse(whitespace)).toThrow('TURN_FAILED');
});


test('final message hard180Unicode bound and tool updates cannot mutate state',()=>{
  const base={message:'😀'.repeat(180),status:'answered',evidenceRefs:[],variableUpdates:{}};
  expect(parseAgentResponse(JSON.stringify(base)).message).toBe(base.message);
  expect(()=>parseAgentResponse(JSON.stringify({...base,message:'😀'.repeat(181)}))).toThrow(CoreError);
  expect(()=>parseAgentResponse(JSON.stringify({...base,message:'',variableUpdates:{tone:'warm'},function:{name:'timeline_search',arguments:{query:'synthetic'}}}))).toThrow(CoreError);
});
