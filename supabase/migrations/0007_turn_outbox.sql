-- Goal2 scale rework: turns are delivered through Redis/BullMQ instead of being polled from Postgres.
-- The outbox is written in the reservation transaction and kept until a worker claims the turn, so a dispatch
-- lost by Redis (or never published) is published again by the dispatcher. It is a small, separate table so
-- its churn does not bloat `turns`. `dispatch_seq` grows on each requeue to give redeliveries a new job id.
BEGIN;
CREATE TABLE IF NOT EXISTS turn_outbox (
  turn_id text PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK(seq >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS turn_outbox_created ON turn_outbox(created_at);
ALTER TABLE turns ADD COLUMN IF NOT EXISTS dispatch_seq integer NOT NULL DEFAULT 0 CHECK(dispatch_seq >= 0);
-- The polling claim and backlog count used this index; claims are now by primary key.
DROP INDEX IF EXISTS turns_queue_pending;
INSERT INTO ptr_schema_migrations(name) VALUES ('0007_turn_outbox.sql') ON CONFLICT DO NOTHING;
COMMIT;
