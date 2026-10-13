BEGIN;
-- Explicit setup/migration only. Serving processes never create/alter this schema.
CREATE TABLE IF NOT EXISTS ptr_provider_budget (
 id text PRIMARY KEY CHECK(id='global'), cap_microusd bigint NOT NULL CHECK(cap_microusd BETWEEN 0 AND 2000000),
 call_cap integer NOT NULL CHECK(call_cap BETWEEN 0 AND 10000));
INSERT INTO ptr_provider_budget VALUES ('global',2000000,10000) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ptr_provider_requests (
 key text PRIMARY KEY,state text NOT NULL CHECK(state IN ('reserved','submitted','settled','unknown')),
 reserved_microusd bigint NOT NULL CHECK(reserved_microusd>=0),actual_microusd bigint CHECK(actual_microusd>=0),
 response_json jsonb,generation_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE ptr_provider_requests ADD COLUMN IF NOT EXISTS request_kind text;
ALTER TABLE ptr_provider_requests ADD COLUMN IF NOT EXISTS turn_id text;
ALTER TABLE ptr_provider_requests ADD COLUMN IF NOT EXISTS receipt_received_at timestamptz;
ALTER TABLE ptr_provider_requests ADD COLUMN IF NOT EXISTS response_scrubbed_at timestamptz;
-- Safe historical timestamp backfill, NOT invented turn links. Unscoped historical records are deferred.
UPDATE ptr_provider_requests SET receipt_received_at=updated_at
 WHERE response_json IS NOT NULL AND receipt_received_at IS NULL;
CREATE INDEX IF NOT EXISTS ptr_provider_receipts_age ON ptr_provider_requests(receipt_received_at,key)
 WHERE response_json IS NOT NULL;
INSERT INTO ptr_schema_migrations(name) VALUES ('0009_provider_receipt_scope.sql') ON CONFLICT DO NOTHING;
COMMIT;
