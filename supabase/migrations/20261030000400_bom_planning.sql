begin;

create table public.bom_recipes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(trim(code)) between 1 and 80),
  name text not null check (char_length(trim(name)) between 1 and 200),
  product_name text not null check (char_length(trim(product_name)) between 1 and 200),
  is_active boolean not null default true,
  revision integer not null default 1 check (revision > 0),
  components jsonb not null check (jsonb_typeof(components) = 'array' and jsonb_array_length(components) between 1 and 100),
  search_text text generated always as (lower(code || ' ' || name || ' ' || product_name)) stored,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.production_schedules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(trim(code)) between 1 and 80),
  bom_id uuid not null references public.bom_recipes(id) on delete restrict,
  scheduled_on date not null check (scheduled_on between date '1900-01-01' and date '2199-12-31'),
  multiplier numeric(15,6) not null check (multiplier > 0 and multiplier <> 'NaN'::numeric),
  production_batch text not null check (char_length(trim(production_batch)) between 1 and 100),
  notes text not null default '' check (char_length(notes) <= 2000),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELLED')),
  revision integer not null default 1 check (revision > 0),
  bom_revision integer not null check (bom_revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.stock_issue_plans (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.production_schedules(id) on delete restrict,
  material_id uuid not null references public.materials(id) on delete restrict,
  quantity numeric(15,6) not null check (quantity > 0 and quantity <> 'NaN'::numeric),
  unit public.stock_unit not null,
  issue_purpose text not null check (issue_purpose in ('GENERAL', 'CLEANING')),
  planned_on date not null check (planned_on between date '1900-01-01' and date '2199-12-31'),
  status text not null default 'PLANNED' check (status in ('PLANNED', 'ISSUED', 'CANCELLED')),
  revision integer not null default 1 check (revision > 0),
  bom_revision integer not null check (bom_revision > 0),
  production_item text not null check (char_length(trim(production_item)) between 1 and 200),
  production_batch text not null check (char_length(trim(production_batch)) between 1 and 100),
  stock_operation_id uuid unique references public.stock_operations(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (schedule_id, material_id, issue_purpose),
  check ((status = 'ISSUED') = (stock_operation_id is not null)),
  check (issue_purpose <> 'CLEANING' or (unit = 'L' and mod(quantity, 18) = 0))
);
create index production_schedules_date_idx on public.production_schedules(scheduled_on, id);
create index stock_issue_plans_date_idx on public.stock_issue_plans(status, planned_on, id);

create table public.planning_change_history (
  id uuid primary key default gen_random_uuid(),
  entity_kind text not null check (entity_kind in ('BOM', 'SCHEDULE', 'PLAN_ISSUE')),
  entity_id uuid not null,
  actor_id uuid not null,
  actor_name text not null,
  reason text not null check (char_length(trim(reason)) between 1 and 1000),
  before_data jsonb,
  after_data jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index planning_history_entity_idx on public.planning_change_history(entity_kind, entity_id, created_at);

create function private.guard_planning_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Planning history is immutable' using errcode = '23514';
end;
$$;
create trigger planning_history_immutable before update or delete on public.planning_change_history
  for each row execute function private.guard_planning_history();

create function private.guard_issued_plan()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'ISSUED' then
    raise exception 'Issued plan is immutable' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger stock_issued_plan_immutable before update or delete on public.stock_issue_plans
  for each row execute function private.guard_issued_plan();

-- Components live in JSON, so provide the same deletion protection as a foreign
-- key even before a BOM has been used to create its first production schedule.
create function private.guard_bom_material_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.bom_recipes b, lateral jsonb_array_elements(b.components) c
    where c->>'material_id' = old.id::text) then
    raise exception 'Material is referenced by a BOM' using errcode = '23503';
  end if;
  return old;
end;
$$;
create trigger materials_bom_delete_guard before delete on public.materials
  for each row execute function private.guard_bom_material_delete();

-- Public RPCs are the only application write surface. The actor row is locked so
-- a concurrent permission revocation cannot race a planning or stock mutation.
create function private.planning_authorize(p_input jsonb, p_admin boolean, p_keys text[])
returns void language plpgsql security definer set search_path = '' as $$
declare actor public.profiles;
begin
  select * into actor from public.profiles where id = auth.uid() for share;
  if not found or not actor.is_active or actor.role not in ('operator', 'admin') or (p_admin and actor.role <> 'admin') then
    raise exception 'Planning permission denied' using errcode = '42501';
  end if;
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'Planning input is invalid' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_input) k where not (k = any(p_keys)))
    or jsonb_typeof(p_input->'reason') is distinct from 'string'
    or char_length(trim(coalesce(p_input->>'reason', ''))) not between 1 and 1000 then
    raise exception 'Planning input is invalid' using errcode = '22023';
  end if;
