import { requestApi, WebApiError } from '../../../apps/web/lib/api';
import { friendlyError } from '../../../apps/web/lib/friendly-error';

describe('web memory transport',()=>{
  const originalFetch=global.fetch;
  afterEach(()=>{global.fetch=originalFetch;});
  test('DELETE remains same-origin and never resubmits automatically',async()=>{
    const fetchMock=jest.fn().mockResolvedValue({ok:true,json:async()=>({deleted:true})});global.fetch=fetchMock;
    await expect(requestApi('sessions/synthetic-session/memories/synthetic-memory',undefined,undefined,undefined,'DELETE')).resolves.toEqual({deleted:true});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/proxy/sessions/synthetic-session/memories/synthetic-memory',expect.objectContaining({method:'DELETE',body:undefined,cache:'no-store'}));
  });
  test('active chat deletion errors are propagated without retry',async()=>{
    const fetchMock=jest.fn().mockResolvedValue({ok:false,status:409,json:async()=>({error:{code:'TURN_ACTIVE'}})});global.fetch=fetchMock;
    await expect(requestApi('sessions/synthetic-session',undefined,undefined,undefined,'DELETE')).rejects.toEqual(new WebApiError('TURN_ACTIVE',409));expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test('maintenance copy is warm and localized',()=>{
    expect(friendlyError('INTAKE_PAUSED','ko')).toContain('잠시 점검 중');
    expect(friendlyError('INTAKE_PAUSED','en')).toContain('maintenance');
    expect(friendlyError('INTAKE_PAUSED','en')).not.toContain('INTAKE_PAUSED');
  });
});
