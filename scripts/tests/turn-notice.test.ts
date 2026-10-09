import { turnNotice } from '../../apps/web/lib/turn-notice';
test('unresolved and missing provider responses stay explicit service notices without retry advice',()=>{
  expect(turnNotice({state:'failed',errorCode:'PROVIDER_REQUEST_UNRESOLVED'})).toContain('같은 요청을 다시 제출하지 않았어요');
  expect(turnNotice({state:'failed',errorCode:'PROVIDER_UNAVAILABLE'})).toContain('이전 메시지는 유지');
  for(const code of ['PROVIDER_REQUEST_UNRESOLVED','PROVIDER_UNAVAILABLE']){
    const value=turnNotice({state:'failed',errorCode:code});expect(value).toContain('자동 재전송하지');expect(value).not.toContain('기억');
  }
});
test('unknown codes are never surfaced; ordinary complete/cancel and context-limit states keep distinct wording',()=>{
  expect(turnNotice({state:'failed',errorCode:'private-path-and-key'})).toBe('생성에 실패했습니다. 자동 재전송하지 않았습니다.');
  expect(turnNotice({state:'completed',errorCode:'PROVIDER_REQUEST_UNRESOLVED'})).toBe('');
  expect(turnNotice({state:'cancelled'})).toContain('취소');expect(turnNotice({state:'failed',errorCode:'CONTEXT_LIMIT'})).toContain('새 대화');
});
test('QUEUE_TIMEOUT (no worker started the turn in time) is a friendly try-again line in the session language, never system jargon',()=>{
  const korean=turnNotice({state:'failed',errorCode:'QUEUE_TIMEOUT'},'ko');
  expect(korean).toContain('잠시 후 다시 시도해 주세요');
  expect(turnNotice({state:'failed',errorCode:'QUEUE_TIMEOUT'})).toBe(korean); // the Korean UI default
  const english=turnNotice({state:'failed',errorCode:'QUEUE_TIMEOUT'},'en');
  expect(english).toMatch(/try again in a moment/i);expect(english).not.toMatch(/[가-힣]/);
  for(const value of [korean,english]) expect(value).not.toMatch(/QUEUE|TIMEOUT|queue|worker|timeout|큐|워커|타임아웃|대기열/);
});
test('WORKER_LOST (the worker died mid-turn) is a friendly temporary-problem line in the session language, never system jargon',()=>{
  const korean=turnNotice({state:'failed',errorCode:'WORKER_LOST'},'ko');
  expect(korean).toContain('잠시 후 다시 시도해 주세요');expect(korean).toContain('일시적');
  expect(turnNotice({state:'failed',errorCode:'WORKER_LOST'})).toBe(korean);
  const english=turnNotice({state:'failed',errorCode:'WORKER_LOST'},'en');
  expect(english).toMatch(/temporary problem/i);expect(english).toMatch(/try again/i);expect(english).not.toMatch(/[가-힣]/);
  for(const value of [korean,english]) expect(value).not.toMatch(/WORKER|LOST|\bworker|\blease\b|\blost\b|워커|리스|유실/);
});
