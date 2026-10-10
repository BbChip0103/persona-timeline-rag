-- Additive, isolated split target only. Original source/vector tables stay untouched.
-- Caller validates loopback:58432 URL; Docker-forwarded server inet address is not loopback.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF current_database() NOT IN ('ptr_split_test','ptr_split_research')
 OR current_user <> 'ptr_split_owner' THEN
  RAISE EXCEPTION 'Isolated split migration owner required';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS llm.post_summary_runs (
 run_id text PRIMARY KEY, summary_model text NOT NULL, prompt_revision text NOT NULL,
 embedding_model_revision text NOT NULL, corpus_hash text NOT NULL,
 content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS llm.post_summary_run_sources (
 run_id text NOT NULL REFERENCES llm.post_summary_runs(run_id),
 source_id text NOT NULL REFERENCES llm.source_posts(id), person_id text NOT NULL,
 source_hash text NOT NULL, annotation_revision text, annotation_hash text,
 PRIMARY KEY(run_id,source_id), CHECK((annotation_revision IS NULL)=(annotation_hash IS NULL)));
CREATE TABLE IF NOT EXISTS llm.post_summaries (
 run_id text NOT NULL,source_id text NOT NULL,summary text NOT NULL,
 summary_model text NOT NULL,prompt_revision text NOT NULL,content_hash text NOT NULL,
 PRIMARY KEY(run_id,source_id),
 FOREIGN KEY(run_id,source_id) REFERENCES llm.post_summary_run_sources(run_id,source_id),
 CHECK(length(summary) BETWEEN 1 AND 1200),
 CHECK(array_length(string_to_array(summary,E'\n'),1)=3),
 CHECK(summary !~ '(^|\n)[[:space:]]*(\n|$)'));
COMMENT ON TABLE llm.post_summaries IS 'Generated search-only summaries, never source/citation truth';
CREATE TABLE IF NOT EXISTS llm.post_summary_vectors (
 run_id text NOT NULL,source_id text NOT NULL,model_revision text NOT NULL,
 embedding vector(1536) NOT NULL,content_hash text NOT NULL,
 PRIMARY KEY(run_id,source_id,model_revision),
 FOREIGN KEY(run_id,source_id) REFERENCES llm.post_summaries(run_id,source_id),
 CHECK(embedding <> array_fill(0::real,ARRAY[1536])::vector));
CREATE TABLE IF NOT EXISTS llm.active_summary_index (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 run_id text NOT NULL REFERENCES llm.post_summary_runs(run_id),
 embedding_model_revision text NOT NULL,activated_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION llm.ptr_reject_summary_mutation() RETURNS trigger
 LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Summary snapshots are immutable';END$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['post_summary_runs','post_summary_run_sources','post_summaries',
 'post_summary_vectors'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS summary_immutable ON llm.%I',t);
  EXECUTE format('CREATE TRIGGER summary_immutable BEFORE UPDATE OR DELETE ON llm.%I '
   'FOR EACH ROW EXECUTE FUNCTION llm.ptr_reject_summary_mutation()',t);
 END LOOP;
END $$;
-- Exact coverage, fresh parent + latest annotation binding, and one matching vector per source.
CREATE OR REPLACE FUNCTION llm.ptr_summary_run_complete(candidate text,model text)
 RETURNS boolean LANGUAGE sql STABLE SET search_path=llm,public AS $$
 SELECT EXISTS(SELECT 1 FROM llm.post_summary_runs r WHERE r.run_id=candidate
  AND r.embedding_model_revision=model)
 AND EXISTS(SELECT 1 FROM llm.post_summary_run_sources WHERE run_id=candidate)
 AND (SELECT count(*) FROM llm.source_posts WHERE origin='licensed_source' AND NOT unsafe)
  = (SELECT count(*) FROM llm.post_summary_run_sources WHERE run_id=candidate)
 AND NOT EXISTS(SELECT 1 FROM llm.post_summary_run_sources s
  LEFT JOIN llm.source_posts p ON p.id=s.source_id
  LEFT JOIN LATERAL(SELECT revision,content_hash FROM llm.source_image_revisions
   WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) a ON true
  LEFT JOIN llm.post_summaries z ON z.run_id=s.run_id AND z.source_id=s.source_id
  LEFT JOIN llm.post_summary_vectors v ON v.run_id=s.run_id AND v.source_id=s.source_id
   AND v.model_revision=model
  JOIN llm.post_summary_runs r ON r.run_id=s.run_id
  WHERE s.run_id=candidate AND (p.id IS NULL OR p.unsafe OR p.origin<>'licensed_source'
   OR p.person_id<>s.person_id OR p.source_hash<>s.source_hash
   OR a.revision IS DISTINCT FROM s.annotation_revision
   OR a.content_hash IS DISTINCT FROM s.annotation_hash OR z.source_id IS NULL
   OR z.summary_model<>r.summary_model OR z.prompt_revision<>r.prompt_revision
   OR v.source_id IS NULL OR v.embedding=array_fill(0::real,ARRAY[1536])::vector))
$$;
CREATE OR REPLACE FUNCTION llm.ptr_check_summary_parent() RETURNS trigger
 LANGUAGE plpgsql SET search_path=llm,public AS $$BEGIN
 IF TG_TABLE_NAME='post_summary_run_sources' THEN
  IF NOT EXISTS(SELECT 1 FROM llm.source_posts p
   LEFT JOIN LATERAL(SELECT revision,content_hash FROM llm.source_image_revisions
    WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) a ON true
   WHERE p.id=NEW.source_id AND p.person_id=NEW.person_id AND p.source_hash=NEW.source_hash
    AND p.origin='licensed_source' AND NOT p.unsafe
    AND a.revision IS NOT DISTINCT FROM NEW.annotation_revision
    AND a.content_hash IS NOT DISTINCT FROM NEW.annotation_hash) THEN
   RAISE EXCEPTION 'Summary parent snapshot mismatch'; END IF;
 ELSIF TG_TABLE_NAME='post_summaries' THEN
  IF NOT EXISTS(SELECT 1 FROM llm.post_summary_runs r WHERE r.run_id=NEW.run_id
   AND r.summary_model=NEW.summary_model AND r.prompt_revision=NEW.prompt_revision) THEN
   RAISE EXCEPTION 'Summary model/prompt mismatch'; END IF;
 ELSIF TG_TABLE_NAME='post_summary_vectors' THEN
  IF NOT EXISTS(SELECT 1 FROM llm.post_summary_runs r WHERE r.run_id=NEW.run_id
   AND r.embedding_model_revision=NEW.model_revision) THEN
   RAISE EXCEPTION 'Summary embedding model mismatch'; END IF;
 END IF; RETURN NEW;
END$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['post_summary_run_sources','post_summaries','post_summary_vectors'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS summary_parent ON llm.%I',t);
  EXECUTE format('CREATE TRIGGER summary_parent BEFORE INSERT ON llm.%I '
   'FOR EACH ROW EXECUTE FUNCTION llm.ptr_check_summary_parent()',t);
 END LOOP;
END$$;
CREATE OR REPLACE FUNCTION llm.ptr_check_summary_activation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=llm,public AS $$BEGIN
 LOCK TABLE llm.source_posts,llm.source_image_revisions IN SHARE MODE;
 IF NOT llm.ptr_summary_run_complete(NEW.run_id,NEW.embedding_model_revision) THEN
  RAISE EXCEPTION 'Summary index incomplete or stale'; END IF;
 RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS summary_activation ON llm.active_summary_index;
CREATE TRIGGER summary_activation BEFORE INSERT OR UPDATE ON llm.active_summary_index
 FOR EACH ROW EXECUTE FUNCTION llm.ptr_check_summary_activation();
REVOKE ALL ON llm.post_summary_runs,llm.post_summary_run_sources,llm.post_summaries,
 llm.post_summary_vectors,llm.active_summary_index FROM PUBLIC,ptr_split_app;
GRANT SELECT,INSERT ON llm.post_summary_runs,llm.post_summary_run_sources,llm.post_summaries,
 llm.post_summary_vectors TO ptr_split_llm;
GRANT SELECT,INSERT,UPDATE ON llm.active_summary_index TO ptr_split_llm;
-- Default privileges could grant mutations: explicitly remove them from immutable snapshots.
REVOKE UPDATE,DELETE ON llm.post_summary_runs,llm.post_summary_run_sources,llm.post_summaries,
 llm.post_summary_vectors FROM ptr_split_llm;
REVOKE DELETE ON llm.active_summary_index FROM ptr_split_llm;
INSERT INTO public.ptr_schema_migrations(name) VALUES('split/0003_post_summaries.sql')
 ON CONFLICT DO NOTHING;
COMMIT;
