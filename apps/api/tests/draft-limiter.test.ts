import {RateLimiterMemory} from 'rate-limiter-flexible';
import {createDraftLimiter} from '../src/draft-limiter';

describe('native per-owner draft admission',()=>{
  beforeEach(()=>{jest.useFakeTimers();jest.setSystemTime(1000);});
  afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();});
  test('native fixed window, owner isolation, rejected requests do not extend expiry',async()=>{
    const consume=jest.spyOn(RateLimiterMemory.prototype,'consume');
    const admit=createDraftLimiter(2);
    await admit('owner-a');await admit('owner-a');
    await expect(admit('owner-a')).rejects.toMatchObject({code:'QUEUE_FULL'});
    await admit('owner-b');
    jest.advanceTimersByTime(59999);
    await expect(admit('owner-a')).rejects.toMatchObject({code:'QUEUE_FULL'});
    jest.advanceTimersByTime(1);await expect(admit('owner-a')).resolves.toBeUndefined();
    expect(consume).toHaveBeenCalledWith('owner-a',1);
  });
  test('concurrent requests cannot exceed quota',async()=>{
    const admit=createDraftLimiter(3);
    const outcomes=await Promise.allSettled(Array.from({length:12},()=>admit('owner-a')));
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(3);
    expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(9);
  });
});
