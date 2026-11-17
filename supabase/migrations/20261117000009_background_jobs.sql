-- Phase 1C — background_jobs (AD-01 Approved, ARCH §11): a Postgres job table plus a worker.
-- This slice ships the table, the claim/complete/fail functions and ONE handler (unregistered
-- upload cleanup). No scheduler (pg_cron) yet: jobs are enqueued and run manually.
-- Service-role only (ARCH §5.3): no client grants, RLS on with no policies.

create table public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id),             -- NULL = system-wide job
  job_type text not null check (job_type ~ '^[a-z][a-z0-9_.]{2,63}$'),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts >= 1),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint background_jobs_idempotent unique (job_type, idempotency_key)
);
create index background_jobs_pick_idx on public.background_jobs (run_after) where status in ('queued', 'failed');

alter table public.background_jobs enable row level security;
revoke all on public.background_jobs from public, anon, authenticated;
revoke all on public.background_jobs from service_role;
grant select, insert, update on public.background_jobs to service_role; -- no delete: job history is kept

-- Idempotent enqueue: the same (job_type, idempotency_key) returns the existing job id.
create function public.enqueue_background_job(
  p_job_type text, p_idempotency_key text, p_payload jsonb default '{}'::jsonb,
  p_company_id uuid default null, p_run_after timestamptz default now(), p_max_attempts integer default 5
) returns uuid
language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.background_jobs (company_id, job_type, idempotency_key, payload, run_after, max_attempts)
  values (p_company_id, p_job_type, p_idempotency_key, coalesce(p_payload, '{}'::jsonb),
          coalesce(p_run_after, now()), p_max_attempts)
  on conflict (job_type, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.background_jobs
    where job_type = p_job_type and idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end $$;

-- Claim one due job (SKIP LOCKED so workers never double-process). A 'running' job whose lock is
-- older than p_lock_timeout is treated as crashed and is picked up again, or killed once it has
-- used all its attempts.
create function public.claim_background_job(
  p_job_types text[], p_worker text, p_lock_timeout interval default interval '15 minutes'
) returns setof public.background_jobs
language plpgsql set search_path = '' as $$
declare j public.background_jobs;
begin
  update public.background_jobs
     set status = 'dead', finished_at = now(), updated_at = now(),
         last_error = coalesce(last_error || '; ', '') || 'lock expired after the final attempt'
   where status = 'running' and locked_at < now() - p_lock_timeout and attempts >= max_attempts;

  select * into j from public.background_jobs
   where job_type = any (p_job_types)
     and ((status in ('queued', 'failed') and run_after <= now())
          or (status = 'running' and locked_at < now() - p_lock_timeout))
   order by run_after, created_at
   limit 1
   for update skip locked;
  if not found then
    return;
  end if;
  update public.background_jobs
     set status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = p_worker, updated_at = now()
   where id = j.id
   returning * into j;
  return next j;
end $$;

create function public.complete_background_job(p_id uuid, p_worker text, p_result jsonb default null)
returns boolean
language plpgsql set search_path = '' as $$
declare n integer;
begin
  update public.background_jobs
     set status = 'succeeded', result = p_result, finished_at = now(), updated_at = now(),
         locked_at = null, last_error = null
   where id = p_id and status = 'running' and locked_by = p_worker;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Retry with linear backoff (attempts * p_retry_in); 'dead' once attempts are used up.
create function public.fail_background_job(
  p_id uuid, p_worker text, p_error text, p_retry_in interval default interval '5 minutes'
) returns text
language plpgsql set search_path = '' as $$
declare j public.background_jobs;
begin
  select * into j from public.background_jobs
   where id = p_id and status = 'running' and locked_by = p_worker
   for update;
  if not found then
    return null;
  end if;
  if j.attempts >= j.max_attempts then
    update public.background_jobs
       set status = 'dead', last_error = left(p_error, 2000), finished_at = now(), updated_at = now(), locked_at = null
     where id = j.id;
    return 'dead';
  end if;
  update public.background_jobs
     set status = 'failed', last_error = left(p_error, 2000), updated_at = now(), locked_at = null,
         run_after = now() + p_retry_in * j.attempts
   where id = j.id;
  return 'failed';
end $$;

revoke all on function public.enqueue_background_job(text, text, jsonb, uuid, timestamptz, integer),
  public.claim_background_job(text[], text, interval),
  public.complete_background_job(uuid, text, jsonb),
  public.fail_background_job(uuid, text, text, interval)
  from public, anon, authenticated;
grant execute on function public.enqueue_background_job(text, text, jsonb, uuid, timestamptz, integer),
  public.claim_background_job(text[], text, interval),
  public.complete_background_job(uuid, text, jsonb),
  public.fail_background_job(uuid, text, text, interval)
  to service_role;
