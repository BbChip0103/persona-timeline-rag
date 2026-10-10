import {randomUUID} from 'node:crypto';
import type {ChatReply,ChatSession,Persona} from '@ptr/contracts';
import {InMemoryConversationStore} from '../../../packages/core/src/memory-store';
import {InMemoryTurnEvents} from '../../../packages/core/src/memory-queue';
import type {TurnDispatch} from '../../../packages/core/src/ports';
import type {CreativeArtifact} from '../src/creative-artifact';
import {SplitChatService} from '../src/split-chat';
import type {SplitApiRuntime} from '../src/split-runtime';

/** Synthetic Python-side results, not another LLM/policy implementation. Backend uses its real split service. */
export function splitRuntimeFixture(persona:Persona,{store=new InMemoryConversationStore(),hold=false}={}) {
  const events=new InMemoryTurnEvents(),dispatches:TurnDispatch[]=[],artifacts:CreativeArtifact[]=[];
  const pending=new Map<string,{owner:string;session:ChatSession}>();
  let closed=false;
  const fixture:{store:InMemoryConversationStore;events:InMemoryTurnEvents;dispatches:TurnDispatch[];artifacts:CreativeArtifact[];hold:boolean;reply:Partial<ChatReply>;complete(turnId:string,reply?:Partial<ChatReply>):Promise<void>}={store,events,dispatches,artifacts,hold,reply:{},
    async complete(turnId:string,reply:Partial<ChatReply>=fixture.reply) {
      const entry=pending.get(turnId);if(!entry||closed)return;
      if(!await store.transitionTurn(turnId,['pending','generating'],'validating'))return;
      await events.publish({turnId,state:'validating'});
      const result:ChatReply={sessionId:entry.session.id,turnId,messageId:randomUUID(),personId:persona.personId,personaRevision:persona.revision,responseKind:'small_talk',status:'answered',content:'반가워요.',claims:[],evidence:[],limitations:[],...reply};
      if(await store.completeTurn(turnId,result))await events.publish({turnId,state:'completed'});
    },
  };
  const delivery={backlog:async()=>0,publish:async(dispatch:TurnDispatch)=>{
    dispatches.push(dispatch);
    // A fixture job is asynchronous, as the real Python queue consumer is.
    setImmediate(()=>{void (async()=>{
      if(closed)return;
      const queued=await store.claimTurn(dispatch.turnId,'synthetic-python',60000);if(!queued)return;
      const session=await store.getOwnedSession(queued.turn.sessionId,queued.turn.ownerId);if(!session)return;
      pending.set(dispatch.turnId,{owner:queued.turn.ownerId,session});
      await store.transitionTurn(dispatch.turnId,['pending'],'generating');await events.publish({turnId:dispatch.turnId,state:'generating'});
      if(!fixture.hold)await fixture.complete(dispatch.turnId);
    })();});
  }};
  const runtime={kind:'split',chat:new SplitChatService(store,async()=>[persona],delivery,events),
    controlToken:'synthetic_control_token_abcdefghijklmnop',control:{},executionStore:store,delivery,events,eventSource:events,
    providerName:'fake',model:'synthetic/python-fixture',billable:false,listPersonas:async()=>[persona],
    draftRemote:jest.fn(async(_session:ChatSession,_brief:string,_requestKey:string,_deadlineAt:number,_signal:AbortSignal)=>({content:'합성 초안',provider:'fake',model:'synthetic/python-fixture'})),
    saveArtifact:async(artifact:CreativeArtifact)=>{artifacts.push(artifact);},health:async()=>({database:true,redis:true}),close:async()=>{closed=true;},
  } as unknown as SplitApiRuntime;
  return Object.assign(fixture,{runtime});
}
