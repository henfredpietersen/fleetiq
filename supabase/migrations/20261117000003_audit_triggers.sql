-- Phase 1A — generic audit trigger (DB §19, §2 rule 12; AD-05). Actor = auth.uid().

create function public.audit_row_change() returns trigger
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
    (v_company, v_branch, auth.uid(), lower(tg_op), tg_table_name, (j ->> pk)::uuid,
     o, n,
     nullif(current_setting('app.audit_reason', true), ''),
     nullif(current_setting('app.request_reference', true), ''),
     jsonb_build_object('db_role', current_user)
       || case when tg_table_name = 'role_permissions'
               then jsonb_build_object('permission_id', j ->> 'permission_id') else '{}'::jsonb end);
  return null;
end $$;

revoke all on function public.audit_row_change() from public, anon, authenticated;

-- audit_logs is append-only: block UPDATE/DELETE/TRUNCATE for every role, owner included.
create function public.audit_logs_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '42501';
end $$;

create trigger audit_logs_no_change before update or delete on public.audit_logs
  for each row execute function public.audit_logs_immutable();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.audit_logs_immutable();

-- Attach to every Phase 1A table except audit_logs itself (would recurse).
create trigger companies_audit        after insert or update or delete on public.companies        for each row execute function public.audit_row_change();
create trigger branches_audit         after insert or update or delete on public.branches         for each row execute function public.audit_row_change();
create trigger departments_audit      after insert or update or delete on public.departments      for each row execute function public.audit_row_change();
create trigger profiles_audit         after insert or update or delete on public.profiles         for each row execute function public.audit_row_change();
create trigger roles_audit            after insert or update or delete on public.roles            for each row execute function public.audit_row_change();
create trigger permissions_audit      after insert or update or delete on public.permissions      for each row execute function public.audit_row_change();
create trigger role_permissions_audit after insert or update or delete on public.role_permissions for each row execute function public.audit_row_change('role_id');
create trigger user_roles_audit       after insert or update or delete on public.user_roles       for each row execute function public.audit_row_change();
