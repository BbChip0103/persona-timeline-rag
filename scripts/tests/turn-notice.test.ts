import { turnNotice } from '../../apps/web/lib/turn-notice';
import { friendlyError } from '../../apps/web/lib/friendly-error';

const codes=['QUEUE_FULL','QUEUE_TIMEOUT','WORKER_LOST','PROVIDER_REQUEST_UNRESOLVED','PROVIDER_UNAVAILABLE',
  'CONTEXT_LIMIT','TURN_FAILED','TURN_TIMEOUT','INTERNAL_ERROR','API_UNAVAILABLE','INVALID_INPUT',
  'PERSONA_UNAVAILABLE','SEMANTIC_UNAVAILABLE','TURN_ACTIVE','IDEMPOTENCY_CONFLICT','UNAUTHORIZED','NOT_FOUND',
  'BODY_TOO_LARGE','unknown-private-code'];

test('every error has warm Korean and English copy without operator details',()=>{
  for(const code of codes){
    const ko=turnNotice({state:'failed',errorCode:code},'ko');
    const en=turnNotice({state:'failed',errorCode:code},'en');
    expect(ko).toMatch(/[가-힣]/);expect(en).toMatch(/[A-Za-z]/);expect(en).not.toMatch(/[가-힣]/);
    for(const copy of [ko,en])expect(copy).not.toMatch(/QUEUE|WORKER|PROVIDER|CONTEXT|TURN_|INTERNAL|API_|INVALID|SEMANTIC|PERSONA|IDEMPOTENCY|UNAUTHORIZED|NOT_FOUND|BODY_|bill|billing|token|retry id|재전송|과금|요청 ID/i);
  }
  expect(turnNotice({state:'failed',errorCode:'QUEUE_FULL'},'ko')).toBe('지금 대화가 몰려서 조금 뒤에 다시 보내 줘!');
  expect(turnNotice({state:'completed',errorCode:'QUEUE_FULL'})).toBe('');
  expect(turnNotice({state:'cancelled'},'en')).toMatch(/stopped/i);
});

test('request errors use the same private-code-free copy in both languages',()=>{
  for(const code of codes){
    expect(friendlyError(code,'ko')).toBe(turnNotice({state:'failed',errorCode:code},'ko'));
    expect(friendlyError(code,'en')).toBe(turnNotice({state:'failed',errorCode:code},'en'));
  }
});
