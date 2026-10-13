-- User decision 2026-10-05: raise the shared provider ledger from US$1/1000 calls to US$2/10000 calls.
-- Raises the ceiling only; existing request rows and spend are kept (never a reset).
-- The budget table is created lazily by PostgresBudgetLedger.initialize(); skip when absent.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.ptr_provider_budget') IS NOT NULL THEN
    ALTER TABLE ptr_provider_budget DROP CONSTRAINT IF EXISTS ptr_provider_budget_cap_microusd_check;
    ALTER TABLE ptr_provider_budget DROP CONSTRAINT IF EXISTS ptr_provider_budget_call_cap_check;
    ALTER TABLE ptr_provider_budget ADD CONSTRAINT ptr_provider_budget_cap_microusd_check CHECK(cap_microusd BETWEEN 0 AND 2000000);
    ALTER TABLE ptr_provider_budget ADD CONSTRAINT ptr_provider_budget_call_cap_check CHECK(call_cap BETWEEN 0 AND 10000);
    UPDATE ptr_provider_budget SET cap_microusd=2000000, call_cap=10000 WHERE id='global';
  END IF;
END $$;
INSERT INTO ptr_schema_migrations(name) VALUES ('0004_raise_provider_budget.sql') ON CONFLICT DO NOTHING;
COMMIT;
