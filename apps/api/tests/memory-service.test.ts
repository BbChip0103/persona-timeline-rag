import {SplitChatService} from '../src/split-chat';
import type {ConversationStore} from '../../../packages/core/src/ports';
const owned={id:'synthetic-session',ownerId:'synthetic-owner',personaId:'synthetic-persona'};
const store={getOwnedSession:jest.fn(),listUserMemories:jest.fn(),setUserMemoryConsent:jest.fn(),forgetUserMemory:jest.fn(),deleteUserMemories:jest.fn(),deleteOwnedSession:jest.fn()};
const chat=new SplitChatService(store as unknown as ConversationStore,async()=>[],{backlog:async()=>0,publish:async()=>undefined},{publish:async()=>undefined});
beforeEach(()=>{jest.resetAllMocks();store.getOwnedSession.mockResolvedValue(owned);});
test('memory operations derive persona scope from owned session',async()=>{
 store.listUserMemories.mockResolvedValue([{id:'synthetic-memory',kind:'like',text:'tea',forgotten:false,ownerId:'private',sessionId:'private'}]);
 expect(await chat.listUserMemories('synthetic-owner','synthetic-session')).toEqual([{id:'synthetic-memory',kind:'like',text:'tea'}]);
 expect(store.listUserMemories).toHaveBeenCalledWith('synthetic-owner','synthetic-persona');
 await chat.forgetUserMemory('synthetic-owner','synthetic-session','synthetic-memory');expect(store.forgetUserMemory).toHaveBeenCalledWith('synthetic-memory','synthetic-owner');
 await chat.deleteUserMemories('synthetic-owner','synthetic-session');expect(store.deleteUserMemories).toHaveBeenCalledWith('synthetic-owner','synthetic-persona');
});
test('other-owner session blocks memory mutations and disclosure before storage calls',async()=>{
 store.getOwnedSession.mockResolvedValue(undefined);
 for(const work of [()=>chat.listUserMemories('other-owner','synthetic-session'),()=>chat.forgetUserMemory('other-owner','synthetic-session','synthetic-memory'),()=>chat.deleteUserMemories('other-owner','synthetic-session'),()=>chat.setUserMemoryConsent('other-owner','synthetic-session',true),()=>chat.deleteSession('other-owner','synthetic-session')])await expect(work()).rejects.toMatchObject({code:'NOT_FOUND'});
 expect(store.listUserMemories).not.toHaveBeenCalled();expect(store.forgetUserMemory).not.toHaveBeenCalled();expect(store.deleteUserMemories).not.toHaveBeenCalled();expect(store.setUserMemoryConsent).not.toHaveBeenCalled();expect(store.deleteOwnedSession).not.toHaveBeenCalled();
});
test('forgotten records stay private and a memory from another persona cannot be forgotten',async()=>{
 store.listUserMemories.mockResolvedValue([{id:'synthetic-forgotten',kind:'like',text:'tea',forgotten:true}]);
 expect(await chat.listUserMemories('synthetic-owner','synthetic-session')).toEqual([]);
 expect(await chat.forgetUserMemory('synthetic-owner','synthetic-session','other-persona-memory')).toBe(false);
 expect(store.forgetUserMemory).not.toHaveBeenCalled();
});
test('consent mutation and deletion retain owner checks and pass through storage refusal',async()=>{
 store.setUserMemoryConsent.mockResolvedValue({...owned,userMemoryConsent:false});
 expect(await chat.setUserMemoryConsent('synthetic-owner','synthetic-session',false)).toMatchObject({userMemoryConsent:false});
 expect(store.setUserMemoryConsent).toHaveBeenCalledWith('synthetic-session','synthetic-owner',false);
 store.deleteOwnedSession.mockRejectedValueOnce({code:'TURN_ACTIVE'});
 await expect(chat.deleteSession('synthetic-owner','synthetic-session')).rejects.toMatchObject({code:'TURN_ACTIVE'});
 expect(store.deleteOwnedSession).toHaveBeenCalledWith('synthetic-session','synthetic-owner');
});
