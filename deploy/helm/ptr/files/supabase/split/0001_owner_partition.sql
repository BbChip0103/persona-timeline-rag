-- Run only as the migration owner, on a NEW restored private split database.
-- No source database is modified; runtime roles have no DDL or cross-owner access.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE SCHEMA app AUTHORIZATION ptr_split_owner;
CREATE SCHEMA llm AUTHORIZATION ptr_split_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ptr_split_app,ptr_split_llm;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','turns','messages','turn_outbox','turn_leases'] LOOP
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA app',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['personas','persona_versions','source_posts','source_vectors',
    'source_image_revisions','source_image_annotations','source_image_vectors',
    'ptr_provider_budget','ptr_provider_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA llm',t);
  END LOOP;
  -- TS serializer/graph namespaces are preserved, never assumed Python-wire-compatible.
  FOREACH t IN ARRAY ARRAY['checkpoints','checkpoint_blobs','checkpoint_writes','checkpoint_migrations'] LOOP
    IF to_regclass(format('public.%I',t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA llm',t);
      EXECUTE format('ALTER TABLE llm.%I RENAME TO %I',t,'legacy_ts_'||t);
    END IF;
  END LOOP;
END $$;
-- Public sessions retain document binding checks. Persona identity is checked by
-- the authenticated LLM projection API, not a cross-service foreign-key lookup.
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app.sessions'::regclass
  AND contype='f' AND confrelid IN ('llm.personas'::regclass,'llm.persona_versions'::regclass)
 LOOP EXECUTE format('ALTER TABLE app.sessions DROP CONSTRAINT %I',c.conname);END LOOP;
END $$;
-- Immutable source triggers must resolve exclusively within the LLM schema.
CREATE OR REPLACE FUNCTION llm.ptr_check_image_parent() RETURNS trigger LANGUAGE plpgsql
 SET search_path=llm,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM llm.source_posts p WHERE p.id=NEW.source_id
  AND p.person_id=NEW.person_id AND p.source_hash=NEW.source_hash AND NOT p.unsafe) THEN
  RAISE EXCEPTION 'Image annotation parent mismatch or unsafe parent';
 END IF;RETURN NEW;
END $$;
DROP TRIGGER image_revision_parent ON llm.source_image_revisions;
CREATE TRIGGER image_revision_parent BEFORE INSERT ON llm.source_image_revisions
 FOR EACH ROW EXECUTE FUNCTION llm.ptr_check_image_parent();
CREATE TABLE app.turn_execution_grants (
 turn_id text NOT NULL REFERENCES app.turns(id) ON DELETE CASCADE, dispatch_seq integer NOT NULL CHECK(dispatch_seq>=0),
 execution_id text NOT NULL UNIQUE, generation integer NOT NULL CHECK(generation>=1),
 context_hash text NOT NULL CHECK(context_hash ~ '^[0-9a-f]{64}$'),context jsonb NOT NULL,
 deadline_at bigint NOT NULL,result_hash text CHECK(result_hash ~ '^[0-9a-f]{64}$'), result jsonb,
 PRIMARY KEY(turn_id,generation),CHECK((result_hash IS NULL)=(result IS NULL)));
CREATE TABLE llm.result_receipts (
 execution_id text PRIMARY KEY,grant_hash text NOT NULL CHECK(grant_hash ~ '^[0-9a-f]{64}$'),
 result_hash text NOT NULL CHECK(result_hash ~ '^[0-9a-f]{64}$'),result_json jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),acknowledged_at timestamptz);
CREATE TABLE llm.ptr_provider_migration_budget (
 id text PRIMARY KEY CHECK(id='python-split-45'),
 baseline_committed_microusd bigint NOT NULL CHECK(baseline_committed_microusd>=0),
 extra_cap_microusd bigint NOT NULL CHECK(extra_cap_microusd=1000000),
 created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO llm.ptr_provider_migration_budget(id,baseline_committed_microusd,extra_cap_microusd)
 SELECT 'python-split-45',COALESCE(SUM(CASE WHEN state='settled' AND actual_microusd IS NOT NULL
  THEN actual_microusd ELSE GREATEST(reserved_microusd,COALESCE(actual_microusd,0)) END),0),1000000
 FROM llm.ptr_provider_requests;
CREATE OR REPLACE FUNCTION llm.ptr_reject_budget_baseline_mutation() RETURNS trigger
 LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Migration budget baseline is immutable';END$$;
CREATE TRIGGER migration_budget_immutable BEFORE UPDATE OR DELETE ON llm.ptr_provider_migration_budget
 FOR EACH ROW EXECUTE FUNCTION llm.ptr_reject_budget_baseline_mutation();
REVOKE ALL ON SCHEMA app,llm FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO ptr_split_app;
GRANT USAGE ON SCHEMA llm TO ptr_split_llm;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app TO ptr_split_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app TO ptr_split_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA llm TO ptr_split_llm;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA llm TO ptr_split_llm;
REVOKE INSERT,UPDATE,DELETE ON llm.ptr_provider_migration_budget FROM ptr_split_llm;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ptr_split_app,ptr_split_llm;
ALTER DEFAULT PRIVILEGES FOR ROLE ptr_split_owner IN SCHEMA app
 GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ptr_split_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ptr_split_owner IN SCHEMA llm
 GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ptr_split_llm;
ALTER DEFAULT PRIVILEGES FOR ROLE ptr_split_owner IN SCHEMA app GRANT USAGE,SELECT ON SEQUENCES TO ptr_split_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ptr_split_owner IN SCHEMA llm GRANT USAGE,SELECT ON SEQUENCES TO ptr_split_llm;
INSERT INTO public.ptr_schema_migrations(name) VALUES('split/0001_owner_partition.sql');
COMMIT;
