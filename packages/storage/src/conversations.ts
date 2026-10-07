import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { ChatMessage, ChatReply, ChatSession, ChatTurn, SendTurnInput, TurnState } from '@ptr/contracts';
import { CoreError, turnTextFingerprint, type ConversationStore, type LeaseFence, type QueuedTurn, type TurnDispatch, type TurnLeaseStore } from '@ptr/core';
import { transaction } from './pool.js';

const terminal = ['completed', 'failed', 'cancelled'];
const active = ['pending', 'retrieving', 'generating', 'validating'];
// Fence clause: $f1 worker id, $f2 attempt. A NULL worker id means an unfenced write (store-level tests and cancellation).
const fence = (f1: number, f2: number) => `($${f1}::text IS NULL OR (lease_owner=$${f1} AND attempts=$${f2}))`;
function turn(row: QueryResultRow): ChatTurn {
  return { id: row.id, sessionId: row.session_id, ownerId: row.owner_id,
    clientRequestId: row.client_request_id, userText: row.user_text, sequence: row.sequence,
    state: row.state, createdAt: new Date(row.created_at).toISOString(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {}),
    ...(row.reply ? { reply: row.reply } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) };
}

export class PostgresConversationStore implements ConversationStore, TurnLeaseStore {
  constructor(private readonly pool: Pool) {}
  async create(session: ChatSession, greeting: ChatMessage): Promise<void> {
    if (greeting.sessionId !== session.id || greeting.turnId !== null || greeting.role !== 'assistant')
      throw new CoreError('INVALID_INPUT');
    await transaction(this.pool, async client => {
      await client.query('INSERT INTO sessions(id,owner_id,person_id,persona_id,persona_revision,document,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [session.id, session.ownerId, session.personId, session.personaId, session.personaRevision, session, session.createdAt]);
      await client.query('INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES($1,$2,NULL,$3,$4,$5)',
        [greeting.id, session.id, greeting.role, greeting.content, greeting.createdAt]);
    });
  }
  async getOwnedSession(sessionId: string, ownerId: string): Promise<ChatSession | undefined> {
    const result = await this.pool.query('SELECT document FROM sessions WHERE id=$1 AND owner_id=$2', [sessionId, ownerId]);
    return result.rows[0]?.document;
  }
  async listOwnedSessions(ownerId: string): Promise<ChatSession[]> {
    return (await this.pool.query('SELECT document FROM sessions WHERE owner_id=$1 ORDER BY created_at DESC,id', [ownerId])).rows.map(row => row.document);
  }
  async history(sessionId: string, ownerId: string): Promise<ChatMessage[]> {
    const result = await this.pool.query(`SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id
      LEFT JOIN turns t ON t.id=m.turn_id WHERE s.id=$1 AND s.owner_id=$2
      AND (m.turn_id IS NULL OR t.state='completed') ORDER BY m.ordinal`, [sessionId, ownerId]);
    return result.rows.map(row => ({ id: row.id, sessionId: row.session_id, turnId: row.turn_id,
      role: row.role, content: row.content, createdAt: new Date(row.created_at).toISOString() }));
  }
  async reserveTurn(sessionId: string, ownerId: string, clientRequestId: string, text: string, requestHash?: string, input?: SendTurnInput): Promise<{ turn: ChatTurn; created: boolean; dispatch?: TurnDispatch }> {
    const fingerprint=requestHash??turnTextFingerprint(text);
    if(!/^[a-f0-9]{64}$/.test(fingerprint)) throw new CoreError('INVALID_INPUT');
    return transaction(this.pool, async client => {
      const session = await client.query('SELECT id FROM sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE', [sessionId, ownerId]);
      if (!session.rowCount) throw new CoreError('NOT_FOUND');
      const existing = await client.query('SELECT * FROM turns WHERE session_id=$1 AND client_request_id=$2', [sessionId, clientRequestId]);
      if (existing.rowCount) {
        if (existing.rows[0].user_text !== text || (existing.rows[0].request_hash===null ? requestHash!==undefined : existing.rows[0].request_hash!==fingerprint)) throw new CoreError('IDEMPOTENCY_CONFLICT');
        return { turn: turn(existing.rows[0]), created: false };
      }
      const active = await client.query('SELECT id FROM turns WHERE session_id=$1 AND NOT(state=ANY($2::text[]))', [sessionId, terminal]);
      if (active.rowCount) throw new CoreError('TURN_ACTIVE');
      const result = await client.query(`INSERT INTO turns(id,session_id,owner_id,client_request_id,user_text,request_hash,sequence,state,request_input)
        SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(sequence),0)+1,'pending',$7 FROM turns WHERE session_id=$2 RETURNING *`,
      [randomUUID(), sessionId, ownerId, clientRequestId, text, fingerprint, input ?? null]);
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
    const result = await this.pool.query(`UPDATE turns SET state=$3,error_code=$4,
      finished_at=CASE WHEN $3=ANY($5::text[]) THEN now() ELSE NULL END
      WHERE id=$1 AND state=ANY($2::text[]) AND ${fence(6, 7)} RETURNING id`,
    [turnId, states, next, errorCode ?? null, terminal, leaseFence?.workerId ?? null, leaseFence?.attempt ?? null]);
    return result.rowCount === 1;
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
      await client.query(`INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES
        ($1,$2,$3,'user',$4,now()),($5,$2,$3,'assistant',$6,now())`,
      [randomUUID(), row.session_id, turnId, row.user_text, reply.messageId, reply.content]);
      return true;
    });
  }
  async getTurn(turnId: string, ownerId: string): Promise<ChatTurn | undefined> {
    const result = await this.pool.query('SELECT t.* FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=$1 AND s.owner_id=$2', [turnId, ownerId]);
    return result.rows[0] ? turn(result.rows[0]) : undefined;
  }
  async cancelTurn(turnId: string, ownerId: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE turns t SET state='cancelled',finished_at=now()
      FROM sessions s WHERE t.session_id=s.id AND t.id=$1 AND s.owner_id=$2 AND NOT(t.state=ANY($3::text[])) RETURNING t.id`, [turnId, ownerId, terminal]);
    return result.rowCount === 1;
  }
  async claimTurn(turnId: string, workerId: string, leaseMs: number): Promise<QueuedTurn | undefined> {
    // Only a pending, unleased (or expired) turn is claimable; the claim also retires its outbox entry.
    const result = await this.pool.query(`WITH claimed AS (
        UPDATE turns SET lease_owner=$2, lease_expires_at=now()+make_interval(secs => $3::double precision/1000), attempts=attempts+1
        WHERE id=$1 AND state='pending' AND request_input IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at < now())
        RETURNING *), retired AS (DELETE FROM turn_outbox o USING claimed c WHERE o.turn_id=c.id)
      SELECT * FROM claimed`, [turnId, workerId, leaseMs]);
    const row = result.rows[0];
    return row ? { turn: turn(row), input: row.request_input as SendTurnInput, fence: { workerId, attempt: row.attempts } } : undefined;
  }
  async renewLease(turnId: string, leaseFence: LeaseFence, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE turns SET lease_expires_at=now()+make_interval(secs => $4::double precision/1000)
      WHERE id=$1 AND lease_owner=$2 AND attempts=$3 AND state=ANY($5::text[]) RETURNING id`,
    [turnId, leaseFence.workerId, leaseFence.attempt, leaseMs, active]);
    return result.rowCount === 1;
  }
  async recoverExpired(maxAttempts: number): Promise<{ requeued: string[]; failed: string[] }> {
    // Expired leases either fail (attempts exhausted) or return to pending with a fresh dispatch in the outbox.
    const result = await this.pool.query(`WITH expired AS (
        UPDATE turns SET
          state=CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
          error_code=CASE WHEN attempts >= $1 THEN 'WORKER_LOST' ELSE error_code END,
          finished_at=CASE WHEN attempts >= $1 THEN now() ELSE NULL END,
          dispatch_seq=CASE WHEN attempts >= $1 THEN dispatch_seq ELSE dispatch_seq+1 END,
          lease_owner=NULL, lease_expires_at=NULL
        WHERE lease_expires_at < now() AND state=ANY($2::text[])
        RETURNING id, state, dispatch_seq), outbox AS (
        INSERT INTO turn_outbox(turn_id,seq) SELECT id, dispatch_seq FROM expired WHERE state='pending'
        ON CONFLICT (turn_id) DO UPDATE SET seq=EXCLUDED.seq, created_at=now(), published_at=NULL)
      SELECT id, state FROM expired`, [maxAttempts, active]);
    return { requeued: result.rows.filter(row => row.state === 'pending').map(row => row.id),
      failed: result.rows.filter(row => row.state === 'failed').map(row => row.id) };
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
