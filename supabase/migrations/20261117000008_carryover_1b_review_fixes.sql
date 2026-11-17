-- Phase 1C carry-over fix from the PR #3 (slice 1B) review. Own migration; earlier migrations are not edited.
--   5. user_roles: a manager may cancel a not-yet-started (future-dated) grant.
--
-- Why it was blocked: the end-only rule requires effective_to <= now(), but a future grant has
-- effective_from > now() and the table CHECK required effective_to > effective_from, so no valid
-- end value existed. Grants are history (no deletes), so "cancel" = collapse the grant to zero
-- length (effective_to = effective_from). has_permission() requires effective_from <= now() AND
-- effective_to > now(), so a zero-length grant is never effective. DEC-24 / AD-05 unchanged:
-- ending or cancelling only, never extending or re-activating.

alter table public.user_roles drop constraint user_roles_dates;
alter table public.user_roles add constraint user_roles_dates
  check (effective_to is null or effective_to >= effective_from);

create or replace function public.user_roles_end_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.effective_to is distinct from old.effective_to then
    if new.effective_to is null then
      raise exception 'a grant cannot be re-activated; create a new grant row' using errcode = '23514';
    end if;
    if old.effective_from > now() then
      -- not yet started: the only change allowed is cancelling it (zero length)
      if new.effective_to <> old.effective_from then
        raise exception 'a future-dated grant can only be cancelled (effective_to = effective_from)'
          using errcode = '23514';
      end if;
    elsif new.effective_to > now() then
      raise exception 'a grant can only be ended at or before now()' using errcode = '23514';
    end if;
    if old.effective_to is not null and new.effective_to > old.effective_to then
      raise exception 'an ended grant cannot be extended; create a new grant row' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- Same rule in the policy so a client sees a clean "0 rows".
drop policy user_roles_update on public.user_roles;
create policy user_roles_update on public.user_roles for update to authenticated
  using (company_id = public.current_company_id()
         and public.has_permission('users.roles.manage', null)
         and user_id <> auth.uid())
  with check (company_id = public.current_company_id()
              and user_id <> auth.uid()
              and effective_to is not null
              and (effective_to <= now() or effective_to = effective_from));
