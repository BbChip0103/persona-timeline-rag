import type {INestApplication} from '@nestjs/common';
import {CoreError} from '../../../packages/core/src/ports';
import {createApiApplication} from '../src/app';
import type {SplitApiRuntime} from '../src/split-runtime';
const token='synthetic-memory-api-token-1234567890';
let app:INestApplication,base:string;
const chat={getSession:jest.fn(),listUserMemories:jest.fn(),setUserMemoryConsent:jest.fn(),forgetUserMemory:jest.fn(),deleteUserMemories:jest.fn(),deleteSession:jest.fn()};
async function call(path:string,method='GET',body?:unknown){const response=await fetch(base+'/api'+path,{method,headers:{Authorization:`Bearer ${token}-harness`,'X-PTR-Owner':'owner_synthetic_memory','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
beforeEach(async()=>{jest.resetAllMocks();app=await createApiApplication({kind:'split',chat,close:async()=>undefined} as unknown as SplitApiRuntime,token,{syntheticToken:token+'-harness'});await app.listen(0,'127.0.0.1');base=await app.getUrl();});
afterEach(async()=>{await app.close();});
test('memory management routes scope all operations to the authenticated owner',async()=>{
 chat.listUserMemories.mockResolvedValue([{id:'synthetic-memory',kind:'like',text:'tea'}]);
 expect(await call('/sessions/synthetic-session/memories')).toEqual({status:200,body:{memories:[{id:'synthetic-memory',kind:'like',text:'tea'}]}});
 expect(chat.listUserMemories).toHaveBeenCalledWith('owner_synthetic_memory','synthetic-session');
 chat.forgetUserMemory.mockResolvedValue(true);expect((await call('/sessions/synthetic-session/memories/synthetic-memory','DELETE')).body).toEqual({deleted:true});
 expect(chat.forgetUserMemory).toHaveBeenCalledWith('owner_synthetic_memory','synthetic-session','synthetic-memory');
 chat.deleteUserMemories.mockResolvedValue(2);expect((await call('/sessions/synthetic-session/memories','DELETE')).body).toEqual({deleted:2});
 expect(chat.deleteUserMemories).toHaveBeenCalledWith('owner_synthetic_memory','synthetic-session');
});
test('consent requires a strict boolean payload and returns safe session metadata',async()=>{
 chat.setUserMemoryConsent.mockResolvedValue({id:'synthetic-session',ownerId:'private-owner',userMemoryConsent:true});
 expect((await call('/sessions/synthetic-session/memory-consent','POST',{enabled:true})).body).toEqual({session:{id:'synthetic-session',userMemoryConsent:true}});
 expect(chat.setUserMemoryConsent).toHaveBeenCalledWith('owner_synthetic_memory','synthetic-session',true);
 for(const body of [{enabled:'true'},{enabled:true,extra:true},{}])expect((await call('/sessions/synthetic-session/memory-consent','POST',body)).status).toBe(400);
 expect(chat.setUserMemoryConsent).toHaveBeenCalledTimes(1);
});
test('session deletion keeps missing owner resources hidden and refuses active work',async()=>{
 chat.deleteSession.mockResolvedValue(true);expect(await call('/sessions/synthetic-session','DELETE')).toEqual({status:200,body:{deleted:true}});
 expect(chat.deleteSession).toHaveBeenCalledWith('owner_synthetic_memory','synthetic-session');
 chat.deleteSession.mockRejectedValueOnce(new CoreError('NOT_FOUND'));expect((await call('/sessions/other-session','DELETE')).status).toBe(404);
 chat.deleteSession.mockRejectedValueOnce(new CoreError('TURN_ACTIVE'));expect((await call('/sessions/synthetic-session','DELETE')).status).toBe(409);
});