end;
$$;

create function private.planning_decimal(p_value text)
returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null or p_value !~ '^[0-9]{1,9}(\.[0-9]{1,6})?$' then
    raise exception 'Planning quantity must be a positive decimal with at most six decimal places' using errcode = '22023';
  end if;
  if p_value::numeric <= 0 or p_value::numeric >= 1000000000 then
    raise exception 'Planning quantity must be a positive decimal with at most six decimal places' using errcode = '22023';
  end if;
  return p_value::numeric;
end;
$$;

create function private.planning_expected_revision(p_input jsonb, p_current integer)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_current is null then
    if p_input->>'expected_revision' is not null then
      raise exception 'Planning revision conflict' using errcode = '40001';
    end if;
  elsif jsonb_typeof(p_input->'expected_revision') is distinct from 'number'
    or coalesce(p_input->>'expected_revision', '') !~ '^[1-9][0-9]{0,9}$'
    or (p_input->>'expected_revision')::numeric <> p_current then
    raise exception 'Planning revision conflict' using errcode = '40001';
  end if;
end;
$$;

create function private.planning_audit(p_kind text, p_id uuid, p_before jsonb, p_after jsonb, p_reason text)
returns void language sql security definer set search_path = '' as $$
  insert into public.planning_change_history(entity_kind, entity_id, actor_id, actor_name, reason, before_data, after_data)
  select p_kind, p_id, id, display_name, trim(p_reason), p_before, p_after from public.profiles where id = auth.uid();
$$;

