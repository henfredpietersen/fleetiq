-- Phase 1A — organisation & access tables (DB §3, §19; AD-05, AD-06, DEC-24).
-- Statuses are text + CHECK (AD-06). Organisation/profile status values are not in the
-- DB §20 catalogue; the sets below are minimal and configurable via a later migration.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------- helpers
create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Blocks changes to the columns named in TG_ARGV (identity / history columns).
create function public.prevent_column_change() returns trigger
language plpgsql set search_path = '' as $$
declare col text; o jsonb := to_jsonb(old); n jsonb := to_jsonb(new);
begin
  foreach col in array tg_argv loop
    if o -> col is distinct from n -> col then
      raise exception 'column %.% is immutable', tg_table_name, col using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

-- ---------------------------------------------------------------- companies
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  registration_number text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- branches
create table public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  name text not null,
  branch_code text not null,
  address text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, branch_code),
  unique (id, company_id) -- target for composite FKs (DB §2.1)
);

-- ---------------------------------------------------------------- departments
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid,
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  foreign key (branch_id, company_id) references public.branches (id, company_id)
);

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id),
  company_id uuid not null references public.companies (id),
  display_name text not null,
  email text,
  phone text,
  user_type text not null check (user_type in ('driver', 'staff')),
  login_identifier text not null unique, -- internal, non-deliverable (AD-08)
  must_change_pin boolean not null default false,
  locked_until timestamptz,
  status text not null default 'active' check (status in ('active', 'locked', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_type <> 'staff' or email is not null), -- DEC-34
  unique (id, company_id)
);

-- ---------------------------------------------------------------- roles & permissions
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id), -- null = system-defined
  name text not null,
  description text
);
create unique index roles_name_uq on public.roles (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  permission_key text not null unique,
  description text
);

create table public.role_permissions (
  role_id uuid not null references public.roles (id),
  permission_id uuid not null references public.permissions (id),
  primary key (role_id, permission_id)
);

-- ---------------------------------------------------------------- user_roles (AD-05)
-- The ONLY source of access scope. branch_id NULL = company-wide.
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role_id uuid not null references public.roles (id),
  company_id uuid not null references public.companies (id),
  branch_id uuid,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (user_id, company_id) references public.profiles (id, company_id),
  foreign key (granted_by, company_id) references public.profiles (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  constraint user_roles_no_self_grant check (granted_by <> user_id), -- DEC-24
  constraint user_roles_dates check (effective_to is null or effective_to > effective_from)
);
create index user_roles_user_idx on public.user_roles (user_id);

-- Role must be system-defined or belong to the same company.
create function public.user_roles_validate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from public.roles r
    where r.id = new.role_id and (r.company_id is null or r.company_id = new.company_id)
  ) then
    raise exception 'role % is not available to company %', new.role_id, new.company_id
      using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- audit_logs (DB §19)
-- company_id / actor_id are nullable: system-level config rows (permissions, system
-- roles) have no company, and migrations/jobs have no auth.uid().
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id),
  branch_id uuid,
  actor_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  entity_type text not null,
  entity_id uuid,
  occurred_at timestamptz not null default now(),
  before_values jsonb,
  after_values jsonb,
  reason text,
  request_reference text,
  metadata jsonb
);
create index audit_logs_company_time_idx on public.audit_logs (company_id, occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

-- ---------------------------------------------------------------- triggers
create trigger companies_updated before update on public.companies for each row execute function public.set_updated_at();
create trigger branches_updated  before update on public.branches  for each row execute function public.set_updated_at();
create trigger profiles_updated  before update on public.profiles  for each row execute function public.set_updated_at();

create trigger branches_immutable    before update on public.branches    for each row execute function public.prevent_column_change('id', 'company_id');
create trigger departments_immutable before update on public.departments for each row execute function public.prevent_column_change('id', 'company_id');
create trigger profiles_immutable    before update on public.profiles    for each row execute function public.prevent_column_change('id', 'company_id');
-- Grants are history: only effective_to may change (revoke = set effective_to).
create trigger user_roles_immutable  before update on public.user_roles  for each row execute function public.prevent_column_change('id', 'user_id', 'role_id', 'company_id', 'branch_id', 'effective_from', 'granted_by', 'created_at');
create trigger user_roles_validate_t before insert on public.user_roles  for each row execute function public.user_roles_validate();
