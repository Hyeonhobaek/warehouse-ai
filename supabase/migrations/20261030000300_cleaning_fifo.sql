begin;

alter table public.stock_operations add column issue_purpose text not null default 'GENERAL'
  check (issue_purpose in ('GENERAL', 'CLEANING'));

-- An 18 L block is converted with the same verified density as the entire issue.
-- L -> kg/g/L/mL is exact at the supported six-decimal material precision.
create function private.stock_issue_block(p_input jsonb, p_material public.materials)
returns numeric language plpgsql immutable set search_path = '' as $$
declare purpose text := coalesce(p_input->>'issue_purpose', 'GENERAL'); q numeric;
begin
  if purpose not in ('GENERAL', 'CLEANING') then
    raise exception 'Issue purpose must be GENERAL or CLEANING' using errcode = '22023';
  end if;
  if purpose = 'GENERAL' then return null; end if;
  if p_input->>'unit' is distinct from 'L' then
    raise exception 'Cleaning issues must use positive multiples of 18 L' using errcode = '22023';
  end if;
  if p_material.base_unit = 'EA' then
    raise exception 'Cleaning is not supported for EA materials' using errcode = '22023';
  end if;
  -- Validate the decimal text before casting and multiplying it.
  q := private.stock_convert(p_input->>'quantity', 'L', 'L', null);
  if mod(q, 18) <> 0 then
    raise exception 'Cleaning issues must use positive multiples of 18 L' using errcode = '22023';
  end if;
  return private.stock_convert('18', 'L', p_material.base_unit, p_material.density);
end;
$$;

create or replace function private.stock_create_operation(p_kind public.stock_operation_kind, p_input jsonb, p_material public.materials, p_quantity numeric, p_date date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if p_date is null or p_date > (now() at time zone 'Asia/Seoul')::date or p_date < date '1900-01-01' then
    raise exception 'Transaction date must be an actual date no later than today' using errcode = '22023';
  end if;
  insert into public.stock_operations (request_key, kind, material_id, occurred_on, input_quantity, input_unit,
    quantity, base_unit, density_snapshot, production_item, production_batch, reason, notes, actor_id, actor_name, request_payload, issue_purpose)
  select (p_input->>'request_key')::uuid, p_kind, p_material.id, p_date, (p_input->>'quantity')::numeric,
    (p_input->>'unit')::public.stock_unit, p_quantity, p_material.base_unit, p_material.density,
    coalesce(p_input->>'production_item', ''), coalesce(p_input->>'production_batch', ''), trim(p_input->>'reason'),
    coalesce(p_input->>'notes', ''), id, display_name, p_input,
    case when p_kind = 'ISSUE' then coalesce(p_input->>'issue_purpose', 'GENERAL') else 'GENERAL' end
  from public.profiles where id = auth.uid()
  returning id into result_id;
  return result_id;
end;
$$;

-- One allocator serves both previews and committed issues. Capacity is rounded
-- down per physical receipt cohort, never by LOT or by storage location.
create function private.stock_issue_plan(p_material uuid, p_quantity numeric, p_date date, p_warehouse uuid, p_block numeric)
returns jsonb language sql stable security definer set search_path = '' as $$
  with eligible as (
    select b.batch_id, b.location_id, r.received_on, r.test_number, l.lot_number, r.created_at,
      p.code location_code, w.code warehouse_code, b.on_hand - b.reserved - b.held available_quantity
    from public.stock_balances b join public.stock_batches r on r.id = b.batch_id
    join public.material_lots l on l.id = r.lot_id join public.storage_locations p on p.id = b.location_id
    join public.warehouses w on w.id = p.warehouse_id
    where l.material_id = p_material and r.quality_status = 'APPROVED'
      and r.expires_on >= (now() at time zone 'Asia/Seoul')::date and p.is_active and w.is_active
      and (p_warehouse is null or w.id = p_warehouse) and b.on_hand > b.reserved + b.held
      and r.received_on <= p_date
  ), cohorts as (
    select batch_id, received_on, created_at, sum(available_quantity) raw_available,
      case when p_block is null then sum(available_quantity)
        else floor(sum(available_quantity) / p_block) * p_block end capacity
    from eligible group by batch_id, received_on, created_at
  ), cohort_plan as (
    select *, greatest(least(capacity, p_quantity - coalesce(sum(capacity) over (
      order by received_on, created_at, batch_id rows between unbounded preceding and 1 preceding), 0)), 0) assigned
    from cohorts
  ), locations as (
    select e.*, c.assigned, coalesce(sum(e.available_quantity) over (
      partition by e.batch_id order by e.location_id rows between unbounded preceding and 1 preceding), 0) preceding_quantity
    from eligible e join cohort_plan c using (batch_id)
  ), allocations as (
    select *, least(available_quantity, assigned - preceding_quantity) quantity
    from locations where assigned > preceding_quantity
  ) select jsonb_build_object(
    'available', coalesce((select sum(capacity) from cohorts), 0),
    'raw_available', coalesce((select sum(raw_available) from cohorts), 0),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
      'batch_id', batch_id, 'location_id', location_id, 'received_on', received_on, 'test_number', test_number,
      'lot_number', lot_number, 'location_code', location_code, 'warehouse_code', warehouse_code,
      'available', available_quantity, 'quantity', quantity)
      order by received_on, created_at, batch_id, location_id) from allocations), '[]'::jsonb));