create function public.planning_save_bom(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare old_row public.bom_recipes; saved public.bom_recipes; component jsonb; normalized jsonb := '[]';
  target_id uuid; material_id uuid; material public.materials; qty numeric; unit_value public.stock_unit; purpose text; keys_seen text[] := '{}'; component_key text;
begin
  perform private.planning_authorize(p_input, true, array['id','expected_revision','code','name','product_name','is_active','components','reason']);
  if jsonb_typeof(p_input->'code') is distinct from 'string' or char_length(trim(coalesce(p_input->>'code', ''))) not between 1 and 80
    or jsonb_typeof(p_input->'name') is distinct from 'string' or char_length(trim(coalesce(p_input->>'name', ''))) not between 1 and 200
    or jsonb_typeof(p_input->'product_name') is distinct from 'string' or char_length(trim(coalesce(p_input->>'product_name', ''))) not between 1 and 200
    or jsonb_typeof(p_input->'is_active') is distinct from 'boolean'
    or jsonb_typeof(p_input->'components') is distinct from 'array' then
    raise exception 'Planning input is invalid' using errcode = '22023';
  end if;
  if jsonb_array_length(p_input->'components') not between 1 and 100 then
    raise exception 'BOM requires between one and one hundred components' using errcode = '22023';
  end if;
  target_id := nullif(p_input->>'id', '')::uuid;
  if target_id is not null then
    select * into old_row from public.bom_recipes where id = target_id for update;
    if not found then raise exception 'Planning record not found' using errcode = '22023'; end if;
  end if;
  perform private.planning_expected_revision(p_input, old_row.revision);
  for component in select value from jsonb_array_elements(p_input->'components') loop
    if jsonb_typeof(component) is distinct from 'object' then raise exception 'BOM component is invalid' using errcode = '22023'; end if;
    if exists(select 1 from jsonb_object_keys(component) k where k not in ('material_id','quantity','unit','issue_purpose'))
      or jsonb_typeof(component->'material_id') is distinct from 'string'
      or jsonb_typeof(component->'quantity') is distinct from 'string'
      or jsonb_typeof(component->'unit') is distinct from 'string'
      or jsonb_typeof(component->'issue_purpose') is distinct from 'string' then
      raise exception 'BOM component is invalid' using errcode = '22023';
    end if;
    material_id := (component->>'material_id')::uuid;
    qty := private.planning_decimal(component->>'quantity');
    unit_value := (component->>'unit')::public.stock_unit;
    purpose := component->>'issue_purpose';
    if purpose not in ('GENERAL','CLEANING') then raise exception 'BOM component is invalid' using errcode = '22023'; end if;
    if purpose = 'CLEANING' and (unit_value <> 'L' or mod(qty,18) <> 0) then
      raise exception 'Cleaning plan quantity must be an exact multiple of 18 L' using errcode = '22023';
    end if;
    select * into material from public.materials m where m.id = material_id and m.is_active for share;
    if not found then raise exception 'Active material is required' using errcode = '22023'; end if;
    perform private.stock_convert(component->>'quantity',unit_value,material.base_unit,material.density);
    component_key := material_id::text || ':' || purpose;
    if component_key = any(keys_seen) then raise exception 'Duplicate BOM material and purpose' using errcode = '22023'; end if;
    keys_seen := array_append(keys_seen, component_key);
    normalized := normalized || jsonb_build_array(jsonb_build_object('material_id', material_id, 'quantity', qty::text, 'unit', unit_value, 'issue_purpose', purpose));
  end loop;
  if target_id is null then
    insert into public.bom_recipes(code,name,product_name,is_active,components)
    values(trim(p_input->>'code'),trim(p_input->>'name'),trim(p_input->>'product_name'),(p_input->>'is_active')::boolean,normalized)
    returning * into saved;
  else
    update public.bom_recipes set code=trim(p_input->>'code'), name=trim(p_input->>'name'), product_name=trim(p_input->>'product_name'),
      is_active=(p_input->>'is_active')::boolean, components=normalized, revision=revision+1, updated_at=clock_timestamp()
      where id=target_id returning * into saved;
  end if;
  perform private.planning_audit('BOM', saved.id, case when old_row.id is null then null else to_jsonb(old_row) end, to_jsonb(saved), p_input->>'reason');
  return to_jsonb(saved);
end;
$$;

create function private.planning_schedule_result(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('schedule', to_jsonb(s), 'plans', coalesce((
    select jsonb_agg(to_jsonb(p) order by p.material_id, p.issue_purpose) from public.stock_issue_plans p where p.schedule_id=s.id
  ), '[]'::jsonb)) from public.production_schedules s where s.id=p_id;
$$;

create function public.planning_save_schedule(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare old_row public.production_schedules; saved public.production_schedules; recipe public.bom_recipes;
  target_id uuid; recipe_id uuid; schedule_date date; multiplier_value numeric; component jsonb; qty numeric;
  component_keys text[] := '{}'; component_key text; old_state jsonb; new_state jsonb; material public.materials;
begin
  perform private.planning_authorize(p_input, false, array['id','expected_revision','code','bom_id','scheduled_on','multiplier','production_batch','notes','status','reason']);
  if jsonb_typeof(p_input->'code') is distinct from 'string' or char_length(trim(coalesce(p_input->>'code',''))) not between 1 and 80
    or jsonb_typeof(p_input->'production_batch') is distinct from 'string' or char_length(trim(coalesce(p_input->>'production_batch',''))) not between 1 and 100
    or jsonb_typeof(p_input->'notes') is distinct from 'string' or char_length(p_input->>'notes') > 2000
    or jsonb_typeof(p_input->'multiplier') is distinct from 'string'
    or coalesce(p_input->>'status','') not in ('ACTIVE','CANCELLED')
    or coalesce(p_input->>'scheduled_on','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or nullif(p_input->>'bom_id','') is null then
    raise exception 'Planning input is invalid' using errcode = '22023';
  end if;
  schedule_date := (p_input->>'scheduled_on')::date;
  if schedule_date not between date '1900-01-01' and date '2199-12-31' then raise exception 'Planning input is invalid' using errcode = '22023'; end if;
  multiplier_value := private.planning_decimal(p_input->>'multiplier');
  target_id := nullif(p_input->>'id','')::uuid;
  recipe_id := (p_input->>'bom_id')::uuid;
  -- All schedule edits and issue confirmations take the schedule lock first.
  if target_id is not null then
    select * into old_row from public.production_schedules where id=target_id for update;
    if not found then raise exception 'Planning record not found' using errcode = '22023'; end if;
    old_state := private.planning_schedule_result(target_id);
  end if;
  perform private.planning_expected_revision(p_input, old_row.revision);
  if old_row.id is not null and old_row.bom_id <> recipe_id and exists(
    select 1 from public.stock_issue_plans where schedule_id=target_id and status='ISSUED'
  ) then raise exception 'Issued schedule cannot change BOM' using errcode = '23514'; end if;
  select * into recipe from public.bom_recipes where id=recipe_id for share;
  if not found or (not recipe.is_active and p_input->>'status' = 'ACTIVE') then
    raise exception 'Active BOM is required' using errcode = '22023';
  end if;
  if target_id is null then
    insert into public.production_schedules(code,bom_id,scheduled_on,multiplier,production_batch,notes,status,bom_revision)
    values(trim(p_input->>'code'),recipe.id,schedule_date,multiplier_value,trim(p_input->>'production_batch'),p_input->>'notes',p_input->>'status',recipe.revision)
    returning * into saved;
  else
    update public.production_schedules set code=trim(p_input->>'code'),bom_id=recipe.id,scheduled_on=schedule_date,
      multiplier=multiplier_value,production_batch=trim(p_input->>'production_batch'),notes=p_input->>'notes',status=p_input->>'status',
      revision=revision+1,bom_revision=recipe.revision,updated_at=clock_timestamp() where id=target_id returning * into saved;
  end if;
  if saved.status='ACTIVE' then
    for component in select value from jsonb_array_elements(recipe.components) loop
      component_key := (component->>'material_id') || ':' || (component->>'issue_purpose');
      component_keys := array_append(component_keys, component_key);
      -- An issued component is a historical snapshot, not a candidate for
      -- regeneration. Changes to its multiplier or material must not prevent
      -- rescheduling the other, still unissued components.
      if exists(select 1 from public.stock_issue_plans where schedule_id=saved.id
        and material_id=(component->>'material_id')::uuid and issue_purpose=component->>'issue_purpose' and status='ISSUED') then
        continue;
      end if;
      qty := (component->>'quantity')::numeric * multiplier_value;
      if qty <= 0 or qty >= 1000000000 or qty <> round(qty,6) then
        raise exception 'Planned quantity is outside the supported range or precision' using errcode = '22023';
      end if;
      if component->>'issue_purpose'='CLEANING' and mod(qty,18)<>0 then
        raise exception 'Cleaning plan quantity must be an exact multiple of 18 L' using errcode = '22023';
      end if;
      select * into material from public.materials where id=(component->>'material_id')::uuid and is_active for share;
      if not found then raise exception 'Active material is required' using errcode = '22023'; end if;
      perform private.stock_convert(qty::numeric(15,6)::text,(component->>'unit')::public.stock_unit,material.base_unit,material.density);
      insert into public.stock_issue_plans(schedule_id,material_id,quantity,unit,issue_purpose,planned_on,bom_revision,production_item,production_batch)
      values(saved.id,(component->>'material_id')::uuid,qty,(component->>'unit')::public.stock_unit,component->>'issue_purpose',
        saved.scheduled_on,recipe.revision,recipe.product_name,saved.production_batch)
      on conflict (schedule_id,material_id,issue_purpose) do update set quantity=excluded.quantity,unit=excluded.unit,
        planned_on=excluded.planned_on,bom_revision=excluded.bom_revision,production_item=excluded.production_item,
        production_batch=excluded.production_batch,status='PLANNED',revision=public.stock_issue_plans.revision+1,updated_at=clock_timestamp()
      where public.stock_issue_plans.status <> 'ISSUED';
    end loop;
  end if;
  update public.stock_issue_plans set status='CANCELLED',revision=revision+1,updated_at=clock_timestamp()
    where schedule_id=saved.id and status='PLANNED'
      and not (material_id::text || ':' || issue_purpose = any(component_keys));
  new_state := private.planning_schedule_result(saved.id);
  perform private.planning_audit('SCHEDULE', saved.id, old_state, new_state, p_input->>'reason');
  return new_state;
end;
$$;

create function public.planning_issue_plan(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare plan public.stock_issue_plans; schedule public.production_schedules; parent_id uuid; saved public.stock_issue_plans;
  stock_input jsonb; result jsonb; issue_date date; previous public.stock_operations;
begin
  perform private.planning_authorize(p_input, false, array['plan_id','expected_revision','request_key','occurred_on','warehouse_id','reason','notes']);
  if nullif(p_input->>'plan_id','') is null or nullif(p_input->>'request_key','') is null
    or jsonb_typeof(p_input->'notes') is distinct from 'string' or char_length(p_input->>'notes')>2000
    or coalesce(p_input->>'occurred_on','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Planning input is invalid' using errcode = '22023';
  end if;
  select schedule_id into parent_id from public.stock_issue_plans where id=(p_input->>'plan_id')::uuid;
  if not found then raise exception 'Planning record not found' using errcode = '22023'; end if;
  select * into schedule from public.production_schedules where id=parent_id for update;
  select * into plan from public.stock_issue_plans where id=(p_input->>'plan_id')::uuid for update;
  -- The additional origin fields bind idempotency to this exact saved plan version.
  stock_input := jsonb_build_object('request_key',(p_input->>'request_key')::uuid,'material_id',plan.material_id,
    'quantity',plan.quantity::text,'unit',plan.unit,'issue_purpose',plan.issue_purpose,'occurred_on',p_input->>'occurred_on',
    'warehouse_id',nullif(p_input->>'warehouse_id','')::uuid,'production_item',plan.production_item,'production_batch',plan.production_batch,
    'reason',p_input->>'reason','notes',p_input->>'notes','plan_id',plan.id,'plan_revision',p_input->'expected_revision','schedule_id',schedule.id);
  if plan.status='ISSUED' then
    perform private.planning_expected_revision(p_input, plan.revision-1);
    select * into previous from public.stock_operations where id=plan.stock_operation_id;
    if previous.request_key is distinct from (p_input->>'request_key')::uuid then
      raise exception 'Plan has already been issued with another request key' using errcode = '23505';
    end if;
    -- stock_begin rechecks the actor and complete original payload on a retry.
    return public.stock_issue(stock_input);
  end if;
  perform private.planning_expected_revision(p_input, plan.revision);
  if plan.status <> 'PLANNED' or schedule.status <> 'ACTIVE' then
    raise exception 'Plan is not available for issue' using errcode = '23514';
  end if;
  issue_date := (p_input->>'occurred_on')::date;
  if plan.planned_on > (now() at time zone 'Asia/Seoul')::date or issue_date < plan.planned_on then
    raise exception 'Plan cannot be issued before its planned date' using errcode = '22023';
  end if;
  result := public.stock_issue(stock_input);
  update public.stock_issue_plans set status='ISSUED',stock_operation_id=(result->'operation'->>'id')::uuid,
    revision=revision+1,updated_at=clock_timestamp() where id=plan.id returning * into saved;
  perform private.planning_audit('PLAN_ISSUE',plan.id,to_jsonb(plan),to_jsonb(saved),p_input->>'reason');
  return result;
end;
$$;

create view public.schedule_rows with (security_invoker = true) as
select s.*, b.code bom_code, b.name bom_name, b.product_name,
  lower(s.code || ' ' || b.code || ' ' || b.name || ' ' || b.product_name || ' ' || s.production_batch) search_text
from public.production_schedules s join public.bom_recipes b on b.id=s.bom_id;

create view public.issue_plan_rows with (security_invoker = true) as
select p.*, m.code material_code, m.name material_name, m.base_unit, s.code schedule_code,
  lower(m.search_text || ' ' || s.code || ' ' || p.production_item || ' ' || p.production_batch) search_text
from public.stock_issue_plans p join public.materials m on m.id=p.material_id join public.production_schedules s on s.id=p.schedule_id;

do $$
declare table_name text; routine record;
begin
  foreach table_name in array array['bom_recipes','production_schedules','stock_issue_plans','planning_change_history'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('create policy planning_active_select on public.%I for select to authenticated using ((select private.current_user_is_active()))',table_name);
    execute format('revoke all on public.%I from public, anon, authenticated',table_name);
    execute format('grant select on public.%I to authenticated',table_name);
  end loop;
  for routine in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and (p.proname like 'planning_%' or p.proname in ('guard_planning_history','guard_issued_plan','guard_bom_material_delete')) loop
    execute format('revoke all on function %s from public, anon, authenticated',routine.signature);
  end loop;
end;
$$;
revoke all on public.schedule_rows,public.issue_plan_rows from public,anon,authenticated;
grant select on public.schedule_rows,public.issue_plan_rows to authenticated;
revoke all on function public.planning_save_bom(jsonb),public.planning_save_schedule(jsonb),public.planning_issue_plan(jsonb) from public,anon,authenticated;
grant execute on function public.planning_save_bom(jsonb),public.planning_save_schedule(jsonb),public.planning_issue_plan(jsonb) to authenticated;

comment on table public.bom_recipes is 'Versioned web BOM. Saving a BOM does not silently rewrite existing schedules; save the schedule to apply its current revision.';
comment on table public.stock_issue_plans is 'No stock reservation or movement until explicit issue confirmation. Issued rows are immutable; schedule changes affect only unissued rows.';
comment on function public.planning_save_schedule(jsonb) is 'Regenerates only unissued plans. Reuses cancelled plan identities and preserves issued component keys to prevent duplicate issues.';

commit;
