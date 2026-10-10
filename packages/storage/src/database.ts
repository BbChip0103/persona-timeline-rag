import { Kysely, PostgresDialect, type ColumnType, type Generated, type GeneratedAlways } from 'kysely';
import type { Pool } from 'pg';
import type { ChatMessage, ChatReply, ChatSession, SendTurnInput, TurnState } from '@ptr/contracts';

type Timestamp = ColumnType<Date, string | Date, string | Date>;

interface SessionsTable {
  id: string;
  owner_id: string;
  person_id: string;
  persona_id: string;
  persona_revision: string;
  document: ChatSession;
  created_at: Timestamp;
}

interface MessagesTable {
  id: string;
  session_id: string;
  turn_id: string | null;
  role: ChatMessage['role'];
  content: string;
  created_at: Timestamp;
  ordinal: GeneratedAlways<string>;
}

interface TurnsTable {
  id: string;
  session_id: string;
  owner_id: string;
  client_request_id: string;
  user_text: string;
  sequence: number;
  state: TurnState;
  created_at: Generated<Date>;
  finished_at: Date | null;
  reply: ChatReply | null;
  error_code: string | null;
  request_hash: string | null;
  request_input: SendTurnInput | null;
  lease_owner: string | null;
  attempts: Generated<number>;
  dispatch_seq: Generated<number>;
}

/** Type declarations only: existing SQL remains the schema/migration authority. */
export interface ConversationDatabase {
  sessions: SessionsTable;
  messages: MessagesTable;
  turns: TurnsTable;
}

/** No new pool, connection, DDL or logging. The supplying runtime alone closes the shared pool. */
export function createConversationDatabase(pool: Pool): Kysely<ConversationDatabase> {
  return new Kysely<ConversationDatabase>({ dialect: new PostgresDialect({ pool }) });
}
