-- Phase 1B carry-over fixes from the PR #2 (slice 1A) review. Own migration; 1A migrations are not edited.
--   1. user_roles: a manager may only END a grant — never re-activate or extend one (DEC-24, AD-05).
--   2. audit_row_change(): record session_user (current_user is always the function owner in a
--      SECURITY DEFINER function, so db_role was meaningless).
--   3. audit_row_change(): role_permissions rows resolve company_id via roles.company_id so company
--      audit.view users can see changes to their own custom roles (system roles stay NULL).
--   (Also: actor falls back to app.actor_id when there is no auth.uid() — set only by reviewed
--   service-role admin functions in this slice, ARCH §5.3.)

-- ---------------------------------------------------------------- 1. end-only grants
-- Grants are history: the only allowed change is ending one. Applies to every role, owner included.
create function public.user_roles_end_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.effective_to is distinct from old.effective_to then
    if new.effective_to is null then
      raise exception 'a grant cannot be re-activated; create a new grant row' using errcode = '23514';
    end if;
    if new.effective_to > now() then
      raise exception 'a grant can only be ended at or before now()' using errcode = '23514';
    end if;
    if old.effective_to is not null and new.effective_to > old.effective_to then
      raise exception 'an ended grant cannot be extended; create a new grant row' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger user_roles_end_only_t before update on public.user_roles
  for each row execute function public.user_roles_end_only();

-- Same rule in the policy so a client sees a clean "0 rows" instead of relying on the trigger alone.
drop policy user_roles_update on public.user_roles;
create policy user_roles_update on public.user_roles for update to authenticated
  using (company_id = public.current_company_id()
         and public.has_permission('users.roles.manage', null)
         and user_id <> auth.uid())
  with check (company_id = public.current_company_id()
              and user_id <> auth.uid()
              and effective_to is not null
              and effective_to <= now());

-- ---------------------------------------------------------------- 2 + 3. audit_row_change()
create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pk text := coalesce(tg_argv[0], 'id');
  -- never store secrets
  strip text[] := array['pin', 'pin_hash', 'password', 'encrypted_password', 'secret', 'token'];
  o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - strip end;
  n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - strip end;
  j jsonb := coalesce(n, o);
  v_company uuid;
  v_branch uuid;
begin
  if tg_table_name = 'companies' then
    v_company := (j ->> 'id')::uuid;
  elsif tg_table_name = 'role_permissions' then
    -- no company_id column: resolve through the role (NULL for system roles)
    select r.company_id into v_company from public.roles r where r.id = (j ->> 'role_id')::uuid;
  else
    v_company := (j ->> 'company_id')::uuid;
  end if;
  if tg_table_name = 'branches' then
    v_branch := (j ->> 'id')::uuid;
  else
    v_branch := (j ->> 'branch_id')::uuid;
  end if;

  insert into public.audit_logs
    (company_id, branch_id, actor_id, action, entity_type, entity_id,
     before_values, after_values, reason, request_reference, metadata)
  values
    (v_company, v_branch,
     -- app.actor_id is honoured only when there is no authenticated user (service-role admin functions)
     coalesce(auth.uid(), nullif(current_setting('app.actor_id', true), '')::uuid),
     lower(tg_op), tg_table_name, (j ->> pk)::uuid,
     o, n,
     nullif(current_setting('app.audit_reason', true), ''),
     nullif(current_setting('app.request_reference', true), ''),
     jsonb_build_object('session_user', session_user)
       || case when tg_table_name = 'role_permissions'
               then jsonb_build_object('permission_id', j ->> 'permission_id') else '{}'::jsonb end);
  return null;
end $$;

revoke all on function public.audit_row_change() from public, anon, authenticated;
