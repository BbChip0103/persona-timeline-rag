import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Pool, QueryResultRow } from 'pg';
import type { ChatMessage, ChatReply, ChatSession, ChatTurn, SendTurnInput, TurnState } from '@ptr/contracts';
import { CoreError, type ConversationStore, type LeaseFence, type QueuedTurn, type TurnDispatch, type TurnLeaseStore, type TurnExecutionStore, type ExecutionDispatch } from '../../core/src/ports';
import {turnTextFingerprint} from '../../core/src/request-fingerprint';
import { transaction } from './pool.js';
import { createConversationDatabase } from './database.js';

const terminal = ['completed', 'failed', 'cancelled'];
const active = ['pending', 'retrieving', 'generating', 'validating'];
// Fence clause: $f1 worker id, $f2 attempt. A NULL worker id means an unfenced write (store-level tests and cancellation).
// The fencing token (lease_owner, attempts) lives on turns and changes only on claim and recovery; the lease expiry
// lives in turn_leases so heartbeats never write turns. A lease row counts only while it matches the token.
// A turn whose lease is gone: back to pending with the next dispatch, or failed once attempts are exhausted ($1).
const requeue = `state=CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
  error_code=CASE WHEN attempts >= $1 THEN 'WORKER_LOST' ELSE error_code END,
  finished_at=CASE WHEN attempts >= $1 THEN now() ELSE NULL END,
  dispatch_seq=CASE WHEN attempts >= $1 THEN dispatch_seq ELSE dispatch_seq+1 END,
  lease_owner=NULL`;
const redispatch = `INSERT INTO turn_outbox(turn_id,seq) SELECT id, dispatch_seq FROM expired WHERE state='pending'
  ON CONFLICT (turn_id) DO UPDATE SET seq=EXCLUDED.seq, created_at=now(), published_at=NULL`;
const fence = (f1: number, f2: number) => `($${f1}::text IS NULL OR (lease_owner=$${f1} AND attempts=$${f2}))`;
function turn(row: QueryResultRow): ChatTurn {
  return { id: row.id, sessionId: row.session_id, ownerId: row.owner_id,
    clientRequestId: row.client_request_id, userText: row.user_text, sequence: row.sequence,
    state: row.state, createdAt: new Date(row.created_at).toISOString(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {}),
    ...(row.reply ? { reply: row.reply } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) };
}

