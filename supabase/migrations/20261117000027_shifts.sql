-- 027 — Slice 3A: shift templates and shifts (DB v1.6 §5 shift_templates / shifts, §20 status catalogue, §22;
-- PRD v1.11 §4.2, §5.5; ARCH v1.11 §5.2, §6.1; DEC-23 permission matrix; AD-06 text + CHECK statuses; AD-05).
-- Authorisation: `allocation.manage` for the row's branch (company-wide grant = every branch) is the only write
-- permission (no new permission key); `reports.view` or `allocation.manage` may read. Drivers have no direct access
-- in this slice (3C exposes a driver's own shifts through allocations).
-- Write model: no INSERT/UPDATE/DELETE grants on the tables; every write goes through the SECURITY DEFINER functions
-- below (search_path = '', explicit REVOKE from public/anon, EXECUTE to authenticated only). No hard deletes
-- (forbid_delete / no_truncate); audit via audit_row_change. A template is archived, never deleted; a shift is
-- cancelled, never deleted. Shifts carry their own times, so editing or archiving a template never changes them.
-- Time rule (one place): shift_times() — Africa/Johannesburg, end on the next day when end time < start time.
-- Conventions: FK covering indexes in FK column order; (select ...) around argument-free calls in RLS.

-- ---------------------------------------------------------------- the one time calculation
create function public.shift_times(p_date date, p_start time, p_end time)
returns table (scheduled_start_at timestamptz, scheduled_end_at timestamptz)
language plpgsql stable set search_path = '' as $$
begin
  if p_date is null or p_start is null or p_end is null then
    raise exception 'a date, a start time and an end time are required' using errcode = '22023';
  end if;
  if p_start = p_end then
    raise exception 'the start and end time cannot be the same' using errcode = '22023';
  end if;
  scheduled_start_at := (p_date + p_start) at time zone 'Africa/Johannesburg';
  scheduled_end_at   := ((case when p_end < p_start then p_date + 1 else p_date end) + p_end) at time zone 'Africa/Johannesburg';
  return next;
end $$;
revoke all on function public.shift_times(date, time, time) from public, anon;
grant execute on function public.shift_times(date, time, time) to authenticated, service_role;

-- ---------------------------------------------------------------- shift_templates
create table public.shift_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  name text not null check (name = btrim(name) and length(name) between 1 and 100),
  start_time time not null,
  end_time time not null,
  crosses_midnight boolean not null,
  status text not null default 'active' check (status in ('active', 'archived')),   -- AD-06, DB §20
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  unique (id, company_id),
  unique (id, branch_id, company_id),                -- target of shifts' composite FK: a shift's template is in its branch
  constraint shift_templates_times_differ check (start_time <> end_time),
  constraint shift_templates_crosses_midnight check (crosses_midnight = (end_time < start_time))
);
create index shift_templates_company_id_status_idx     on public.shift_templates (company_id, status);
create index shift_templates_branch_id_company_id_idx  on public.shift_templates (branch_id, company_id);
create index shift_templates_created_by_company_id_idx on public.shift_templates (created_by, company_id);
-- one active template per name per branch, case-insensitive; archiving frees the name
create unique index shift_templates_active_name_uq on public.shift_templates (branch_id, lower(name)) where status = 'active';

create trigger shift_templates_immutable before update on public.shift_templates for each row
  execute function public.prevent_column_change('id', 'company_id', 'branch_id', 'created_by', 'created_at');
create trigger shift_templates_updated_at before update on public.shift_templates for each row execute function public.set_updated_at();

-- An archived template is final (no edits, no un-archive); the only status move is active -> archived.
create function public.shift_templates_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'archived' then
    raise exception 'an archived shift template cannot be changed' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger shift_templates_guard_t before update on public.shift_templates for each row execute function public.shift_templates_guard();
create trigger shift_templates_no_delete   before delete   on public.shift_templates for each row       execute function public.forbid_delete();
create trigger shift_templates_no_truncate before truncate on public.shift_templates for each statement execute function public.forbid_delete();
create trigger shift_templates_audit after insert or update or delete on public.shift_templates
  for each row execute function public.audit_row_change();
