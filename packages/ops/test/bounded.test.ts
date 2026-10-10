import {bounded} from '../src/bounded';

describe('native RxJS bounded lifecycle',()=>{
  beforeEach(()=>jest.useFakeTimers());afterEach(()=>jest.useRealTimers());
  test('captures synchronous failure and finalizes the controller',async()=>{
    let signal:AbortSignal|undefined;
    await expect(bounded(s=>{signal=s;throw new Error('synthetic');},10)).rejects.toThrow('synthetic');
    expect(signal?.aborted).toBe(true);expect(jest.getTimerCount()).toBe(0);
  });
  test('timeout settles even when work ignores abort; finalizes once; late failure handled',async()=>{
    let reject!:(error:Error)=>void,aborts=0;
    const pending=bounded(signal=>{signal.addEventListener('abort',()=>aborts++);return new Promise((_,r)=>{reject=r;});},10);
    const assertion=expect(pending).rejects.toMatchObject({name:'TimeoutError'});
    await jest.advanceTimersByTimeAsync(10);await assertion;
    expect(aborts).toBe(1);expect(jest.getTimerCount()).toBe(0);
    reject(new Error('late synthetic rejection'));await Promise.resolve();
  });
  test('completion clears native timeout and aborts resources once',async()=>{
    let aborts=0;
    expect(await bounded(async signal=>{signal.addEventListener('abort',()=>aborts++);return 3;},100)).toBe(3);
    expect(aborts).toBe(1);expect(jest.getTimerCount()).toBe(0);
  });
});
