import { draftAttemptFor } from '../../web/lib/draft-attempt';
test('transport retry reuses the billing request id, while changed input, session or a settled attempt gets a new id',()=>{
  const id=jest.fn().mockReturnValueOnce('first').mockReturnValueOnce('second').mockReturnValueOnce('third').mockReturnValueOnce('fourth');
  const first=draftAttemptFor(undefined,'synthetic_session_a','synthetic brief',id);
  expect(first.clientRequestId).toBe('first');
  expect(draftAttemptFor(first,'synthetic_session_a','synthetic brief',id)).toBe(first);expect(id).toHaveBeenCalledTimes(1);
  expect(draftAttemptFor(first,'synthetic_session_a','changed brief',id).clientRequestId).toBe('second');
  expect(draftAttemptFor(first,'synthetic_session_b','synthetic brief',id).clientRequestId).toBe('third');
  expect(draftAttemptFor(undefined,'synthetic_session_a','synthetic brief',id).clientRequestId).toBe('fourth');
});
