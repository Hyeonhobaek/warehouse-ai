begin;

-- Phase 1 contains identity only. Inventory tables and stock RPCs come later.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create type public.app_role as enum ('viewer', 'operator', 'admin');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  role public.app_role not null default 'viewer',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profile_role_audit (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately retain the subject and actor UUID after an Auth user is deleted.
  profile_id uuid not null,
  actor_id uuid,
  database_actor text not null,
  old_role public.app_role not null,
  new_role public.app_role not null,
  old_is_active boolean not null,
  new_is_active boolean not null,
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now()
);

create index profile_role_audit_profile_created_idx
  on public.profile_role_audit (profile_id, created_at desc);

create function private.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and is_active
  );
$$;

-- A new account is always least privilege. raw_user_meta_data is user-controlled.
create function private.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(new.email, '@', 1), ''), '사용자'), 80),
    'viewer'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.create_profile_for_auth_user();

-- Applying this migration to a project with existing Auth accounts is supported.
insert into public.profiles (id, display_name, role)
select id,
  left(coalesce(nullif(trim(raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(email, '@', 1), ''), '사용자'), 80),
  'viewer'::public.app_role
from auth.users
on conflict (id) do nothing;

create function private.audit_profile_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  change_reason text;
begin
  new.updated_at := now();
  if old.role is distinct from new.role or old.is_active is distinct from new.is_active then
    change_reason := nullif(trim(current_setting('app.audit_reason', true)), '');
    if change_reason is null or char_length(change_reason) > 500 then
      raise exception 'A role or activation change requires app.audit_reason (1-500 characters)';
    end if;

    insert into public.profile_role_audit (
      profile_id, actor_id, database_actor, old_role, new_role,
      old_is_active, new_is_active, reason
    ) values (
      old.id, auth.uid(), session_user, old.role, new.role,
      old.is_active, new.is_active, change_reason
    );
  end if;
  return new;
end;
$$;

create trigger audit_profile_access_change
before update on public.profiles
for each row execute function private.audit_profile_access_change();

alter table public.profiles enable row level security;
alter table public.profile_role_audit enable row level security;

create policy profiles_select on public.profiles
for select to authenticated
using (
  (id = (select auth.uid()) and is_active)
  or (select private.current_user_is_admin())
);

create policy profile_role_audit_admin_select on public.profile_role_audit
for select to authenticated
using ((select private.current_user_is_admin()));

-- Explicit grants also counter broad defaults in hosted Supabase projects.
revoke all on public.profiles, public.profile_role_audit from public, anon, authenticated;
grant select on public.profiles, public.profile_role_audit to authenticated;
revoke all on function private.current_user_is_admin() from public, anon, authenticated;
revoke all on function private.create_profile_for_auth_user() from public, anon, authenticated;
revoke all on function private.audit_profile_access_change() from public, anon, authenticated;
grant execute on function private.current_user_is_admin() to authenticated;

comment on table public.profiles is 'Phase 1 identity and role source of truth. Application clients have read access only.';
comment on table public.profile_role_audit is 'Append-only to application roles; trusted database operators administer roles in Phase 1.';

commit;
