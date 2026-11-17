-- Phase 1C pgTAP: background_jobs (migration 000009) — AD-01: table + idempotent enqueue + claim/complete/fail.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;
create function tests.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;

-- enqueue is idempotent on (job_type, idempotency_key)
set local role service_role;
create temp table tj as select public.enqueue_background_job('evidence.cleanup', 'k-1', '{"grace":180}'::jsonb) as id;
grant select on tj to service_role;
select ok((select id from tj) is not null, 'enqueue returns a job id');
select is(public.enqueue_background_job('evidence.cleanup', 'k-1', '{"grace":999}'::jsonb), (select id from tj),
          'same idempotency key: same job, no duplicate');
select is((select count(*) from public.background_jobs where job_type = 'evidence.cleanup' and idempotency_key = 'k-1'), 1::bigint, 'one row');
select is((select payload ->> 'grace' from public.background_jobs where id = (select id from tj)), '180', 'the first payload wins');
select ok(public.enqueue_background_job('evidence.cleanup', 'k-2') is distinct from (select id from tj), 'a different key is a different job');

-- claim: runs once, then nothing is due
select is((select status || '|' || attempts || '|' || locked_by from public.claim_background_job(array['evidence.cleanup'], 'w1') limit 1),
          'running|1|w1', 'claim locks the oldest due job and counts the attempt');
select ok(not exists (select 1 from public.claim_background_job(array['other.type'], 'w1')), 'job types are respected');
select is((select count(*) from public.claim_background_job(array['evidence.cleanup'], 'w2')), 1::bigint, 'the second due job goes to the next claim');
select is((select count(*) from public.claim_background_job(array['evidence.cleanup'], 'w3')), 0::bigint, 'running jobs are not handed out again');

-- complete: only by the locking worker
select is(public.complete_background_job((select id from tj), 'someone-else', '{}'::jsonb), false, 'a different worker cannot complete the job');
select is(public.complete_background_job((select id from tj), 'w1', '{"removed":2}'::jsonb), true, 'the locking worker completes it');
select is((select status || '|' || (result ->> 'removed') from public.background_jobs where id = (select id from tj)), 'succeeded|2', 'result stored');

-- fail: retry with backoff, then dead
select public.enqueue_background_job('evidence.cleanup', 'k-3', '{}'::jsonb, null, now(), 2);
select is((select idempotency_key from public.claim_background_job(array['evidence.cleanup'], 'w4')), 'k-3', 'k-3 is the next due job');
select is(public.fail_background_job((select id from public.background_jobs where idempotency_key = 'k-3'), 'not-the-worker', 'x'), null,
          'only the worker holding the lock can fail it');
select is(public.fail_background_job((select id from public.background_jobs where idempotency_key = 'k-3'), 'w4', 'boom 1', interval '10 minutes'), 'failed',
          'first failure -> failed (retryable)');
select ok((select run_after > now() + interval '9 minutes' from public.background_jobs where idempotency_key = 'k-3'), 'the retry is delayed (backoff)');
update public.background_jobs set run_after = now() - interval '1 minute' where idempotency_key = 'k-3';
select is((select attempts from public.claim_background_job(array['evidence.cleanup'], 'w4')), 2, 'a failed job is retried when due (attempt 2)');
select is(public.fail_background_job((select id from public.background_jobs where idempotency_key = 'k-3'), 'w4', 'boom 2'), 'dead', 'attempts exhausted -> dead');

-- stale locks (crashed worker): reclaimed, or killed once the last attempt was used
update public.background_jobs set locked_at = now() - interval '1 hour' where idempotency_key = 'k-2';
select is((select attempts from public.claim_background_job(array['evidence.cleanup'], 'w9')), 2, 'a job with an expired lock is picked up again');
select public.enqueue_background_job('evidence.cleanup', 'k-4', '{}'::jsonb, null, now(), 1);
select is((select attempts from public.claim_background_job(array['evidence.cleanup'], 'w5')), 1, 'k-4 claimed (its only attempt)');
update public.background_jobs set locked_at = now() - interval '1 hour' where idempotency_key = 'k-4';
select is((select count(*) from public.claim_background_job(array['evidence.cleanup'], 'w5')), 0::bigint, 'a crashed job with no attempts left is not retried');
select is((select status from public.background_jobs where idempotency_key = 'k-4'), 'dead', '... it is marked dead');

-- no client access, no deletes, history kept
reset role;
set local role authenticated;
select ok(tests.fails($$ select * from public.background_jobs $$) and tests.fails($$ select public.enqueue_background_job('x.y.z', 'k') $$),
          'signed-in users cannot read or enqueue jobs');
reset role;
set local role service_role;
select ok(tests.fails($$ delete from public.background_jobs $$), 'service role cannot delete job history');

select * from finish();
rollback;