export class PostgresConversationStore implements ConversationStore, TurnLeaseStore, TurnExecutionStore {
  private readonly database;
  constructor(private readonly pool: Pool) { this.database = createConversationDatabase(pool); }
  async create(session: ChatSession, greeting: ChatMessage): Promise<void> {
    if (greeting.sessionId !== session.id || greeting.turnId !== null || greeting.role !== 'assistant')
      throw new CoreError('INVALID_INPUT');
    await this.database.transaction().execute(async database => {
      await database.insertInto('sessions').values({
        id: session.id, owner_id: session.ownerId, person_id: session.personId,
        persona_id: session.personaId, persona_revision: session.personaRevision,
        document: session, created_at: session.createdAt,
      }).execute();
      await database.insertInto('messages').values({
        id: greeting.id, session_id: session.id, turn_id: null, role: greeting.role,
        content: greeting.content, created_at: greeting.createdAt,
      }).execute();
    });
  }
  async setUserMemoryConsent(sessionId:string,ownerId:string,enabled:boolean):Promise<ChatSession> {
    const r=await this.pool.query(`UPDATE sessions SET document=jsonb_set(document,'{userMemoryConsent}',$3::jsonb) WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL RETURNING document`,[sessionId,ownerId,JSON.stringify(enabled)]);
    if(!r.rowCount)throw new CoreError('NOT_FOUND');return r.rows[0].document;
  }
  async getSessionSummary(sessionId:string,ownerId:string):Promise<{text:string;lastMessageId:string}|undefined> {
    const r=(await this.pool.query('SELECT summary,summary_last_message_id FROM sessions WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',[sessionId,ownerId])).rows[0];
    return r?.summary&&r.summary_last_message_id?{text:r.summary,lastMessageId:r.summary_last_message_id}:undefined;
  }
  async listUserMemories(ownerId:string,personaId:string,includeForgotten=false) {
    const r=await this.pool.query('SELECT id,owner_id,persona_id,origin_session_id,kind,text,forgotten,created_at FROM user_memories WHERE owner_id=$1 AND persona_id=$2 AND ($3::boolean OR NOT forgotten) ORDER BY created_at,id',[ownerId,personaId,includeForgotten]);
    return r.rows.map(row=>({id:String(row.id),ownerId:String(row.owner_id),personaId:String(row.persona_id),sessionOriginId:String(row.origin_session_id),kind:row.kind as 'name'|'like'|'dislike'|'recent_event'|'other',text:String(row.text),forgotten:Boolean(row.forgotten),createdAt:new Date(row.created_at).toISOString()}));
  }
  async forgetUserMemory(memoryId:string,ownerId:string):Promise<boolean> {
    return transaction(this.pool,async client=>{
      const memory=(await client.query('SELECT persona_id FROM user_memories WHERE id=$1 AND owner_id=$2',[memoryId,ownerId])).rows[0];
      if(!memory)return false;
      await client.query('UPDATE sessions SET summary=NULL,summary_last_message_id=NULL WHERE owner_id=$1 AND persona_id=$2 AND deleted_at IS NULL',[ownerId,memory.persona_id]);
      return (await client.query('UPDATE user_memories SET forgotten=true WHERE id=$1 AND owner_id=$2 RETURNING id',[memoryId,ownerId])).rowCount===1;
    });
  }
  async deleteUserMemories(ownerId:string,personaId:string):Promise<number> {
    return transaction(this.pool,async client=>{
      await client.query('UPDATE sessions SET summary=NULL,summary_last_message_id=NULL WHERE owner_id=$1 AND persona_id=$2 AND deleted_at IS NULL',[ownerId,personaId]);
      return (await client.query('UPDATE user_memories SET forgotten=true WHERE owner_id=$1 AND persona_id=$2 AND NOT forgotten',[ownerId,personaId])).rowCount??0;
    });
  }
  async deleteOwnedSession(sessionId:string,ownerId:string):Promise<boolean> {
    return transaction(this.pool,async client=>{
      const owned=await client.query('SELECT id FROM sessions WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',[sessionId,ownerId]);
      if(!owned.rowCount)return false;
      const running=await client.query('SELECT id FROM turns WHERE session_id=$1 AND state=ANY($2::text[]) FOR UPDATE',[sessionId,active]);
      if(running.rowCount)throw new CoreError('TURN_ACTIVE');
      await client.query('UPDATE sessions SET summary=NULL,summary_last_message_id=NULL WHERE id=$1',[sessionId]);
      await client.query('DELETE FROM messages WHERE session_id=$1',[sessionId]);
      await client.query('DELETE FROM user_memories WHERE origin_session_id=$1',[sessionId]);
      await client.query("UPDATE turn_execution_grants SET context='{}'::jsonb,result=CASE WHEN result_hash IS NULL THEN NULL ELSE '{}'::jsonb END WHERE turn_id IN (SELECT id FROM turns WHERE session_id=$1)",[sessionId]);
      await client.query("UPDATE turns SET deleted_at=now(),reply=NULL,user_text='',request_input=NULL WHERE session_id=$1",[sessionId]);
      await client.query('UPDATE sessions SET deleted_at=now(),summary=NULL,summary_last_message_id=NULL WHERE id=$1',[sessionId]);
      return true;
    });
  }
  async getOwnedSession(sessionId: string, ownerId: string): Promise<ChatSession | undefined> {
    const row = await this.database.selectFrom('sessions').select('document')
      .where('id', '=', sessionId).where('owner_id', '=', ownerId).where('deleted_at', 'is', null).executeTakeFirst();
    return row?.document;
  }
  async listOwnedSessions(ownerId: string): Promise<ChatSession[]> {
    const rows = await this.database.selectFrom('sessions').select('document')
      .where('owner_id', '=', ownerId).where('deleted_at', 'is', null).orderBy('created_at', 'desc').orderBy('id').execute();
    return rows.map(row => row.document);
  }
  async history(sessionId: string, ownerId: string): Promise<ChatMessage[]> {
    const rows = await this.database.selectFrom('messages as m')
      .innerJoin('sessions as s', 's.id', 'm.session_id').leftJoin('turns as t', 't.id', 'm.turn_id')
      .selectAll('m').where('s.id', '=', sessionId).where('s.owner_id', '=', ownerId).where('s.deleted_at', 'is', null)
      .where(expression => expression.or([expression('m.turn_id', 'is', null), expression('t.state', '=', 'completed')]))
      .orderBy('m.ordinal').execute();
    return rows.map(row => ({ id: row.id, sessionId: row.session_id, turnId: row.turn_id,
      role: row.role, content: row.content, createdAt: new Date(row.created_at).toISOString() }));
  }
  async refusedTurnIds(sessionId: string, ownerId: string): Promise<string[]> {
    const rows = await this.database.selectFrom('turns as t').innerJoin('sessions as s', 's.id', 't.session_id')
      .select('t.id').where('s.id', '=', sessionId).where('s.owner_id', '=', ownerId).where('s.deleted_at', 'is', null).where('t.state', '=', 'completed')
      .where(sql<string>`${sql.ref('t.reply')}->'inputSafety'->>'action'`, '=', 'refuse').execute();
    return rows.map(row => String(row.id));
  }
  async reserveTurn(sessionId: string, ownerId: string, clientRequestId: string, text: string, requestHash?: string, input?: SendTurnInput): Promise<{ turn: ChatTurn; created: boolean; dispatch?: TurnDispatch }> {
    const fingerprint=requestHash??turnTextFingerprint(text);
    if(!/^[a-f0-9]{64}$/.test(fingerprint)) throw new CoreError('INVALID_INPUT');
    return transaction(this.pool, async client => {
      const session = await client.query('SELECT id,document FROM sessions WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE', [sessionId, ownerId]);
      if (!session.rowCount) throw new CoreError('NOT_FOUND');
      const existing = await client.query('SELECT * FROM turns WHERE session_id=$1 AND client_request_id=$2', [sessionId, clientRequestId]);
      if (existing.rowCount) {
        if (existing.rows[0].user_text !== text || (existing.rows[0].request_hash===null ? requestHash!==undefined : existing.rows[0].request_hash!==fingerprint)) throw new CoreError('IDEMPOTENCY_CONFLICT');
        return { turn: turn(existing.rows[0]), created: false };
      }
      const active = await client.query('SELECT id FROM turns WHERE session_id=$1 AND NOT(state=ANY($2::text[]))', [sessionId, terminal]);
      if (active.rowCount) throw new CoreError('TURN_ACTIVE');
      const result = await client.query(`INSERT INTO turns(id,session_id,owner_id,client_request_id,user_text,request_hash,sequence,state,request_input,user_memory_consent_at_input)
        SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(sequence),0)+1,'pending',$7,$8 FROM turns WHERE session_id=$2 RETURNING *`,
      [randomUUID(), sessionId, ownerId, clientRequestId, text, fingerprint, input ?? null, session.rows[0].document?.userMemoryConsent===true]);
      const reserved = turn(result.rows[0]);
      if (!input) return { turn: reserved, created: true };
      // Same transaction as the reservation: a committed turn always has a dispatch to deliver.
      await client.query('INSERT INTO turn_outbox(turn_id,seq) VALUES($1,0)', [reserved.id]);
      return { turn: reserved, created: true, dispatch: { turnId: reserved.id, seq: 0 } };
    });
  }
  async transitionTurn(turnId: string, expected: TurnState[], next: TurnState, errorCode?: string, leaseFence?: LeaseFence): Promise<boolean> {
    if (next === 'completed') throw new CoreError('INVALID_INPUT', 'Use atomic completeTurn for completion');
    const allowed: Record<string, string[]> = {
      pending: ['retrieving','generating','validating','failed','cancelled'], retrieving: ['generating','failed','cancelled'],
      generating: ['validating','failed','cancelled'], validating: ['failed','cancelled'],
    };
    const states = expected.filter(state => allowed[state]?.includes(next));
    if (!states.length) return false;
    const update = (db: Pick<Pool, 'query'>) => db.query(`UPDATE turns SET state=$3,error_code=$4,
      finished_at=CASE WHEN $3=ANY($5::text[]) THEN now() ELSE NULL END
      WHERE id=$1 AND state=ANY($2::text[]) AND ${fence(6, 7)} RETURNING id`,
    [turnId, states, next, errorCode ?? null, terminal, leaseFence?.workerId ?? null, leaseFence?.attempt ?? null]);
    if (!terminal.includes(next)) return (await update(this.pool)).rowCount === 1;
    // Ending the turn drops its lease. The delete is a separate statement after the row lock, so its snapshot also
    // sees a lease committed by a claim that the update waited for.
    return transaction(this.pool, async client => {
      if ((await update(client)).rowCount !== 1) return false;
      await client.query('DELETE FROM turn_leases WHERE turn_id=$1', [turnId]);
      await client.query('DELETE FROM turn_outbox WHERE turn_id=$1', [turnId]);
      return true;
    });
  }
  async completeTurn(turnId: string, reply: ChatReply, leaseFence?: LeaseFence): Promise<boolean> {
    return transaction(this.pool, async client => {
      const result = await client.query(`SELECT t.*,s.person_id,s.persona_revision FROM turns t
        JOIN sessions s ON s.id=t.session_id WHERE t.id=$1 FOR UPDATE OF t`, [turnId]);
      const row = result.rows[0];
      if (!row || row.state !== 'validating') return false;
      if (leaseFence && (row.lease_owner !== leaseFence.workerId || row.attempts !== leaseFence.attempt)) return false;
      if (reply.turnId !== turnId || reply.sessionId !== row.session_id || reply.personId !== row.person_id || reply.personaRevision !== row.persona_revision)
        throw new CoreError('INVALID_INPUT', 'Reply does not match immutable session binding');
      await client.query("UPDATE turns SET state='completed',reply=$2,finished_at=now() WHERE id=$1", [turnId, reply]);
      await client.query('DELETE FROM turn_leases WHERE turn_id=$1', [turnId]);
      await client.query('DELETE FROM turn_outbox WHERE turn_id=$1', [turnId]);
      await client.query(`INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES
        ($1,$2,$3,'user',$4,now()),($5,$2,$3,'assistant',$6,now())`,
      [randomUUID(), row.session_id, turnId, row.user_text, reply.messageId, reply.content]);
      return true;
    });
  }
  async getTurn(turnId: string, ownerId: string): Promise<ChatTurn | undefined> {
    const row = await this.database.selectFrom('turns as t').innerJoin('sessions as s', 's.id', 't.session_id')
      .selectAll('t').where('t.id', '=', turnId).where('s.owner_id', '=', ownerId).where('s.deleted_at', 'is', null).executeTakeFirst();
    return row ? turn(row) : undefined;
  }
  async cancelTurn(turnId: string, ownerId: string): Promise<boolean> {
    return transaction(this.pool, async client => {
      const result = await client.query(`UPDATE turns t SET state='cancelled',finished_at=now()
        FROM sessions s WHERE t.session_id=s.id AND t.id=$1 AND s.owner_id=$2 AND NOT(t.state=ANY($3::text[])) RETURNING t.id`, [turnId, ownerId, terminal]);
      if (result.rowCount !== 1) return false;
      await client.query('DELETE FROM turn_leases WHERE turn_id=$1', [turnId]);
      await client.query('DELETE FROM turn_outbox WHERE turn_id=$1', [turnId]); // see transitionTurn
      return true;
    });
  }
  async claimExecution(dispatch: TurnDispatch, workerId: string, maxQueueMs: number, maxAttempts: number): Promise<QueuedTurn | undefined> {
    return transaction(this.pool, async client => {
      const result = await client.query(`SELECT t.*,o.created_at < now()-make_interval(secs=>$4::double precision/1000) AS queue_expired FROM turns t
        JOIN turn_outbox o ON o.turn_id=t.id AND o.seq=t.dispatch_seq
        WHERE t.id=$1 AND t.dispatch_seq=$2 AND t.state=ANY($3::text[]) AND t.request_input IS NOT NULL
        FOR UPDATE OF t`, [dispatch.turnId, dispatch.seq, active, maxQueueMs]);
      const row = result.rows[0];
      if (!row || row.lease_owner === workerId) return undefined;
      const timedOut = row.lease_owner === null && row.queue_expired;
      if (row.attempts >= maxAttempts || timedOut) {
        const errorCode = row.attempts > 0 ? 'WORKER_LOST' : 'QUEUE_TIMEOUT';
        await client.query("UPDATE turns SET state='failed',error_code=$2,finished_at=now(),lease_owner=NULL WHERE id=$1", [row.id,errorCode]);
        await client.query('DELETE FROM turn_outbox WHERE turn_id=$1', [row.id]);
        return undefined;
      }
      // This is a generation token, never a timed DB lease: BullMQ owns the job lock and stalled recovery.
      const claimed = await client.query("UPDATE turns SET lease_owner=$2,attempts=attempts+1,state='pending',error_code=NULL WHERE id=$1 RETURNING *", [row.id,workerId]);
      const current = claimed.rows[0];
      return {turn:turn(current),input:current.request_input as SendTurnInput,fence:{workerId,attempt:current.attempts}};
    });
  }
  async executionStatus(turnId: string, fence: LeaseFence): Promise<'current'|'cancelled'|'lost'> {
    const row = await this.database.selectFrom('turns').select(['state', 'lease_owner', 'attempts'])
      .where('id', '=', turnId).executeTakeFirst();
    if (row?.state === 'cancelled') return 'cancelled';
    return row && active.includes(row.state) && row.lease_owner === fence.workerId && row.attempts === fence.attempt ? 'current' : 'lost';
  }
  async executionDispatches(graceMs: number, limit: number): Promise<ExecutionDispatch[]> {
    const result = await this.pool.query(`WITH due AS (
      SELECT o.turn_id FROM turn_outbox o JOIN turns t ON t.id=o.turn_id
      WHERE t.state=ANY($3::text[]) AND o.created_at < now()-make_interval(secs=>$1::double precision/1000)
        AND (o.published_at IS NULL OR o.published_at < now()-make_interval(secs=>$1::double precision/1000))
      ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT $2), published AS (
      UPDATE turn_outbox o SET published_at=now() FROM due d WHERE o.turn_id=d.turn_id RETURNING o.turn_id,o.seq)
      SELECT p.*,t.lease_owner,t.attempts FROM published p JOIN turns t ON t.id=p.turn_id`, [graceMs,limit,active]);
    return result.rows.map(row => ({turnId:row.turn_id,seq:row.seq,...(row.lease_owner ? {fence:{workerId:row.lease_owner,attempt:row.attempts}} : {})}));
  }
  async repairExecution(dispatch: ExecutionDispatch, maxAttempts: number, exhausted = false): Promise<TurnDispatch | undefined> {
    return transaction(this.pool, async client => {
      const result = await client.query(`SELECT * FROM turns WHERE id=$1 AND dispatch_seq=$2 AND state=ANY($3::text[])
        AND lease_owner IS NOT DISTINCT FROM $4::text AND attempts=COALESCE($5::integer,attempts)
        FOR UPDATE`, [dispatch.turnId,dispatch.seq,active,dispatch.fence?.workerId??null,dispatch.fence?.attempt??null]);
      const row = result.rows[0];
      if (!row) return undefined;
      if (exhausted || row.attempts >= maxAttempts) {
        await client.query("UPDATE turns SET state='failed',error_code='WORKER_LOST',finished_at=now(),lease_owner=NULL WHERE id=$1",[row.id]);
        await client.query('DELETE FROM turn_outbox WHERE turn_id=$1',[row.id]);
        return undefined;
      }
      // Redis loss/DB-finalization failure: invalidate the old generation before publishing a fresh job id.
      const next = await client.query("UPDATE turns SET state='pending',lease_owner=NULL,dispatch_seq=dispatch_seq+1 WHERE id=$1 RETURNING dispatch_seq",[row.id]);
      await client.query('UPDATE turn_outbox SET seq=$2,created_at=now(),published_at=NULL WHERE turn_id=$1',[row.id,next.rows[0].dispatch_seq]);
      return {turnId:row.id,seq:next.rows[0].dispatch_seq};
    });
  }
  async claimTurn(turnId: string, workerId: string, leaseMs: number, maxQueueMs?: number): Promise<QueuedTurn | undefined> {
    // Only a pending turn with no token, or whose token's lease row has expired, is claimable. Concurrent claimers
    // serialize on the turns row; a loser re-checks the committed row, whose new (owner, attempts) token matches no
    // lease row in its older snapshot, so it fails. The claim upserts the lease row and retires the outbox entry.
    // With maxQueueMs a turn that waited longer than that since it was last queued (its outbox entry: the reservation or
    // the latest requeue) is not claimed (expireQueued fails it; both use the database clock).
    const result = await this.pool.query(`WITH claimed AS (
        UPDATE turns t SET lease_owner=$2, attempts=t.attempts+1
        WHERE t.id=$1 AND t.state='pending' AND t.request_input IS NOT NULL AND (t.lease_owner IS NULL OR EXISTS (
          SELECT 1 FROM turn_leases l WHERE l.turn_id=t.id AND l.owner=t.lease_owner AND l.attempt=t.attempts AND l.expires_at < now()))
          AND ($4::double precision IS NULL OR COALESCE((SELECT o.created_at FROM turn_outbox o WHERE o.turn_id=t.id), t.created_at)
            >= now()-make_interval(secs => $4::double precision/1000))
        RETURNING t.*), leased AS (
        INSERT INTO turn_leases(turn_id,owner,attempt,expires_at)
        SELECT id, lease_owner, attempts, now()+make_interval(secs => $3::double precision/1000) FROM claimed
        ON CONFLICT (turn_id) DO UPDATE SET owner=EXCLUDED.owner, attempt=EXCLUDED.attempt, expires_at=EXCLUDED.expires_at),
      retired AS (DELETE FROM turn_outbox o USING claimed c WHERE o.turn_id=c.id)
      SELECT * FROM claimed`, [turnId, workerId, leaseMs, maxQueueMs ?? null]);
    const row = result.rows[0];
    return row ? { turn: turn(row), input: row.request_input as SendTurnInput, fence: { workerId, attempt: row.attempts } } : undefined;
  }
  async renewLease(turnId: string, leaseFence: LeaseFence, leaseMs: number): Promise<boolean> {
    // Writes turn_leases only; turns is just read. An expired lease is never revived: a claim may already have seen
    // it as expired (the renewal does not touch turns, so nothing would make that claim re-check). Recovery and
    // terminal transitions delete the row (a waiting renewal then finds nothing) and a new claim replaces its token,
    // so a lost lease always answers false.
    const result = await this.pool.query(`UPDATE turn_leases l SET expires_at=now()+make_interval(secs => $4::double precision/1000)
      WHERE l.turn_id=$1 AND l.owner=$2 AND l.attempt=$3 AND l.expires_at >= now() AND EXISTS (
        SELECT 1 FROM turns t WHERE t.id=l.turn_id AND t.lease_owner=$2 AND t.attempts=$3 AND t.state=ANY($5::text[]))
      RETURNING l.turn_id`,
    [turnId, leaseFence.workerId, leaseFence.attempt, leaseMs, active]);
    return result.rowCount === 1;
  }
  async recoverExpired(maxAttempts: number): Promise<{ requeued: string[]; failed: string[] }> {
    // Expired leases either fail (attempts exhausted) or return to pending with a fresh dispatch in the outbox; the
    // token is cleared and the lease row deleted. Both rows are locked with SKIP LOCKED (the turns row only
    // FOR NO KEY UPDATE, like any non-key update), so this never waits: a lease being renewed, claimed or ended right
    // now is left for the next sweep, and two dispatchers never take the same one. A renewal committed after this
    // statement's snapshot is re-checked on lock and excludes the row.
    const result = await this.pool.query(`WITH due AS (
        SELECT l.turn_id FROM turn_leases l JOIN turns t ON t.id=l.turn_id
        WHERE l.expires_at < now() AND t.lease_owner=l.owner AND t.attempts=l.attempt AND t.state=ANY($2::text[])
        FOR UPDATE OF l SKIP LOCKED FOR NO KEY UPDATE OF t SKIP LOCKED), expired AS (
        UPDATE turns t SET ${requeue} FROM due d WHERE t.id=d.turn_id
        RETURNING t.id, t.state, t.dispatch_seq), dropped AS (
        DELETE FROM turn_leases l USING due d WHERE l.turn_id=d.turn_id), outbox AS (${redispatch})
      SELECT id, state FROM expired`, [maxAttempts, active]);
    return { requeued: result.rows.filter(row => row.state === 'pending').map(row => row.id),
      failed: result.rows.filter(row => row.state === 'failed').map(row => row.id) };
  }
  async reconcileLeases(maxAttempts: number, graceMs: number): Promise<{ requeued: string[]; failed: string[]; dropped: number }> {
    // Repairs drift that the normal paths never create (a mixed-version deploy, a manual fix): an active turn holding a
    // token that no lease row matches would never expire, and a lease row that matches no active token is garbage.
    // Each step locks its candidates with SKIP LOCKED (never waits; two dispatchers split the work) and then re-checks
    // them in a separate statement, whose fresh snapshot sees anything committed before the lock was taken.
    return transaction(this.pool, async client => {
      const orphans = (await client.query(`SELECT t.id FROM turns t
        WHERE t.state IN ('pending','retrieving','generating','validating') AND t.lease_owner IS NOT NULL
          AND t.created_at < now()-make_interval(secs => $1::double precision/1000)
          AND NOT EXISTS (SELECT 1 FROM turn_leases l WHERE l.turn_id=t.id AND l.owner=t.lease_owner AND l.attempt=t.attempts)
        FOR NO KEY UPDATE OF t SKIP LOCKED`, [graceMs])).rows.map(row => row.id);
      const result = orphans.length ? await client.query(`WITH expired AS (
          UPDATE turns t SET ${requeue}
          WHERE t.id=ANY($2::text[]) AND t.state=ANY($3::text[]) AND t.lease_owner IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM turn_leases l WHERE l.turn_id=t.id AND l.owner=t.lease_owner AND l.attempt=t.attempts)
          RETURNING t.id, t.state, t.dispatch_seq), outbox AS (${redispatch})
        SELECT id, state FROM expired`, [maxAttempts, orphans, active]) : { rows: [] };
      // A claim that changes the token also has to upsert the locked lease row, so it cannot slip in before the delete.
      const stale = (await client.query(`SELECT l.turn_id FROM turn_leases l JOIN turns t ON t.id=l.turn_id
        WHERE NOT (t.state=ANY($1::text[])) OR t.lease_owner IS DISTINCT FROM l.owner OR t.attempts<>l.attempt
        FOR UPDATE OF l SKIP LOCKED`, [active])).rows.map(row => row.turn_id);
      const dropped = stale.length ? (await client.query(`DELETE FROM turn_leases l USING turns t
        WHERE l.turn_id=ANY($1::text[]) AND t.id=l.turn_id
          AND (NOT (t.state=ANY($2::text[])) OR t.lease_owner IS DISTINCT FROM l.owner OR t.attempts<>l.attempt)`, [stale, active])).rowCount ?? 0 : 0;
      return { requeued: result.rows.filter(row => row.state === 'pending').map(row => row.id),
        failed: result.rows.filter(row => row.state === 'failed').map(row => row.id), dropped };
    });
  }
  async expireQueued(maxQueueMs: number): Promise<{ turnId: string; errorCode: 'QUEUE_TIMEOUT' | 'WORKER_LOST' }[]> {
    // Unclaimed pending turns all have an outbox entry (written by the reservation and by every requeue with a fresh
    // created_at, removed by the claim), so the small outbox drives the scan and dates the wait. The row lock (SKIP
    // LOCKED, never waits) re-checks the state and the empty token on the latest row version: a claim committed first
    // wins, and once this commits a claim finds the turn failed. A requeued turn (attempts > 0) may have reached a
    // model before its worker was lost, so it fails as WORKER_LOST, not as a turn that never ran.
    const result = await this.pool.query(`WITH due AS (
        SELECT t.id FROM turn_outbox o JOIN turns t ON t.id=o.turn_id
        WHERE t.state='pending' AND t.lease_owner IS NULL AND t.request_input IS NOT NULL
          AND o.created_at < now()-make_interval(secs => $1::double precision/1000)
        FOR NO KEY UPDATE OF t SKIP LOCKED), failed AS (
        UPDATE turns t SET state='failed', error_code=CASE WHEN t.attempts > 0 THEN 'WORKER_LOST' ELSE 'QUEUE_TIMEOUT' END, finished_at=now()
        FROM due d WHERE t.id=d.id AND t.state='pending' AND t.lease_owner IS NULL RETURNING t.id, t.error_code), retired AS (
        DELETE FROM turn_outbox o USING failed f WHERE o.turn_id=f.id)
      SELECT id, error_code FROM failed`, [maxQueueMs]);
    return result.rows.map(row => ({ turnId: String(row.id), errorCode: row.error_code }));
  }
  async pendingDispatches(graceMs: number, limit: number): Promise<TurnDispatch[]> {
    // Entries of turns that ended without being claimed (e.g. cancelled while queued) are dropped on the way.
    await this.pool.query(`DELETE FROM turn_outbox o USING turns t WHERE o.turn_id=t.id AND t.state<>'pending'`);
    const result = await this.pool.query(`UPDATE turn_outbox SET published_at=now() WHERE turn_id IN (
        SELECT turn_id FROM turn_outbox
        WHERE created_at < now()-make_interval(secs => $1::double precision/1000)
          AND (published_at IS NULL OR published_at < now()-make_interval(secs => $1::double precision/1000))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2)
      RETURNING turn_id, seq`, [graceMs, limit]);
    return result.rows.map(row => ({ turnId: row.turn_id, seq: row.seq }));
  }
}
