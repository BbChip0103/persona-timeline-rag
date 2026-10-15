BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS summary text CHECK(char_length(summary)<=2000),
 ADD COLUMN IF NOT EXISTS summary_last_message_id text REFERENCES public.messages(id), ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.sessions'::regclass AND conname='session_summary_pair') THEN ALTER TABLE public.sessions ADD CONSTRAINT session_summary_pair CHECK((summary IS NULL)=(summary_last_message_id IS NULL));END IF;END $$;
ALTER TABLE public.turns ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
 ADD COLUMN IF NOT EXISTS user_memory_consent_at_input boolean NOT NULL DEFAULT false;
-- Session identity and the original document stay immutable; C4 owns only consent and memory state.
CREATE OR REPLACE FUNCTION public.ptr_guard_session_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['document','summary','summary_last_message_id','deleted_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['document','summary','summary_last_message_id','deleted_at'])
    OR (NEW.document-'userMemoryConsent') IS DISTINCT FROM (OLD.document-'userMemoryConsent') THEN
  RAISE EXCEPTION 'Session binding is immutable';
 END IF;
 IF NEW.document ? 'userMemoryConsent' AND jsonb_typeof(NEW.document->'userMemoryConsent') IS DISTINCT FROM 'boolean' THEN
  RAISE EXCEPTION 'Session memory consent must be boolean';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS session_binding_immutable ON public.sessions;
CREATE TRIGGER session_binding_immutable BEFORE UPDATE ON public.sessions
 FOR EACH ROW EXECUTE FUNCTION public.ptr_guard_session_binding();

CREATE TABLE IF NOT EXISTS public.user_memories (
 id text PRIMARY KEY, owner_id text NOT NULL, persona_id text NOT NULL,
 origin_session_id text NOT NULL REFERENCES public.sessions(id),
 kind text NOT NULL CHECK(kind IN ('name','like','dislike','recent_event','other')),
 text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 120),
 forgotten boolean NOT NULL DEFAULT false, forgotten_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT memory_forgotten_time CHECK(forgotten OR forgotten_at IS NULL)
);
ALTER TABLE public.user_memories ADD COLUMN IF NOT EXISTS forgotten_at timestamptz;
UPDATE public.user_memories SET forgotten_at=created_at WHERE forgotten AND forgotten_at IS NULL;
CREATE INDEX IF NOT EXISTS user_memories_owner_persona ON public.user_memories(owner_id,persona_id);
CREATE OR REPLACE FUNCTION public.ptr_guard_user_memory() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.forgotten AND NOT OLD.forgotten THEN NEW.forgotten_at=now(); END IF;
 IF TG_OP='UPDATE' AND OLD.forgotten AND NOT NEW.forgotten THEN
  RAISE EXCEPTION 'Forgotten user memory cannot be restored';
 END IF;
 IF TG_OP='UPDATE' AND NEW.forgotten AND NEW.id=OLD.id AND NEW.created_at=OLD.created_at
  AND NEW.owner_id=OLD.owner_id AND NEW.persona_id=OLD.persona_id
  AND NEW.origin_session_id=OLD.origin_session_id AND NEW.kind=OLD.kind AND NEW.text=OLD.text THEN RETURN NEW;END IF;
 -- The advisory lock serializes inserts across different origin sessions for this owner/persona.
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_id||':'||NEW.persona_id,0));
 IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE id=NEW.origin_session_id AND owner_id=NEW.owner_id
  AND persona_id=NEW.persona_id AND deleted_at IS NULL AND document->'userMemoryConsent'='true'::jsonb) THEN
  RAISE EXCEPTION 'User memory consent or binding missing';
 END IF;
 IF (SELECT count(*) FROM public.user_memories WHERE owner_id=NEW.owner_id
  AND persona_id=NEW.persona_id AND NOT forgotten AND id<>NEW.id)>=30 THEN
  RAISE EXCEPTION 'User memory limit reached';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS user_memory_guard ON public.user_memories;
CREATE TRIGGER user_memory_guard BEFORE INSERT OR UPDATE OF owner_id,persona_id,origin_session_id,kind,text,forgotten ON public.user_memories FOR EACH ROW EXECUTE FUNCTION public.ptr_guard_user_memory();
INSERT INTO public.ptr_schema_migrations(name) VALUES('0010_conversation_memory.sql') ON CONFLICT DO NOTHING;
COMMIT;