$$;

create or replace function public.stock_issue(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb; material public.materials; q numeric; block_quantity numeric;
  operation_id uuid; allocation jsonb; balance public.stock_balances; taken numeric; assigned numeric := 0;
  line_number integer := 0; issue_date date; scope_warehouse uuid; plan jsonb;
begin
  previous := private.stock_begin('ISSUE', p_input);
  if previous is not null then return previous; end if;
  select * into material from public.materials where id = (p_input->>'material_id')::uuid for update;
  if not found or not material.is_active then raise exception 'Active material is required' using errcode = '22023'; end if;
  block_quantity := private.stock_issue_block(p_input, material);
  q := private.stock_convert(p_input->>'quantity', (p_input->>'unit')::public.stock_unit, material.base_unit, material.density);
  issue_date := (p_input->>'occurred_on')::date;
  scope_warehouse := nullif(p_input->>'warehouse_id', '')::uuid;
  if scope_warehouse is not null and not exists (select 1 from public.warehouses where id = scope_warehouse and is_active) then
    raise exception 'Active warehouse is required' using errcode = '22023';
  end if;
  -- Preserve the material mutex and lock every cohort before evaluating QC.
  perform r.id from public.stock_batches r join public.material_lots l on l.id = r.lot_id
    where l.material_id = material.id order by r.id for share of r;
  -- Lock balances and location/warehouse eligibility before calculating capacity.
  perform b.id from public.stock_balances b join public.stock_batches r on r.id = b.batch_id
    join public.material_lots l on l.id = r.lot_id
    join public.storage_locations p on p.id = b.location_id join public.warehouses w on w.id = p.warehouse_id
    where l.material_id = material.id and (scope_warehouse is null or w.id = scope_warehouse)
    order by r.received_on, r.created_at, r.id, p.id for update of b for share of p, w;
  operation_id := private.stock_create_operation('ISSUE', p_input, material, q, issue_date);
  plan := private.stock_issue_plan(material.id, q, issue_date, scope_warehouse, block_quantity);
  if (plan->>'available')::numeric < q then
    raise exception 'Insufficient available stock; entire issue cancelled' using errcode = 'P0001';
  end if;
  for allocation in select value from jsonb_array_elements(plan->'lines') loop
    taken := (allocation->>'quantity')::numeric;
    select * into balance from public.stock_balances
      where batch_id = (allocation->>'batch_id')::uuid and location_id = (allocation->>'location_id')::uuid for update;
    perform private.stock_check_date(balance.batch_id, balance.location_id, issue_date);
    update public.stock_balances set on_hand = on_hand - taken, updated_at = clock_timestamp() where id = balance.id;
    line_number := line_number + 1;
    perform private.stock_add_line(operation_id, line_number, balance.batch_id, balance.location_id,
      null, taken, -taken, balance.on_hand, balance.on_hand - taken, balance.held, balance.held);
    assigned := assigned + taken;
  end loop;
  if assigned <> q then
    raise exception 'Insufficient available stock; entire issue cancelled' using errcode = 'P0001';
  end if;
  return private.stock_result(operation_id);
end;
$$;

create or replace function public.stock_preview_issue(p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare material public.materials; q numeric; scope_warehouse uuid; plan jsonb; total numeric;
  issue_date date; planned_line jsonb; block_quantity numeric;
begin
  if not private.current_user_is_active() then raise exception 'Inventory access denied' using errcode = '42501'; end if;
  select * into material from public.materials where id = (p_input->>'material_id')::uuid;
  if not found or not material.is_active then raise exception 'Active material is required' using errcode = '22023'; end if;
  block_quantity := private.stock_issue_block(p_input, material);
  q := private.stock_convert(p_input->>'quantity', (p_input->>'unit')::public.stock_unit, material.base_unit, material.density);
  scope_warehouse := nullif(p_input->>'warehouse_id', '')::uuid;
  issue_date := nullif(p_input->>'occurred_on', '')::date;
  if issue_date is null or issue_date > (now() at time zone 'Asia/Seoul')::date or issue_date < date '1900-01-01' then
    raise exception 'Transaction date must be an actual date no later than today' using errcode = '22023';
  end if;
  if scope_warehouse is not null and not exists (select 1 from public.warehouses where id = scope_warehouse and is_active) then
    raise exception 'Active warehouse is required' using errcode = '22023';
  end if;
  plan := private.stock_issue_plan(material.id, q, issue_date, scope_warehouse, block_quantity);
  total := (plan->>'available')::numeric;
  for planned_line in select value from jsonb_array_elements(plan->'lines') loop
    perform private.stock_check_date((planned_line->>'batch_id')::uuid, (planned_line->>'location_id')::uuid, issue_date);
  end loop;
  return plan || jsonb_build_object('material_id', material.id, 'quantity', q, 'base_unit', material.base_unit,
    'density_snapshot', material.density, 'shortage', greatest(q - total, 0), 'sufficient', total >= q,
    'issue_purpose', coalesce(p_input->>'issue_purpose', 'GENERAL'), 'input_quantity', (p_input->>'quantity')::numeric,
    'input_unit', p_input->>'unit', 'block_liters', case when block_quantity is not null then 18 else null end);
end;
$$;

create or replace view public.stock_ledger_rows with (security_invoker = true) as
select l.*, o.request_key, o.kind, o.material_id, o.occurred_on, o.input_quantity, o.input_unit, o.base_unit,
  o.density_snapshot, o.production_item, o.production_batch, o.reason, o.notes, o.actor_id, o.actor_name, o.created_at,
  m.code material_code, m.name material_name, r.test_number current_test_number,
  case when o.kind = 'ISSUE' then l.quantity - coalesce(s.quantity, 0) else 0 end returnable_quantity,
  case when o.kind = 'RETURN' then l.quantity - coalesce(s.quantity, 0) else 0 end releasable_quantity,
  lower(m.search_text || ' ' || l.test_number_snapshot || ' ' || r.test_number || ' ' || l.lot_number_snapshot || ' ' ||
    o.production_item || ' ' || o.production_batch || ' ' || r.receipt_reference || ' ' ||
    coalesce((select string_agg(h.test_number, ' ') from public.stock_batch_quality_history h where h.batch_id = r.id), '')) search_text,
  o.issue_purpose
from public.stock_transaction_lines l join public.stock_operations o on o.id = l.operation_id
join public.materials m on m.id = o.material_id join public.stock_batches r on r.id = l.batch_id
left join (select source_line_id, sum(quantity) quantity from public.stock_transaction_lines where source_line_id is not null group by source_line_id) s on s.source_line_id = l.id;

revoke all on function private.stock_issue_block(jsonb, public.materials),
  private.stock_issue_plan(uuid, numeric, date, uuid, numeric) from public, anon, authenticated;

comment on column public.stock_operations.issue_purpose is 'GENERAL FIFO or CLEANING in complete 18 L blocks per receipt cohort, aggregated across eligible locations.';
comment on function public.stock_issue(jsonb) is 'Atomic FIFO; CLEANING requires L quantities divisible by 18 and leaves incomplete blocks in each receipt cohort.';

commit;
