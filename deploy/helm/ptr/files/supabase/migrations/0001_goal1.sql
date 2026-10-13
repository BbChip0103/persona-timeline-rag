BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS ptr_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS personas (id text PRIMARY KEY, person_id text NOT NULL, current_revision text NOT NULL, UNIQUE(id,person_id));
CREATE TABLE IF NOT EXISTS persona_versions (
  persona_id text NOT NULL REFERENCES personas(id), revision text NOT NULL,
  document jsonb NOT NULL, content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (persona_id, revision)
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY, owner_id text NOT NULL, person_id text NOT NULL,
  persona_id text NOT NULL, persona_revision text NOT NULL, document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (persona_id, persona_revision) REFERENCES persona_versions(persona_id, revision),
  FOREIGN KEY (persona_id, person_id) REFERENCES personas(id, person_id),
  CHECK(document->>'id'=id AND document->>'ownerId'=owner_id AND document->>'personId'=person_id
    AND document->>'personaId'=persona_id AND document->>'personaRevision'=persona_revision)
);
CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner_id, created_at);
CREATE TABLE IF NOT EXISTS turns (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), owner_id text NOT NULL,
  client_request_id text NOT NULL, user_text text NOT NULL, sequence integer NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','retrieving','generating','validating','completed','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  reply jsonb, error_code text, UNIQUE(session_id, client_request_id), UNIQUE(session_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active ON turns(session_id)
  WHERE state IN ('pending','retrieving','generating','validating');
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), turn_id text REFERENCES turns(id),
  role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
  created_at timestamptz NOT NULL, ordinal bigint GENERATED ALWAYS AS IDENTITY,
  UNIQUE(turn_id, role)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_one_greeting ON messages(session_id) WHERE turn_id IS NULL;
CREATE TABLE IF NOT EXISTS source_posts (
  id text PRIMARY KEY, person_id text NOT NULL, posted_at timestamptz NOT NULL, event_date date,
  caption text NOT NULL, unsafe boolean NOT NULL, source_url text NOT NULL,
  snapshot text NOT NULL, source_hash text NOT NULL, content_hash text NOT NULL,
  origin text NOT NULL CHECK(origin IN ('licensed_source','synthetic_fixture')),
  document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_posts_person_posted ON source_posts(person_id, posted_at) WHERE NOT unsafe;
CREATE INDEX IF NOT EXISTS source_posts_person_event ON source_posts(person_id, event_date) WHERE NOT unsafe AND event_date IS NOT NULL;
CREATE TABLE IF NOT EXISTS source_vectors (
  source_id text NOT NULL REFERENCES source_posts(id), model_revision text NOT NULL,
  embedding vector(1536) NOT NULL, PRIMARY KEY(source_id, model_revision)
);
-- Immutability is enforced even when a caller bypasses the TypeScript import API.
CREATE OR REPLACE FUNCTION ptr_reject_source_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Source snapshots and persona revisions are immutable'; END $$;
DROP TRIGGER IF EXISTS source_posts_immutable ON source_posts;
CREATE TRIGGER source_posts_immutable BEFORE UPDATE OR DELETE ON source_posts FOR EACH ROW EXECUTE FUNCTION ptr_reject_source_mutation();
DROP TRIGGER IF EXISTS persona_versions_immutable ON persona_versions;
CREATE TRIGGER persona_versions_immutable BEFORE UPDATE OR DELETE ON persona_versions FOR EACH ROW EXECUTE FUNCTION ptr_reject_source_mutation();
DROP TRIGGER IF EXISTS source_vectors_immutable ON source_vectors;
CREATE TRIGGER source_vectors_immutable BEFORE UPDATE OR DELETE ON source_vectors FOR EACH ROW EXECUTE FUNCTION ptr_reject_source_mutation();
DROP TRIGGER IF EXISTS session_binding_immutable ON sessions;
CREATE TRIGGER session_binding_immutable BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION ptr_reject_source_mutation();
INSERT INTO ptr_schema_migrations(name) VALUES ('0001_goal1.sql') ON CONFLICT DO NOTHING;
COMMIT;
