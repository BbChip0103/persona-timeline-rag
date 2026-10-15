-- Bind private draft checkpoints to a session without exposing the key in artifact payloads.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$BEGIN
 IF current_database() NOT IN ('ptr_split_test','ptr_split_research')
 OR current_user <> 'ptr_split_owner' THEN RAISE EXCEPTION 'SPLIT_OWNER_REQUIRED'; END IF;
END$$;
ALTER TABLE app.generated_artifacts ADD COLUMN IF NOT EXISTS request_key text;
CREATE INDEX IF NOT EXISTS generated_artifacts_session_request_key
 ON app.generated_artifacts(session_id) WHERE request_key IS NOT NULL;
INSERT INTO public.ptr_schema_migrations(name)
 VALUES('split/0007_generated_artifact_request_key.sql') ON CONFLICT DO NOTHING;
COMMIT;
