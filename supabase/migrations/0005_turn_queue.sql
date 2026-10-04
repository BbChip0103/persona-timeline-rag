-- Goal2 durable turn queue: worker leases with fencing (lease_owner + attempts) and the original
-- structured request so a separate worker process can rebuild the exact turn input.
BEGIN;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS request_input jsonb;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0);
-- Claim order / backlog count: unleased (or expired) pending queued turns.
CREATE INDEX IF NOT EXISTS turns_queue_pending ON turns(created_at) WHERE state='pending' AND request_input IS NOT NULL;
-- Recovery sweep: active turns holding a lease.
CREATE INDEX IF NOT EXISTS turns_active_leases ON turns(lease_expires_at)
  WHERE lease_expires_at IS NOT NULL AND state IN ('pending','retrieving','generating','validating');
INSERT INTO ptr_schema_migrations(name) VALUES ('0005_turn_queue.sql') ON CONFLICT DO NOTHING;
COMMIT;