revoke execute on function public.shift_templates_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- shifts
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  department_id uuid references public.departments (id),
  shift_template_id uuid,
  shift_date date not null,                          -- Africa/Johannesburg date of scheduled_start_at
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  actual_start_at timestamptz,                       -- NOT written in 3A; later phases derive these from allocations
  actual_end_at timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),   -- AD-06, DB §20
  cancel_reason text check (cancel_reason = btrim(cancel_reason) and length(cancel_reason) between 1 and 500),
  cancelled_by uuid,
  cancelled_at timestamptz,
  client_submission_id uuid not null,                -- idempotency
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (shift_template_id, branch_id, company_id) references public.shift_templates (id, branch_id, company_id),
  foreign key (cancelled_by, company_id) references public.profiles (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  unique (id, company_id),
  constraint shifts_idempotent unique (company_id, created_by, client_submission_id),
  constraint shifts_end_after_start check (scheduled_end_at > scheduled_start_at),
  constraint shifts_date_is_local_start_date check (shift_date = (scheduled_start_at at time zone 'Africa/Johannesburg')::date),
  constraint shifts_actuals_ordered check (actual_end_at is null or actual_start_at is null or actual_end_at >= actual_start_at),
  constraint shifts_cancelled_shape check (
    (status = 'cancelled' and cancel_reason is not null and cancelled_by is not null and cancelled_at is not null)
    or (status = 'scheduled' and cancel_reason is null and cancelled_by is null and cancelled_at is null))
);
create index shifts_branch_id_shift_date_idx          on public.shifts (branch_id, shift_date);
create index shifts_company_id_idx                    on public.shifts (company_id);
create index shifts_branch_id_company_id_idx          on public.shifts (branch_id, company_id);
create index shifts_department_id_idx                 on public.shifts (department_id);
create index shifts_template_branch_company_idx       on public.shifts (shift_template_id, branch_id, company_id);
create index shifts_cancelled_by_company_id_idx       on public.shifts (cancelled_by, company_id);
create index shifts_created_by_company_id_idx         on public.shifts (created_by, company_id);
-- at most one scheduled shift per template per date; cancelling frees the date
create unique index shifts_template_date_scheduled_uq on public.shifts (shift_template_id, shift_date)
  where shift_template_id is not null and status = 'scheduled';

-- Identity and schedule never change; the only edit is scheduled -> cancelled (cancel_shift), and a cancelled shift is final.
create trigger shifts_immutable before update on public.shifts for each row
  execute function public.prevent_column_change('id', 'company_id', 'branch_id', 'department_id', 'shift_template_id', 'shift_date',
    'scheduled_start_at', 'scheduled_end_at', 'client_submission_id', 'created_by', 'created_at');
create trigger shifts_updated_at before update on public.shifts for each row execute function public.set_updated_at();

create function public.shifts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d public.departments;
begin
  if tg_op = 'INSERT' then
    -- a department, if set, is in the same company and is company-wide or in the shift's branch
    if new.department_id is not null then
      select * into d from public.departments where id = new.department_id;
      if not found or d.company_id <> new.company_id or (d.branch_id is not null and d.branch_id <> new.branch_id) then
        raise exception 'the department must be in the same company and either company-wide or in the shift''s branch'
          using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if old.status = 'cancelled' then
    raise exception 'a cancelled shift cannot be changed' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger shifts_guard_t before insert or update on public.shifts for each row execute function public.shifts_guard();
create trigger shifts_no_delete   before delete   on public.shifts for each row       execute function public.forbid_delete();
create trigger shifts_no_truncate before truncate on public.shifts for each statement execute function public.forbid_delete();
create trigger shifts_audit after insert or update or delete on public.shifts
  for each row execute function public.audit_row_change();
