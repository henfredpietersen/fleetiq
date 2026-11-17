-- 016 — carry-over C1 from the PR #5/#6 reviews (slice 2B). Own migration; 001–015 are not edited.
--
-- Trigger functions are never meant to be called by a client, and a SECURITY DEFINER one that is callable
-- runs with its owner's rights. They were created without an explicit REVOKE, so Postgres' default
-- EXECUTE-to-PUBLIC (and Supabase's default grants to anon/authenticated in the public schema) still apply.
--
-- Audit of every SECURITY DEFINER function that `returns trigger` in 001–015 (from the migration source;
-- the pgTAP test phase2b_carryover_trigger_privileges re-checks it against pg_proc in CI):
--   audit_row_change()              001-003/006  already revoked from public, anon, authenticated (003, 006)
--   vba_guard()                     015          NOT revoked  -> fixed here
--   vba_sync_cache()                015          NOT revoked  -> fixed here
--   vehicle_documents_validate()    015          NOT revoked  -> fixed here
-- No other SECURITY DEFINER trigger function exists in 001–015. (SECURITY INVOKER trigger functions —
-- set_updated_at, prevent_column_change, user_roles_validate, audit_logs_immutable, user_roles_end_only,
-- append_only, approvals_guard, vehicles_guard — carry no elevated rights and are out of scope here.)
-- Not touched: public.rls_auto_enable() (Supabase project setting).
--
-- Revoking EXECUTE does not stop the triggers firing: Postgres checks EXECUTE on a trigger function when the
-- trigger is created, not when it fires.

revoke execute on function
  public.vba_guard(),
  public.vba_sync_cache(),
  public.vehicle_documents_validate()
from public, anon, authenticated;
