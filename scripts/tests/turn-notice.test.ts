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
