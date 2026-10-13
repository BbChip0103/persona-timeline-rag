-- Explicit isolated OWNER maintenance only; never execute from worker startup.
-- Preserve immutable migration baseline, all accounting and unknown reservations.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5s';
DO $$ DECLARE cap bigint; exposure bigint; BEGIN
 IF current_database() NOT IN ('ptr_split_test','ptr_split_research')
 OR current_user <> 'ptr_split_owner' THEN
  RAISE EXCEPTION 'Isolated split migration owner required';
 END IF;
 -- Same lock used by native reserve/finish serializes cap changes with admissions.
 SELECT cap_microusd INTO STRICT cap FROM llm.ptr_provider_budget
  WHERE id='global' FOR UPDATE;
 SELECT COALESCE(SUM(CASE WHEN state='settled'
  THEN COALESCE(actual_microusd,reserved_microusd)
  ELSE GREATEST(reserved_microusd,COALESCE(actual_microusd,0)) END),0)
 INTO exposure FROM llm.ptr_provider_requests;
 IF exposure > LEAST(cap,1000000) THEN
  RAISE EXCEPTION 'Existing provider exposure exceeds cumulative cap';
 END IF;
 UPDATE llm.ptr_provider_budget SET cap_microusd=LEAST(cap,1000000)
  WHERE id='global';
END $$;
-- A table-level UPDATE grant defeats a column-only revoke. Keep UPDATE(id)
-- solely because PostgreSQL SELECT FOR UPDATE needs UPDATE on at least one column.
-- The existing CHECK(id='global') prevents changing the singleton identity.
-- Also prohibit DELETE + INSERT from replacing the singleton with a higher cap.
REVOKE INSERT,DELETE,UPDATE ON llm.ptr_provider_budget FROM ptr_split_llm;
GRANT UPDATE(id) ON llm.ptr_provider_budget TO ptr_split_llm;
INSERT INTO public.ptr_schema_migrations(name)
 VALUES('split/0004_cumulative_budget_cap.sql') ON CONFLICT DO NOTHING;
COMMIT;
