-- Goal2 scale rework: the lease expiry moves out of the wide `turns` table into a small `turn_leases` table, so
-- lease heartbeats (every lease/3 per in-flight turn) no longer write `turns` rows (new tuple versions, WAL, dead
-- tuples, index churn on the active-lease index). The fencing token stays on `turns` (`lease_owner` + `attempts`):
-- it is written only on claim and recovery, and every fenced state write keeps checking it there. A lease row is
-- live only while (owner, attempt) equals that token; claim, recovery and terminal transitions keep them in step.
-- `turn_leases` holds only in-flight turns, so it has no secondary index (recovery scans it; heartbeats stay HOT
-- updates thanks to the fillfactor) and is vacuumed on a fixed small threshold instead of a fraction of its size.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- No claim, renewal or recovery may run between copying the leases and dropping the column.
LOCK TABLE turns IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS turn_leases (
  turn_id text PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  owner text NOT NULL,
  attempt integer NOT NULL CHECK(attempt >= 1),
  expires_at timestamptz NOT NULL
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 1000,
        autovacuum_vacuum_insert_scale_factor = 0, autovacuum_vacuum_insert_threshold = 1000,
        autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 1000);
-- Carry over leases of turns still in flight (stop API/worker/dispatcher processes before migrating).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='turns' AND column_name='lease_expires_at') THEN
    INSERT INTO turn_leases(turn_id, owner, attempt, expires_at)
      SELECT id, lease_owner, attempts, lease_expires_at FROM turns
      WHERE lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND attempts >= 1
        AND state IN ('pending','retrieving','generating','validating')
    ON CONFLICT (turn_id) DO NOTHING;
  END IF;
END $$;
DROP INDEX IF EXISTS turns_active_leases;
ALTER TABLE turns DROP COLUMN IF EXISTS lease_expires_at;
INSERT INTO ptr_schema_migrations(name) VALUES ('0008_turn_leases.sql') ON CONFLICT DO NOTHING;
COMMIT;
