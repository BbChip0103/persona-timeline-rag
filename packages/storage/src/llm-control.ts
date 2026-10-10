import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {CoreError} from '../../core/src/ports';
import type {Reply} from '../../../contracts/llm/v1/generated';
import {validateWire,type Ack,type Binding,type CompleteRequest,type Grant,type StartRequest,type StartResponse,type TurnContext} from '../../../contracts/llm/v1/validate';
import {transaction} from './pool';
const active=['pending','retrieving','generating','validating'];
export function canonicalHash(value:unknown):string {
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function grant(row:Record<string,unknown>):Grant {return {contractVersion:1,turnId:String(row.turn_id),dispatchSeq:Number(row.dispatch_seq),executionId:String(row.execution_id),generation:Number(row.generation),deadlineAt:Number(row.deadline_at),contextHash:String(row.context_hash),context:row.context as TurnContext};}
/** App-only authoritative execution grants. Redis is checked AFTER locking the turn, not before PG wait. */
export class PostgresLlmControl {
  constructor(private readonly pool:Pool,private readonly validLock:(binding:StartRequest)=>Promise<boolean>,private readonly limits={timeoutMs:30000,maxQueueMs:60000,maxAttempts:3}) {}
  private async locked(client:PoolClient,id:string) {return (await client.query('SELECT t.*,s.document AS session_document FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=$1 FOR UPDATE OF t',[id])).rows[0];}
  private async fail(client:PoolClient,id:string,code:string):Promise<StartResponse> {
    await client.query("UPDATE turns SET state='failed',error_code=$2,finished_at=now(),lease_owner=NULL WHERE id=$1",[id,code]);
    await client.query('DELETE FROM turn_leases WHERE turn_id=$1',[id]);await client.query('DELETE FROM turn_outbox WHERE turn_id=$1',[id]);
    return {contractVersion:1,status:'lost'};
  }
  async start(raw:StartRequest):Promise<StartResponse> {
    const request=validateWire<StartRequest>('StartRequest',raw);
    return transaction(this.pool,async client=>{
      const row=await this.locked(client,request.turnId);
      if(!row||row.dispatch_seq!==request.dispatchSeq)return {contractVersion:1,status:'lost'};
      if(row.state==='cancelled')return {contractVersion:1,status:'cancelled'};
      if(!await this.validLock(request))return {contractVersion:1,status:'lost'};
      const existing=(await client.query('SELECT * FROM turn_execution_grants WHERE execution_id=$1',[request.executionId])).rows[0];
      if(existing) {
        if(existing.turn_id!==row.id||existing.dispatch_seq!==request.dispatchSeq||existing.generation!==row.attempts||row.lease_owner!==request.executionId)return {contractVersion:1,status:'lost'};
        return {contractVersion:1,status:'granted',grant:grant(existing)};
      }
      if(!active.includes(row.state)||!row.request_input)return {contractVersion:1,status:'lost'};
      const outbox=(await client.query('SELECT created_at < now()-make_interval(secs=>$3::double precision/1000) AS expired FROM turn_outbox WHERE turn_id=$1 AND seq=$2',[row.id,request.dispatchSeq,this.limits.maxQueueMs])).rows[0];
      if(!outbox)return {contractVersion:1,status:'lost'};
      if(row.attempts>=this.limits.maxAttempts||row.lease_owner===null&&outbox.expired) {
        const code=row.attempts>0?'WORKER_LOST':'QUEUE_TIMEOUT';
        await client.query("UPDATE turns SET state='failed',error_code=$2,finished_at=now(),lease_owner=NULL WHERE id=$1",[row.id,code]);
        await client.query('DELETE FROM turn_outbox WHERE turn_id=$1',[row.id]);
        return {contractVersion:1,status:'lost'};
      }
      const history=(await client.query(`SELECT m.* FROM messages m LEFT JOIN turns t ON t.id=m.turn_id WHERE m.session_id=$1 AND (m.turn_id IS NULL OR t.state='completed') ORDER BY m.ordinal DESC LIMIT 101`,[row.session_id])).rows.reverse().map(m=>({id:m.id,sessionId:m.session_id,turnId:m.turn_id,role:m.role,content:m.content,createdAt:new Date(m.created_at).toISOString()}));
      if(history.length>100)return this.fail(client,row.id,'CONTEXT_LIMIT');
      const previous=(await client.query("SELECT reply FROM turns WHERE session_id=$1 AND state='completed' AND sequence<$2 ORDER BY sequence DESC LIMIT 1",[row.session_id,row.sequence])).rows[0]?.reply as Reply|undefined;
      const refused=(await client.query("SELECT id FROM turns WHERE session_id=$1 AND state='completed' AND reply->'inputSafety'->>'action'='refuse' ORDER BY sequence DESC LIMIT 100",[row.session_id])).rows.map(r=>String(r.id));
      const loreExcluded=(await client.query("SELECT id FROM turns WHERE session_id=$1 AND state='completed' AND COALESCE(reply->'inputSafety'->>'action','none')<>'none' ORDER BY sequence DESC LIMIT 100",[row.session_id])).rows.map(r=>String(r.id));
      const context:TurnContext={turn:{id:row.id,sessionId:row.session_id,ownerId:row.owner_id,clientRequestId:row.client_request_id,userText:row.user_text,sequence:row.sequence,state:'pending',createdAt:new Date(row.created_at).toISOString()},session:row.session_document,input:row.request_input,history,refusedTurnIds:refused,loreExcludedTurnIds:loreExcluded,...(previous?{previousReply:previous}:{})};
      try {validateWire('Context',context);}catch{return this.fail(client,row.id,'TURN_FAILED');}
      if(Buffer.byteLength(JSON.stringify(context),'utf8')>7*1024*1024)return this.fail(client,row.id,'CONTEXT_LIMIT');
      const generation=row.attempts+1,deadlineAt=Date.now()+this.limits.timeoutMs;
      await client.query("UPDATE turns SET lease_owner=$2,attempts=$3,state='pending',error_code=NULL WHERE id=$1",[row.id,request.executionId,generation]);
      const inserted=await client.query(`INSERT INTO turn_execution_grants(turn_id,dispatch_seq,execution_id,generation,context_hash,context,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[row.id,request.dispatchSeq,request.executionId,generation,canonicalHash(context),context,deadlineAt]);
      return {contractVersion:1,status:'granted',grant:grant(inserted.rows[0])};
    });
  }
  async status(raw:Binding):Promise<{contractVersion:1;status:'current'|'lost'|'cancelled';deadlineAt?:number}> {
    const binding=validateWire<Binding>('StatusRequest',raw);
    return transaction(this.pool,async client=>{
      const row=await this.locked(client,binding.turnId);
      if(row?.state==='cancelled')return {contractVersion:1,status:'cancelled'};
      if(!this.matches(row,binding)||!active.includes(row.state)||!await this.validLock(binding))return {contractVersion:1,status:'lost'};
      const record=(await client.query('SELECT deadline_at FROM turn_execution_grants WHERE turn_id=$1 AND generation=$2 AND execution_id=$3',[binding.turnId,binding.generation,binding.executionId])).rows[0];
      if(!record||Number(record.deadline_at)<=Date.now())return {contractVersion:1,status:'lost'};
      return {contractVersion:1,status:'current',deadlineAt:Number(record.deadline_at)};
    });
  }
  async snapshot(raw:Binding):Promise<StartResponse> {
    const binding=validateWire<Binding>('SnapshotRequest',raw);
    return transaction(this.pool,async client=>{
      const row=await this.locked(client,binding.turnId);
      if(row?.state==='cancelled')return {contractVersion:1,status:'cancelled'};
      if(!this.matches(row,binding)||!active.includes(row.state)||!await this.validLock(binding))return {contractVersion:1,status:'lost'};
      const record=(await client.query('SELECT * FROM turn_execution_grants WHERE turn_id=$1 AND generation=$2 AND execution_id=$3',[binding.turnId,binding.generation,binding.executionId])).rows[0];
      if(!record||Number(record.deadline_at)<=Date.now())return {contractVersion:1,status:'lost'};
      return {contractVersion:1,status:'granted',grant:grant(record)};
    });
  }
  private matches(row:Record<string,unknown>|undefined,b:Binding):boolean {return !!row&&row.id===b.turnId&&row.dispatch_seq===b.dispatchSeq&&row.lease_owner===b.executionId&&row.attempts===b.generation;}
  async progress(raw:Binding&{state:'retrieving'|'generating'|'validating'}):Promise<Ack> {
    const request=validateWire<Binding&{state:'retrieving'|'generating'|'validating'}>('ProgressRequest',raw);
    return transaction(this.pool,async client=>{
      const row=await this.locked(client,request.turnId);
      if(row?.state==='cancelled')return {contractVersion:1,status:'cancelled'};
      if(!this.matches(row,request)||!active.includes(row.state)||!await this.validLock(request))return {contractVersion:1,status:'lost'};
      if(active.indexOf(request.state)<active.indexOf(row.state))return {contractVersion:1,status:'lost'};
      await client.query('UPDATE turns SET state=$2 WHERE id=$1',[row.id,request.state]);
      return {contractVersion:1,status:'applied'};
    });
  }
  async complete(raw:CompleteRequest):Promise<Ack> {
    const request=validateWire<CompleteRequest>('CompleteRequest',raw),resultHash=canonicalHash(request.result);
    return transaction(this.pool,async client=>{
      const row=await this.locked(client,request.turnId);
      const record=(await client.query('SELECT * FROM turn_execution_grants WHERE turn_id=$1 AND generation=$2 AND execution_id=$3 AND dispatch_seq=$4',[request.turnId,request.generation,request.executionId,request.dispatchSeq])).rows[0];
      if(record?.result_hash) {
        if(record.result_hash!==resultHash)throw new CoreError('IDEMPOTENCY_CONFLICT');
        return {contractVersion:1,status:'alreadyApplied'};
      }
      if(row?.state==='cancelled')return {contractVersion:1,status:'cancelled'};
      if(!record||!this.matches(row,request)||!active.includes(row.state)||!await this.validLock(request))return {contractVersion:1,status:'lost'};
      if(request.result.kind==='completed'&&Number(record.deadline_at)<=Date.now()) {
        // Current ownership is proven above. A slow receipt write/row lock must not
        // turn a deadline crossing into another generation and another model call.
        await client.query("UPDATE turns SET state='failed',error_code='TURN_TIMEOUT',finished_at=now() WHERE id=$1",[row.id]);
        await client.query('DELETE FROM turn_leases WHERE turn_id=$1',[row.id]);
        await client.query('DELETE FROM turn_outbox WHERE turn_id=$1',[row.id]);
        return {contractVersion:1,status:'lost'};
      }
      if(request.result.kind==='completed') {
        const reply=request.result.reply,session=row.session_document;
        if(reply.turnId!==row.id||reply.sessionId!==row.session_id||reply.personId!==session.personId||reply.personaRevision!==session.personaRevision)throw new CoreError('INVALID_INPUT');
        await client.query("UPDATE turns SET state='completed',reply=$2,finished_at=now(),error_code=NULL WHERE id=$1",[row.id,reply]);
        await client.query(`INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES($1,$2,$3,'user',$4,now()),($5,$2,$3,'assistant',$6,now())`,[randomUUID(),row.session_id,row.id,row.user_text,reply.messageId,reply.content]);
      } else await client.query("UPDATE turns SET state='failed',error_code=$2,finished_at=now() WHERE id=$1",[row.id,request.result.errorCode]);
      await client.query('DELETE FROM turn_leases WHERE turn_id=$1',[row.id]);
      await client.query('DELETE FROM turn_outbox WHERE turn_id=$1',[row.id]);
      await client.query('UPDATE turn_execution_grants SET result_hash=$3,result=$4 WHERE turn_id=$1 AND generation=$2',[row.id,request.generation,resultHash,request.result]);
      return {contractVersion:1,status:'applied'};
    });
  }
}
