BEGIN;
-- No legacy backfill: text alone cannot prove the original structured request intent/range.
ALTER TABLE turns ADD COLUMN IF NOT EXISTS request_hash text
  CHECK(request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$');
INSERT INTO ptr_schema_migrations(name) VALUES ('0002_turn_request_hash.sql') ON CONFLICT DO NOTHING;
COMMIT;