revoke execute on function public.shifts_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- slice 3B hook
-- A shift with live allocations cannot be cancelled. Allocations arrive in 3B, which replaces this body; until
-- then there is nothing to protect. Internal: only cancel_shift() calls it.
create function public.shift_has_active_allocations(p_shift_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select false
$$;
revoke all on function public.shift_has_active_allocations(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- templates: create / update / archive
create function public.create_shift_template(p_branch_id uuid, p_name text, p_start_time time, p_end_time time)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_name text := btrim(p_name);
  v_id uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company) then
    raise exception 'branch not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('allocation.manage', p_branch_id) then
    raise exception 'missing permission allocation.manage for this branch' using errcode = '42501';
  end if;
  if v_name is null or length(v_name) not between 1 and 100 then
    raise exception 'a template name (1-100 characters) is required' using errcode = '22023';
  end if;
  if p_start_time is null or p_end_time is null or p_start_time = p_end_time then
    raise exception 'a start time and a different end time are required' using errcode = '22023';
  end if;
  begin
    insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
    values (v_company, p_branch_id, v_name, p_start_time, p_end_time, p_end_time < p_start_time, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'an active shift template with that name already exists at this branch' using errcode = '23505';
  end;
  return v_id;
end $$;

create function public.update_shift_template(p_template_id uuid, p_name text, p_start_time time, p_end_time time)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_name text := btrim(p_name);
  t public.shift_templates;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into t from public.shift_templates where id = p_template_id and company_id = v_company for update;
  if not found then
    raise exception 'shift template not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('allocation.manage', t.branch_id) then
    raise exception 'missing permission allocation.manage for this branch' using errcode = '42501';
  end if;
  if t.status <> 'active' then
    raise exception 'an archived shift template cannot be changed' using errcode = '55000';
  end if;
  if v_name is null or length(v_name) not between 1 and 100 then
    raise exception 'a template name (1-100 characters) is required' using errcode = '22023';
  end if;
  if p_start_time is null or p_end_time is null or p_start_time = p_end_time then
    raise exception 'a start time and a different end time are required' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', 'shift template edited (existing shifts keep their own times)', true);
  begin
    update public.shift_templates
       set name = v_name, start_time = p_start_time, end_time = p_end_time, crosses_midnight = p_end_time < p_start_time
     where id = t.id;
  exception when unique_violation then
    perform set_config('app.audit_reason', '', true);
    raise exception 'an active shift template with that name already exists at this branch' using errcode = '23505';
  end;
  perform set_config('app.audit_reason', '', true);
end $$;

create function public.archive_shift_template(p_template_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := btrim(p_reason);
  t public.shift_templates;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into t from public.shift_templates where id = p_template_id and company_id = v_company for update;
  if not found then
    raise exception 'shift template not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('allocation.manage', t.branch_id) then
    raise exception 'missing permission allocation.manage for this branch' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) not between 1 and 500 then
    raise exception 'a reason (1-500 characters) is required to archive a shift template' using errcode = '22023';
  end if;
  if t.status <> 'active' then
    raise exception 'an archived shift template cannot be changed' using errcode = '55000';
  end if;
  perform set_config('app.audit_reason', 'shift template archived: ' || v_reason, true);
  update public.shift_templates set status = 'archived' where id = t.id;
  perform set_config('app.audit_reason', '', true);
end $$;

-- ---------------------------------------------------------------- generate shifts from a template
-- One shift per date in [p_from, p_to] (at most 31 days), skipping dates that already have a SCHEDULED shift from
-- this template. Idempotent: each shift's client_submission_id is derived from the call's id and its date, so a retry
-- finds the shifts it already made, counts them as created again and creates nothing new -> the same counts.
create function public.generate_shifts(p_template_id uuid, p_from date, p_to date, p_client_submission_id uuid)
returns table (created integer, skipped integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  t public.shift_templates;
  d date;
  v_csid uuid;
  v_id uuid;
  tm record;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;
  select * into t from public.shift_templates where id = p_template_id and company_id = v_company;
  if not found then
    raise exception 'shift template not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('allocation.manage', t.branch_id) then
    raise exception 'missing permission allocation.manage for this branch' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'a date range is required and the end date cannot be before the start date' using errcode = '22023';
  end if;
  if p_to - p_from + 1 > 31 then
    raise exception 'at most 31 days can be generated in one call' using errcode = '22023';
  end if;
  created := 0;
  skipped := 0;
  perform set_config('app.audit_reason', 'generated from shift template ' || t.id::text, true);
  for d in select g::date from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g loop
    v_csid := md5(p_client_submission_id::text || ':' || d::text)::uuid;
    if exists (select 1 from public.shifts where company_id = v_company and created_by = v_uid and client_submission_id = v_csid) then
      created := created + 1;                       -- idempotent retry: this call already made it
      continue;
    end if;
    -- re-check inside the loop so a template archived concurrently cannot be used after this point
    if not exists (select 1 from public.shift_templates where id = t.id and status = 'active') then
      perform set_config('app.audit_reason', '', true);
      raise exception 'an archived shift template cannot be used to generate shifts' using errcode = '55000';
    end if;
    select * into tm from public.shift_times(d, t.start_time, t.end_time);
    v_id := null;
    insert into public.shifts (company_id, branch_id, shift_template_id, shift_date, scheduled_start_at, scheduled_end_at,
                               client_submission_id, created_by)
    values (v_company, t.branch_id, t.id, d, tm.scheduled_start_at, tm.scheduled_end_at, v_csid, v_uid)
    on conflict do nothing
    returning id into v_id;
    if v_id is null then
      skipped := skipped + 1;
    else
      created := created + 1;
    end if;
  end loop;
  perform set_config('app.audit_reason', '', true);
  return next;
end $$;

-- ---------------------------------------------------------------- ad hoc shift (no template)
create function public.create_shift(p_branch_id uuid, p_department_id uuid, p_shift_date date, p_start_time time, p_end_time time,
                                    p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_id uuid;
  d public.departments;
  tm record;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;
  select id into v_id from public.shifts
   where company_id = v_company and created_by = v_uid and client_submission_id = p_client_submission_id;
  if found then
    return v_id;                                    -- idempotent retry
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company) then
    raise exception 'branch not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('allocation.manage', p_branch_id) then
    raise exception 'missing permission allocation.manage for this branch' using errcode = '42501';
  end if;
  if p_department_id is not null then
    select * into d from public.departments where id = p_department_id and company_id = v_company;
    if not found or (d.branch_id is not null and d.branch_id <> p_branch_id) then
      raise exception 'department not found for this branch' using errcode = 'P0002';
    end if;
    if d.status <> 'active' then
      raise exception 'the department is not active' using errcode = '22023';
    end if;
  end if;
  select * into tm from public.shift_times(p_shift_date, p_start_time, p_end_time);
  insert into public.shifts (company_id, branch_id, department_id, shift_date, scheduled_start_at, scheduled_end_at,
                             client_submission_id, created_by)
  values (v_company, p_branch_id, p_department_id, p_shift_date, tm.scheduled_start_at, tm.scheduled_end_at,
          p_client_submission_id, v_uid)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- cancel
create function public.cancel_shift(p_shift_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := btrim(p_reason);
  s public.shifts;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into s from public.shifts where id = p_shift_id and company_id = v_company for update;
  if not found then
    raise exception 'shift not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('allocation.manage', s.branch_id) then
    raise exception 'missing permission allocation.manage for this branch' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) not between 1 and 500 then
    raise exception 'a reason (1-500 characters) is required to cancel a shift' using errcode = '22023';
  end if;
  if s.status = 'cancelled' then
    raise exception 'a cancelled shift cannot be changed' using errcode = '55000';
  end if;
  if public.shift_has_active_allocations(s.id) then
    raise exception 'a shift with active allocations cannot be cancelled' using errcode = '55000';
  end if;
  perform set_config('app.audit_reason', 'shift cancelled: ' || v_reason, true);
  update public.shifts
     set status = 'cancelled', cancel_reason = v_reason, cancelled_by = v_uid, cancelled_at = clock_timestamp()
   where id = s.id;
  perform set_config('app.audit_reason', '', true);
end $$;

revoke all on function
  public.create_shift_template(uuid, text, time, time),
  public.update_shift_template(uuid, text, time, time),
  public.archive_shift_template(uuid, text),
  public.generate_shifts(uuid, date, date, uuid),
  public.create_shift(uuid, uuid, date, time, time, uuid),
  public.cancel_shift(uuid, text)
  from public, anon;
grant execute on function
  public.create_shift_template(uuid, text, time, time),
  public.update_shift_template(uuid, text, time, time),
  public.archive_shift_template(uuid, text),
  public.generate_shifts(uuid, date, date, uuid),
  public.create_shift(uuid, uuid, date, time, time, uuid),
  public.cancel_shift(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------- RLS + grants (deny by default)
alter table public.shift_templates enable row level security;
alter table public.shifts          enable row level security;
revoke all on public.shift_templates, public.shifts from public, anon, authenticated;
grant select on public.shift_templates, public.shifts to authenticated;
-- Readable by those who manage allocations or view reports for the row's branch (company-wide grants cover every branch).
-- Drivers, system administrators and anyone without either grant see nothing.
create policy shift_templates_select on public.shift_templates for select to authenticated
  using (company_id = (select public.current_company_id())
         and (public.has_permission('allocation.manage', branch_id) or public.has_permission('reports.view', branch_id)));
create policy shifts_select on public.shifts for select to authenticated
  using (company_id = (select public.current_company_id())
         and (public.has_permission('allocation.manage', branch_id) or public.has_permission('reports.view', branch_id)));
