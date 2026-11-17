-- Slice 2B pgTAP: migration 000017 — a staff password hash can only change with a server authorisation.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

create schema tests;
create function tests.id(n text) returns uuid language sql immutable as $$ select md5('fleetiq-test-' || n)::uuid $$;
create function tests.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
create function tests.fails_42501(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return sqlstate = '42501'; end $$;
create function tests.mk_user(n text, comp text, utype text default 'staff') returns void language sql as $$
  insert into auth.users (id, email) values (tests.id(n), n || '@example.test');
  insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
  values (tests.id(n), tests.id(comp), 'Synthetic ' || n, n || '@example.test', utype, n);
$$;
create function tests.set_hash(n text, h text) returns void language sql as $$
  update auth.users set encrypted_password = h where id = tests.id(n);
$$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
select tests.mk_user('staff1', 'coA'), tests.mk_user('mgr', 'coA'), tests.mk_user('drv', 'coA', 'driver'), tests.mk_user('other_b', 'coB');

-- 1–2: no authorisation -> refused; hash unchanged
select ok(tests.fails_42501($$select tests.set_hash('staff1', 'hash-weak')$$), 'staff hash change without authorisation is refused (42501)');
select is((select encrypted_password from auth.users where id = tests.id('staff1')), null, 'the hash did not change');

-- 3–5: authorised once -> allowed, consumed, audited
select lives_ok($$select public.authorise_staff_password_change(tests.id('staff1'), tests.id('mgr'))$$, 'authorise (manager -> staff)');
select lives_ok($$select tests.set_hash('staff1', 'hash-1')$$, 'the authorised change succeeds');
select isnt((select consumed_at from public.staff_password_authorisations where user_id = tests.id('staff1')), null, 'the authorisation is consumed');

-- 6: single use
select ok(tests.fails_42501($$select tests.set_hash('staff1', 'hash-2')$$), 'a second change needs a new authorisation (single use)');

-- 7: expired authorisation is useless
insert into public.staff_password_authorisations (company_id, user_id, actor_id, created_at, expires_at)
values (tests.id('coA'), tests.id('staff1'), tests.id('mgr'), now() - interval '1 minute', now() - interval '30 seconds');
select ok(tests.fails_42501($$select tests.set_hash('staff1', 'hash-3')$$), 'an expired authorisation does not allow the change');

-- 8: an authorisation for someone else does not help
select public.authorise_staff_password_change(tests.id('mgr'), tests.id('mgr'));
select ok(tests.fails_42501($$select tests.set_hash('staff1', 'hash-4')$$), 'another user''s authorisation does not allow the change');

-- 9–10: unrelated updates and no-op hash updates are not blocked
select lives_ok($$update auth.users set raw_user_meta_data = '{"x":1}' where id = tests.id('staff1')$$, 'other auth.users columns are not blocked');
select lives_ok($$select tests.set_hash('staff1', 'hash-1')$$, 'writing the same hash is not a change');

-- 11: drivers (PIN rules) are not affected
select lives_ok($$select tests.set_hash('drv', 'pin-hash')$$, 'a driver''s hash can change without staff authorisation');

-- 12–14: the authoriser refuses drivers, cross-company actors and unknown users
select ok(tests.fails_42501($$select public.authorise_staff_password_change(tests.id('drv'), tests.id('mgr'))$$), 'cannot authorise a driver');
select ok(tests.fails_42501($$select public.authorise_staff_password_change(tests.id('staff1'), tests.id('other_b'))$$), 'cannot authorise with an actor from another company');
select ok(tests.fails_42501($$select public.authorise_staff_password_change(tests.id('nobody'), tests.id('mgr'))$$), 'cannot authorise an unknown user');

-- 15–16: clients cannot call the authoriser or the guard; only the service role can authorise
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r
    where has_function_privilege(r, 'public.authorise_staff_password_change(uuid, uuid)', 'execute')
       or has_function_privilege(r, 'public.staff_password_guard()', 'execute')),
  0, 'anon and authenticated cannot execute the authoriser or the guard');
select ok(has_function_privilege('service_role', 'public.authorise_staff_password_change(uuid, uuid)', 'execute'), 'service_role can authorise');

-- 17: no client can touch the table
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p
    where has_table_privilege(r, 'public.staff_password_authorisations', p)),
  0, 'anon and authenticated have no privileges on staff_password_authorisations');

-- 18: audited (no secrets: the table holds none)
select cmp_ok((select count(*)::int from public.audit_logs where entity_type = 'staff_password_authorisations'), '>=', 3, 'authorisations are audited');

-- 19: the guard trigger is attached to auth.users
select is((select count(*)::int from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'staff_password_guard' and not tgisinternal), 1, 'staff_password_guard is attached to auth.users');

select * from finish();
rollback;
