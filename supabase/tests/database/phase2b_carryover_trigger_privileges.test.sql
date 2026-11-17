-- Slice 2B pgTAP: carry-over C1 (migration 000016) — SECURITY DEFINER trigger functions are not client-callable.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- The three named in the review.
select is(
  (select count(*)::int from unnest(array['vba_guard', 'vba_sync_cache', 'vehicle_documents_validate']) f
    where has_function_privilege('anon', format('public.%I()', f), 'execute')
       or has_function_privilege('authenticated', format('public.%I()', f), 'execute')),
  0, 'vba_guard, vba_sync_cache, vehicle_documents_validate: no EXECUTE for anon or authenticated');

select is(
  (select count(*)::int from unnest(array['vba_guard', 'vba_sync_cache', 'vehicle_documents_validate']) f
    where has_function_privilege('public', format('public.%I()', f), 'execute')),
  0, '… and none for PUBLIC');

-- Catalogue check: nothing in the public schema that returns trigger AND is SECURITY DEFINER is executable by
-- anon/authenticated. Catches any function the source audit missed, and any added later.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype and p.prosecdef
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'no SECURITY DEFINER trigger function in public is executable by anon or authenticated');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype and p.prosecdef
      and has_function_privilege('public', p.oid, 'execute')),
  0, 'no SECURITY DEFINER trigger function in public is executable by PUBLIC');

-- The guard is real: a client role cannot call one directly.
set local role anon;
select throws_ok($$select public.vba_guard()$$, '42501', null, 'anon cannot call vba_guard()');
select throws_ok($$select public.vba_sync_cache()$$, '42501', null, 'anon cannot call vba_sync_cache()');
reset role;
set local role authenticated;
select throws_ok($$select public.vehicle_documents_validate()$$, '42501', null, 'authenticated cannot call vehicle_documents_validate()');
reset role;

-- Triggers still fire after the revoke (EXECUTE is checked at CREATE TRIGGER, not at fire time).
select is(
  (select count(*)::int from pg_trigger t
    where not t.tgisinternal and t.tgfoid in (
      'public.vba_guard()'::regprocedure, 'public.vba_sync_cache()'::regprocedure,
      'public.vehicle_documents_validate()'::regprocedure)),
  3, 'the three triggers are still attached');

select * from finish();
rollback;
