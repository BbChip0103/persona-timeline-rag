-- Additive target-only upgrade for older research archives. Preserve every
-- original ledger value, reservation and immutable migration-budget baseline.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF current_database() NOT IN ('ptr_split_test','ptr_split_research') OR current_user <> 'ptr_split_owner' THEN
  RAISE EXCEPTION 'Isolated split migration owner required';
 END IF;
END $$;
ALTER TABLE llm.ptr_provider_requests ADD COLUMN IF NOT EXISTS request_kind text;
ALTER TABLE llm.ptr_provider_requests ADD COLUMN IF NOT EXISTS turn_id text;
ALTER TABLE llm.ptr_provider_requests ADD COLUMN IF NOT EXISTS receipt_received_at timestamptz;
ALTER TABLE llm.ptr_provider_requests ADD COLUMN IF NOT EXISTS response_scrubbed_at timestamptz;
-- Historical NULL scope stays unknown; never invent a turn binding/timestamp.
CREATE INDEX IF NOT EXISTS ptr_split_provider_receipts_age ON llm.ptr_provider_requests(receipt_received_at,key)
 WHERE response_json IS NOT NULL;
INSERT INTO public.ptr_schema_migrations(name) VALUES('split/0002_receipt_scope.sql') ON CONFLICT DO NOTHING;
COMMIT;
