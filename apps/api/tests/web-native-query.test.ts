import { QueryClient, onlineManager } from '@tanstack/react-query';
import { createWebQueryClient, clearOwnerQueries, replyTurnIds } from '../../web/lib/query-client';
afterEach(()=>{onlineManager.setOnline(true);});
test('actual QueryClient owns GET deduplication and owner cache clearing',async()=>{
 const client=createWebQueryClient();expect(client).toBeInstanceOf(QueryClient);let resolve!:(value:string)=>void;const get=jest.fn(()=>new Promise<string>(done=>{resolve=done;}));
 const a=client.fetchQuery({queryKey:['session','a'],queryFn:get});const b=client.fetchQuery({queryKey:['session','a'],queryFn:get});expect(get).toHaveBeenCalledTimes(1);resolve('synthetic');expect(await a).toBe('synthetic');expect(await b).toBe('synthetic');
 expect(client.getQueryData(['session','a'])).toBe('synthetic');await clearOwnerQueries(client);expect(client.getQueryCache().getAll()).toHaveLength(0);
});
test('native mutation executes once even offline and never replays on reconnect after unknown transport outcome',async()=>{
 const client=createWebQueryClient();onlineManager.setOnline(false);const submit=jest.fn().mockRejectedValue(new Error('UNKNOWN_SUBMISSION'));
 const mutation=client.getMutationCache().build(client,{mutationFn:submit});const key={clientRequestId:'synthetic-request'};
 await expect(mutation.execute(key)).rejects.toThrow('UNKNOWN_SUBMISSION');expect(submit).toHaveBeenCalledTimes(1);expect(mutation.state.isPaused).toBe(false);
 onlineManager.setOnline(true);await client.resumePausedMutations();expect(submit).toHaveBeenCalledTimes(1);
 await expect(mutation.execute(key)).rejects.toThrow();expect(submit).toHaveBeenNthCalledWith(2,key,expect.any(Object));client.clear();
});
test('GET failures are not automatically retried; focus/reconnect/poll defaults are disabled',async()=>{
 const client=createWebQueryClient();const get=jest.fn().mockRejectedValue(new Error('UNAVAILABLE'));await expect(client.fetchQuery({queryKey:['get'],queryFn:get})).rejects.toThrow();expect(get).toHaveBeenCalledTimes(1);
 expect(client.getDefaultOptions().queries).toMatchObject({retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false,refetchInterval:false});expect(client.getDefaultOptions().mutations).toMatchObject({retry:false,networkMode:'always'});client.clear();
});

test('reply hydration preserves latest twenty distinct assistant turns, ignoring duplicate and user turn ids',()=>{const history=Array.from({length:25},(_,i)=>({role:'assistant',turnId:'turn'+i}));history.push({role:'user',turnId:'user-only'},{role:'assistant',turnId:'turn24'});expect(replyTurnIds(history)).toEqual(Array.from({length:20},(_,i)=>'turn'+(i+5)));});
test('owner cache clear cancels in-flight GET and prevents a late result repopulating another client',async()=>{
 const first=createWebQueryClient();const other=createWebQueryClient();let signal!:AbortSignal;let resolve!:(value:string)=>void;
 const pending=first.fetchQuery({queryKey:['session','synthetic'],queryFn:context=>{signal=context.signal;return new Promise<string>(done=>{resolve=done;});}});const rejected=pending.catch(error=>error);
 await clearOwnerQueries(first);expect(signal.aborted).toBe(true);resolve('late-private-synthetic');await rejected;await Promise.resolve();expect(first.getQueryCache().getAll()).toHaveLength(0);expect(other.getQueryCache().getAll()).toHaveLength(0);other.clear();
});
