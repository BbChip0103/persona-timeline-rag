-- Generated drafts are private app data; they are never licensed timeline sources.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5s';
DO $$ BEGIN
 IF current_database() NOT IN ('ptr_split_test','ptr_split_research')
 OR current_user <> 'ptr_split_owner' THEN
  RAISE EXCEPTION 'Isolated split migration owner required';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS app.generated_artifacts (
 id text PRIMARY KEY,
 session_id text NOT NULL REFERENCES app.sessions(id) ON DELETE CASCADE,
 owner_id text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 CHECK (payload->>'id'=id AND payload->>'sessionId'=session_id
  AND payload->>'ownerId'=owner_id),
 CHECK (payload->>'origin'='generated' AND payload->>'fictional'='true'
  AND payload->>'kind'='post_draft' AND payload->>'status'='draft')
);
CREATE INDEX IF NOT EXISTS generated_artifacts_owner_created ON app.generated_artifacts(owner_id,created_at DESC);
-- 0001 default privileges grant broad app DML to future tables; drafts are immutable.
REVOKE UPDATE,DELETE ON app.generated_artifacts FROM ptr_split_app;
GRANT SELECT,INSERT ON app.generated_artifacts TO ptr_split_app;
INSERT INTO public.ptr_schema_migrations(name)
 VALUES('split/0005_generated_artifacts.sql') ON CONFLICT DO NOTHING;
COMMIT;
