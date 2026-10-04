import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { ChatMessage, ChatReply, ChatSession, ChatTurn, SendTurnInput, TurnState } from '@ptr/contracts';
import { CoreError, turnTextFingerprint, type ConversationStore, type LeaseFence, type QueuedTurn, type TurnQueue } from '@ptr/core';
import { transaction } from './pool.js';

const terminal = ['completed', 'failed', 'cancelled'];
const active = ['pending', 'retrieving', 'generating', 'validating'];
// Fence clause: $f1 worker id, $f2 attempt. A NULL worker id means an unfenced (inline) write.
const fence = (f1: number, f2: number) => `($${f1}::text IS NULL OR (lease_owner=$${f1} AND attempts=$${f2}))`;
function turn(row: QueryResultRow): ChatTurn {
  return { id: row.id, sessionId: row.session_id, ownerId: row.owner_id,
    clientRequestId: row.client_request_id, userText: row.user_text, sequence: row.sequence,
    state: row.state, createdAt: new Date(row.created_at).toISOString(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {}),
    ...(row.reply ? { reply: row.reply } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) };
}

export class PostgresConversationStore implements ConversationStore, TurnQueue {
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
  async reserveTurn(sessionId: string, ownerId: string, clientRequestId: string, text: string, requestHash?: string, input?: SendTurnInput): Promise<{ turn: ChatTurn; created: boolean }> {
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
      return { turn: turn(result.rows[0]), created: true };
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
  async claimTurns(workerId: string, leaseMs: number, limit: number): Promise<QueuedTurn[]> {
    if (!Number.isInteger(limit) || limit < 1) return [];
    const result = await this.pool.query(`WITH next AS (
        SELECT id FROM turns WHERE state='pending' AND request_input IS NOT NULL
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $3)
      UPDATE turns t SET lease_owner=$1, lease_expires_at=now()+make_interval(secs => $2::double precision/1000), attempts=t.attempts+1
      FROM next WHERE t.id=next.id RETURNING t.*`, [workerId, leaseMs, limit]);
    return result.rows.map(row => ({ turn: turn(row), input: row.request_input as SendTurnInput, fence: { workerId, attempt: row.attempts } }));
  }
  async renewLease(turnId: string, leaseFence: LeaseFence, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE turns SET lease_expires_at=now()+make_interval(secs => $4::double precision/1000)
      WHERE id=$1 AND lease_owner=$2 AND attempts=$3 AND state=ANY($5::text[]) RETURNING id`,
    [turnId, leaseFence.workerId, leaseFence.attempt, leaseMs, active]);
    return result.rowCount === 1;
  }
  async recoverExpired(maxAttempts: number): Promise<{ requeued: number; failed: number }> {
    const result = await this.pool.query(`UPDATE turns SET
        state=CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
        error_code=CASE WHEN attempts >= $1 THEN 'WORKER_LOST' ELSE error_code END,
        finished_at=CASE WHEN attempts >= $1 THEN now() ELSE NULL END
      WHERE lease_expires_at < now() AND state=ANY($2::text[])
        AND (attempts >= $1 OR state <> 'pending')
      RETURNING state`, [maxAttempts, active]);
    const failed = result.rows.filter(row => row.state === 'failed').length;
    return { requeued: result.rows.length - failed, failed };
  }
  async queueDepth(): Promise<number> {
    const result = await this.pool.query(`SELECT count(*)::int AS n FROM turns WHERE state='pending' AND request_input IS NOT NULL
      AND (lease_expires_at IS NULL OR lease_expires_at < now())`);
    return result.rows[0].n;
  }
}
