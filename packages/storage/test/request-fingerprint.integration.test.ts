import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Persona } from '@ptr/contracts';
import { type LocalChat, requestFingerprint, createLocalChat } from '@ptr/core';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository } from '../src';
import { removeSyntheticConversations } from './synthetic-cleanup';
const enabled=process.env.RUN_STORAGE_DB_TESTS==='1'&&Boolean(process.env.DATABASE_URL);
(enabled?describe:describe.skip)('dedicated local SQL structured request fingerprint (synthetic only)',()=>{
  const scope=`synthetic-request-hash-${randomUUID()}`;let pool:Pool;let store:PostgresConversationStore;let service:LocalChat;
  const persona:Persona={id:`persona-${scope}`,personId:scope,revision:'synthetic-v1',label:'Synthetic fingerprint fixture',language:'ko',reviewStatus:'synthetic',identity:'Fictional fixture',concept:'test',style:[],boundaries:[],sourceRefs:[],greeting:'합성 인사'};
  const provider={generate:jest.fn(async()=>JSON.stringify({status:'insufficient_evidence',answer:'',evidenceRefs:[]}))};
  const retrieval={search:jest.fn(async()=>[])};
  beforeAll(async()=>{pool=createLocalPool(process.env.DATABASE_URL!);store=new PostgresConversationStore(pool);const personas=new PostgresPersonaRepository(pool);await personas.importPersona(persona);service=createLocalChat({store,personas,provider,retrieval});});
  afterAll(async()=>{try{await removeSyntheticConversations(pool,[scope]);}finally{await pool?.end();}});
  async function create(){return service.createSession(scope,{personId:scope,personaId:persona.id,personaRevision:persona.revision,retrievalMode:'lexical',timezone:'UTC'});}
  test('canonical retry does not call provider/retrieval again; changed structured fields conflict',async()=>{
    const session=await create();
    const input={sessionId:session.id,clientRequestId:'same',text:' 합성 질문 ',intent:'timeline' as const,timeline:{query:' synthetic ',dateBasis:'posted' as const,start:'2020-01-01',end:'2021-01-01'}};
    const first=await service.sendTurn(scope,input);
    const replay=await service.sendTurn(scope,{...input,text:'합성 질문',timeline:{limit:5,end:'2021-01-01',start:'2020-01-01',dateBasis:'posted',query:'synthetic'}});
    expect(replay.id).toBe(first.id);expect(provider.generate).toHaveBeenCalledTimes(1);expect(retrieval.search).toHaveBeenCalledTimes(1);
    for(const changed of [{...input,intent:'small_talk' as const},{...input,timeline:{...input.timeline,query:'different'}},{...input,timeline:{...input.timeline,start:'2020-02-01'}},{...input,timeline:{...input.timeline,end:'2021-02-01'}},{...input,timeline:{...input.timeline,dateBasis:'event' as const}},{...input,timeline:{...input.timeline,limit:6}}]) await expect(service.sendTurn(scope,changed)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect(provider.generate).toHaveBeenCalledTimes(1);expect(retrieval.search).toHaveBeenCalledTimes(1);
    const result=await pool.query('SELECT request_hash FROM turns WHERE id=$1',[first.id]);expect(result.rows[0].request_hash).toBe(requestFingerprint(input));
  });
  test('legacy null hash cannot authorize a structured retry',async()=>{
    const session=await create();const original=await store.reserveTurn(session.id,scope,'legacy','합성 질문');
    await store.cancelTurn(original.turn.id,scope);
    await pool.query('UPDATE turns SET request_hash=NULL WHERE id=$1',[original.turn.id]);
    await expect(service.sendTurn(scope,{sessionId:session.id,clientRequestId:'legacy',text:'합성 질문',intent:'small_talk'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect((await store.reserveTurn(session.id,scope,'legacy','합성 질문')).created).toBe(false);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
});
