begin;

create type public.stock_operation_kind as enum ('RECEIPT', 'ISSUE', 'RETURN', 'RETURN_RELEASE');

alter table public.stock_balances add column held numeric(15,6) not null default 0
  check (held >= 0 and held <> 'NaN'::numeric);
alter table public.stock_balances add constraint stock_balances_available_nonnegative check (reserved + held <= on_hand);

create table public.stock_operations (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  kind public.stock_operation_kind not null,
  material_id uuid not null references public.materials(id) on delete restrict,
  occurred_on date not null check (occurred_on between date '1900-01-01' and date '2199-12-31'),
  input_quantity numeric(15,6) not null check (input_quantity > 0 and input_quantity <> 'NaN'::numeric),
  input_unit public.stock_unit not null,
  quantity numeric(15,6) not null check (quantity > 0 and quantity <> 'NaN'::numeric),
  base_unit public.stock_unit not null,
  density_snapshot numeric(15,6),
  production_item text not null default '' check (char_length(production_item) <= 200),
  production_batch text not null default '' check (char_length(production_batch) <= 100),
  reason text not null check (char_length(trim(reason)) between 1 and 1000),
  notes text not null default '' check (char_length(notes) <= 2000),
  actor_id uuid not null,
  actor_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  request_payload jsonb not null
);

create table public.stock_transaction_lines (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.stock_operations(id) on delete restrict,
  sequence integer not null check (sequence > 0),
  batch_id uuid not null references public.stock_batches(id) on delete restrict,
  location_id uuid not null references public.storage_locations(id) on delete restrict,
  source_line_id uuid references public.stock_transaction_lines(id) on delete restrict,
  quantity numeric(15,6) not null check (quantity > 0 and quantity <> 'NaN'::numeric),
  delta numeric(15,6) not null,
  on_hand_before numeric(15,6) not null check (on_hand_before >= 0),
  on_hand_after numeric(15,6) not null check (on_hand_after >= 0),
  held_before numeric(15,6) not null check (held_before >= 0),
  held_after numeric(15,6) not null check (held_after >= 0),
  test_number_snapshot text not null,
  lot_number_snapshot text not null,
  received_on_snapshot date not null,
  location_code_snapshot text not null,
  warehouse_code_snapshot text not null,
  unique (operation_id, sequence),
  check (on_hand_before + delta = on_hand_after),
  check (held_before <= on_hand_before and held_after <= on_hand_after)
);
create index stock_operations_material_date_idx on public.stock_operations(material_id, occurred_on, created_at);
create index stock_transaction_lines_batch_idx on public.stock_transaction_lines(batch_id, operation_id);
create index stock_transaction_lines_source_idx on public.stock_transaction_lines(source_line_id);

create function private.guard_stock_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Stock transaction history is immutable' using errcode = '23514';
end;
$$;
create trigger stock_operations_immutable before update or delete on public.stock_operations
  for each row execute function private.guard_stock_history();
create trigger stock_transaction_lines_immutable before update or delete on public.stock_transaction_lines
  for each row execute function private.guard_stock_history();

create function private.guard_stock_receipt_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.received_on is distinct from old.received_on or new.receipt_reference is distinct from old.receipt_reference) and (
    exists (select 1 from public.stock_balances where batch_id = old.id)
    or exists (select 1 from public.stock_transaction_lines where batch_id = old.id)
  ) then
    raise exception 'Receipt date and reference are immutable after stock initialization' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger stock_batches_receipt_date_guard before update on public.stock_batches
  for each row execute function private.guard_stock_receipt_date();

create function private.guard_stock_lot_number()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.lot_number is distinct from old.lot_number and exists (
    select 1 from public.stock_transaction_lines t join public.stock_batches b on b.id = t.batch_id where b.lot_id = old.id
  ) then raise exception 'LOT number is immutable after stock transactions' using errcode = '23514'; end if;
  return new;
end;
$$;
create trigger material_lots_stock_identity_guard before update on public.material_lots
  for each row execute function private.guard_stock_lot_number();

-- All quantities are rounded once to the material's six-decimal accounting unit.
-- Density is a verified kg/L factor supplied by the material master, never by clients.
create function private.stock_convert(p_quantity text, p_unit public.stock_unit, p_base public.stock_unit, p_density numeric)
returns numeric language plpgsql immutable set search_path = '' as $$
declare q numeric; converted numeric; from_mass boolean; to_mass boolean;
begin
  if p_quantity is null or p_quantity !~ '^[0-9]{1,9}(\.[0-9]{1,6})?$' then
    raise exception 'Quantity must be a positive decimal with at most six decimal places' using errcode = '22023';
  end if;
  q := p_quantity::numeric;
  if q <= 0 or q >= 1000000000 or p_unit is null or p_base is null then
    raise exception 'Quantity or unit is invalid' using errcode = '22023';
  end if;
  if p_unit = p_base then converted := q;
  elsif p_unit = 'EA' or p_base = 'EA' then
    raise exception 'EA cannot be converted to mass or volume' using errcode = '22023';
  else
    from_mass := p_unit in ('kg', 'g');
    to_mass := p_base in ('kg', 'g');
    converted := q / case when p_unit in ('g', 'mL') then 1000 else 1 end;
    if from_mass <> to_mass then
      if p_density is null or p_density <= 0 or p_density = 'NaN'::numeric then
        raise exception 'Verified material density is required for mass/volume conversion' using errcode = '22023';
      end if;
      converted := case when to_mass then converted * p_density else converted / p_density end;
    end if;
    converted := converted * case when p_base in ('g', 'mL') then 1000 else 1 end;
  end if;
  converted := round(converted, 6);
  if converted <= 0 or converted >= 1000000000 then
    raise exception 'Converted quantity is below precision or outside range' using errcode = '22023';
  end if;
  return converted;
end;
$$;

create function private.stock_result(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('operation', to_jsonb(o) - 'request_payload', 'lines',
    coalesce((select jsonb_agg(to_jsonb(l) order by l.sequence) from public.stock_transaction_lines l where l.operation_id = o.id), '[]'::jsonb))
  from public.stock_operations o where o.id = p_id;
$$;

-- Serializes identical request keys across all RPCs before any business writes.
-- Replays require the same actor, operation kind and complete JSON payload.
create function private.stock_begin(p_kind public.stock_operation_kind, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor public.profiles; previous public.stock_operations; key_value uuid;
begin
  select * into actor from public.profiles where id = auth.uid() for share;
  if not found or not actor.is_active or actor.role not in ('operator', 'admin')
    or (p_kind = 'RETURN_RELEASE' and actor.role <> 'admin') then
    raise exception 'Stock operation permission denied' using errcode = '42501';
  end if;
  if jsonb_typeof(p_input) is distinct from 'object' or nullif(p_input->>'request_key', '') is null then
    raise exception 'Request key and JSON object are required' using errcode = '22023';
  end if;
  key_value := (p_input->>'request_key')::uuid;
  perform pg_advisory_xact_lock(hashtextextended(key_value::text, 13));
  select * into previous from public.stock_operations where request_key = key_value;
  if found then
    if previous.kind <> p_kind or previous.actor_id <> actor.id or previous.request_payload <> p_input then
      raise exception 'Request key already used with different input' using errcode = '23505';
    end if;
    return private.stock_result(previous.id);
  end if;
  if char_length(trim(coalesce(p_input->>'reason', ''))) not between 1 and 1000
    or char_length(coalesce(p_input->>'notes', '')) > 2000
    or char_length(coalesce(p_input->>'production_item', '')) > 200
    or char_length(coalesce(p_input->>'production_batch', '')) > 100 then
    raise exception 'Reason or descriptive field is invalid' using errcode = '22023';
  end if;
  return null;
end;
$$;

create function private.stock_create_operation(p_kind public.stock_operation_kind, p_input jsonb, p_material public.materials, p_quantity numeric, p_date date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if p_date is null or p_date > (now() at time zone 'Asia/Seoul')::date or p_date < date '1900-01-01' then
    raise exception 'Transaction date must be an actual date no later than today' using errcode = '22023';
  end if;
  insert into public.stock_operations (request_key, kind, material_id, occurred_on, input_quantity, input_unit,
    quantity, base_unit, density_snapshot, production_item, production_batch, reason, notes, actor_id, actor_name, request_payload)
  select (p_input->>'request_key')::uuid, p_kind, p_material.id, p_date, (p_input->>'quantity')::numeric,
    (p_input->>'unit')::public.stock_unit, p_quantity, p_material.base_unit, p_material.density,
    coalesce(p_input->>'production_item', ''), coalesce(p_input->>'production_batch', ''), trim(p_input->>'reason'),
    coalesce(p_input->>'notes', ''), id, display_name, p_input from public.profiles where id = auth.uid()
  returning id into result_id;
  return result_id;
end;
$$;

create function private.stock_add_line(p_operation uuid, p_sequence integer, p_batch uuid, p_location uuid,
  p_source uuid, p_quantity numeric, p_delta numeric, p_before numeric, p_after numeric, p_held_before numeric, p_held_after numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  insert into public.stock_transaction_lines(operation_id, sequence, batch_id, location_id, source_line_id, quantity, delta,
    on_hand_before, on_hand_after, held_before, held_after, test_number_snapshot, lot_number_snapshot, received_on_snapshot,
    location_code_snapshot, warehouse_code_snapshot)
  select p_operation, p_sequence, r.id, p.id, p_source, p_quantity, p_delta, p_before, p_after, p_held_before, p_held_after,
    r.test_number, l.lot_number, r.received_on, p.code, w.code
  from public.stock_batches r join public.material_lots l on l.id = r.lot_id
  cross join public.storage_locations p join public.warehouses w on w.id = p.warehouse_id
  where r.id = p_batch and p.id = p_location returning id into result_id;
  return result_id;
end;
$$;

create function public.stock_receive(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb; material public.materials; lot public.material_lots; batch_id uuid;
  operation_id uuid; q numeric; place record; receipt_date date;
begin
  previous := private.stock_begin('RECEIPT', p_input);
  if previous is not null then return previous; end if;
  select * into material from public.materials where id = (p_input->>'material_id')::uuid for update;
  if not found or not material.is_active then raise exception 'Active material is required' using errcode = '22023'; end if;
  q := private.stock_convert(p_input->>'quantity', (p_input->>'unit')::public.stock_unit, material.base_unit, material.density);
  select p.id, p.is_active, w.is_active warehouse_active into place
    from public.storage_locations p join public.warehouses w on w.id = p.warehouse_id
    where p.id = (p_input->>'location_id')::uuid for share of p, w;
  if not found or not place.is_active or not place.warehouse_active then
    raise exception 'Active storage location and warehouse are required' using errcode = '22023';
  end if;
  receipt_date := (p_input->>'received_on')::date;
  operation_id := private.stock_create_operation('RECEIPT', p_input, material, q, receipt_date);
  select * into lot from public.material_lots where material_id = material.id and lot_number = trim(p_input->>'lot_number') for update;
  if not found then
    insert into public.material_lots(material_id, lot_number, manufacturer, manufactured_on)
      values(material.id, trim(p_input->>'lot_number'), coalesce(p_input->>'manufacturer', ''), nullif(p_input->>'manufactured_on', '')::date)
      returning * into lot;
  elsif (nullif(p_input->>'manufactured_on', '') is not null and lot.manufactured_on is distinct from (p_input->>'manufactured_on')::date)
    or (nullif(p_input->>'manufacturer', '') is not null and lot.manufacturer <> p_input->>'manufacturer') then
    raise exception 'Existing LOT metadata differs; review LOT before receiving' using errcode = '22023';
  end if;
  insert into public.stock_batches(lot_id, receipt_reference, received_on, expires_on, retest_on, test_number, quality_status, quality_reason, notes)
    values(lot.id, trim(p_input->>'receipt_reference'), receipt_date, nullif(p_input->>'expires_on', '')::date,
      nullif(p_input->>'retest_on', '')::date, coalesce(p_input->>'test_number', ''), 'PENDING', p_input->>'reason', coalesce(p_input->>'notes', ''))
    returning id into batch_id;
  insert into public.stock_balances(batch_id, location_id, on_hand) values(batch_id, place.id, q);
  perform private.stock_add_line(operation_id, 1, batch_id, place.id, null, q, q, 0, q, 0, 0);
  return private.stock_result(operation_id);
end;
$$;

create function private.stock_check_date(p_batch uuid, p_location uuid, p_date date)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.stock_transaction_lines l join public.stock_operations o on o.id = l.operation_id
    where l.batch_id = p_batch and l.location_id = p_location and o.occurred_on > p_date) then
    raise exception 'Transaction date precedes latest balance transaction' using errcode = '22023';
  end if;
end;
$$;

create function public.stock_issue(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb; material public.materials; q numeric; remaining numeric; taken numeric;
  operation_id uuid; allocation record; line_number integer := 0; issue_date date; scope_warehouse uuid;
begin
  previous := private.stock_begin('ISSUE', p_input);
  if previous is not null then return previous; end if;
  select * into material from public.materials where id = (p_input->>'material_id')::uuid for update;
  if not found or not material.is_active then raise exception 'Active material is required' using errcode = '22023'; end if;
  q := private.stock_convert(p_input->>'quantity', (p_input->>'unit')::public.stock_unit, material.base_unit, material.density);
  issue_date := (p_input->>'occurred_on')::date;
  scope_warehouse := nullif(p_input->>'warehouse_id', '')::uuid;
  if scope_warehouse is not null and not exists (select 1 from public.warehouses where id = scope_warehouse and is_active) then
    raise exception 'Active warehouse is required' using errcode = '22023';
  end if;
  -- Lock QC for every cohort before selecting eligible inventory, including cohorts
  -- becoming approved concurrently. Material row lock serializes all stock RPCs.
  perform r.id from public.stock_batches r join public.material_lots l on l.id = r.lot_id
    where l.material_id = material.id order by r.id for share of r;
  operation_id := private.stock_create_operation('ISSUE', p_input, material, q, issue_date);
  remaining := q;
  for allocation in
    select b.*, r.received_on from public.stock_balances b
    join public.stock_batches r on r.id = b.batch_id join public.material_lots l on l.id = r.lot_id
    join public.storage_locations p on p.id = b.location_id join public.warehouses w on w.id = p.warehouse_id
    where l.material_id = material.id and r.quality_status = 'APPROVED'
      and r.expires_on >= (now() at time zone 'Asia/Seoul')::date
      and p.is_active and w.is_active and (scope_warehouse is null or w.id = scope_warehouse)
      and r.received_on <= issue_date and b.on_hand > b.reserved + b.held
    order by r.received_on, r.created_at, r.id, p.id
    for update of b for share of p, w
  loop
    taken := least(remaining, allocation.on_hand - allocation.reserved - allocation.held);
    perform private.stock_check_date(allocation.batch_id, allocation.location_id, issue_date);
    update public.stock_balances set on_hand = on_hand - taken, updated_at = clock_timestamp() where id = allocation.id;
    line_number := line_number + 1;
    perform private.stock_add_line(operation_id, line_number, allocation.batch_id, allocation.location_id,
      null, taken, -taken, allocation.on_hand, allocation.on_hand - taken, allocation.held, allocation.held);
    remaining := remaining - taken;
    exit when remaining = 0;
  end loop;
  if remaining > 0 then
    raise exception 'Insufficient available stock; entire issue cancelled' using errcode = 'P0001';
  end if;
  return private.stock_result(operation_id);
end;
$$;

create function public.stock_return(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb; source public.stock_transaction_lines; source_operation public.stock_operations;
  material public.materials; q numeric; returned numeric; place record; balance public.stock_balances;
  operation_id uuid; return_date date;
begin
  previous := private.stock_begin('RETURN', p_input);
  if previous is not null then return previous; end if;
  select * into source from public.stock_transaction_lines where id = (p_input->>'issue_line_id')::uuid;
  if not found then raise exception 'Original issue allocation is required' using errcode = '22023'; end if;
  select * into source_operation from public.stock_operations where id = source.operation_id;
  if source_operation.kind <> 'ISSUE' then raise exception 'Return must reference an issue allocation' using errcode = '22023'; end if;
  select * into material from public.materials where id = source_operation.material_id for update;
  -- Returns are still accepted for an inactive or expired material, but always held.
  if (p_input->>'unit')::public.stock_unit is distinct from material.base_unit then
    raise exception 'Returns must use material base unit' using errcode = '22023';
  end if;
  q := private.stock_convert(p_input->>'quantity', material.base_unit, material.base_unit, null);
  select coalesce(sum(quantity), 0) into returned from public.stock_transaction_lines where source_line_id = source.id;
  if q > source.quantity - returned then raise exception 'Return exceeds original issued quantity remaining' using errcode = '22023'; end if;
  return_date := (p_input->>'occurred_on')::date;
  if return_date < source_operation.occurred_on then raise exception 'Return date precedes issue date' using errcode = '22023'; end if;
  perform 1 from public.stock_batches where id = source.batch_id for share;
  select p.id, p.is_active, w.is_active warehouse_active into place
    from public.storage_locations p join public.warehouses w on w.id = p.warehouse_id
    where p.id = (p_input->>'location_id')::uuid for share of p, w;
  if not found or not place.is_active or not place.warehouse_active then
    raise exception 'Active storage location and warehouse are required' using errcode = '22023';
  end if;
  insert into public.stock_balances(batch_id, location_id) values(source.batch_id, place.id) on conflict (batch_id, location_id) do nothing;
  select * into balance from public.stock_balances where batch_id = source.batch_id and location_id = place.id for update;
  perform private.stock_check_date(source.batch_id, place.id, return_date);
  operation_id := private.stock_create_operation('RETURN', p_input, material, q, return_date);
  -- Base-unit returns add physical stock and an equal held quantity atomically.
  update public.stock_balances set on_hand = on_hand + q, held = held + q, updated_at = clock_timestamp() where id = balance.id;
  perform private.stock_add_line(operation_id, 1, source.batch_id, place.id, source.id, q, q,
    balance.on_hand, balance.on_hand + q, balance.held, balance.held + q);
  return private.stock_result(operation_id);
end;
$$;

create function public.stock_release_return(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb; source public.stock_transaction_lines; source_operation public.stock_operations;
  material public.materials; q numeric; released numeric; balance public.stock_balances;
  operation_id uuid; release_date date; eligible record;
begin
  previous := private.stock_begin('RETURN_RELEASE', p_input);
  if previous is not null then return previous; end if;
  select * into source from public.stock_transaction_lines where id = (p_input->>'return_line_id')::uuid;
  if not found then raise exception 'Original return allocation is required' using errcode = '22023'; end if;
  select * into source_operation from public.stock_operations where id = source.operation_id;
  if source_operation.kind <> 'RETURN' then raise exception 'Release must reference a return allocation' using errcode = '22023'; end if;
  select * into material from public.materials where id = source_operation.material_id for update;
  if not material.is_active then raise exception 'Active material is required' using errcode = '22023'; end if;
  if (p_input->>'unit')::public.stock_unit is distinct from material.base_unit then
    raise exception 'Releases must use material base unit' using errcode = '22023';
  end if;
  q := private.stock_convert(p_input->>'quantity', material.base_unit, material.base_unit, null);
  select coalesce(sum(quantity), 0) into released from public.stock_transaction_lines where source_line_id = source.id;
  if q > source.quantity - released then raise exception 'Release exceeds held return quantity remaining' using errcode = '22023'; end if;
  release_date := (p_input->>'occurred_on')::date;
  if release_date < source_operation.occurred_on then raise exception 'Release date precedes return date' using errcode = '22023'; end if;
  select r.quality_status, r.expires_on, p.is_active, w.is_active warehouse_active into eligible
    from public.stock_batches r cross join public.storage_locations p join public.warehouses w on w.id = p.warehouse_id
    where r.id = source.batch_id and p.id = source.location_id for share of r, p, w;
  if eligible.quality_status <> 'APPROVED' or eligible.expires_on is null
    or eligible.expires_on < (now() at time zone 'Asia/Seoul')::date or not eligible.is_active or not eligible.warehouse_active then
    raise exception 'Returned stock is not eligible for release' using errcode = '22023';
  end if;
  select * into balance from public.stock_balances where batch_id = source.batch_id and location_id = source.location_id for update;
  if balance.held < q then raise exception 'Held return balance is inconsistent' using errcode = '23514'; end if;
  perform private.stock_check_date(source.batch_id, source.location_id, release_date);
  operation_id := private.stock_create_operation('RETURN_RELEASE', p_input, material, q, release_date);
  update public.stock_balances set held = held - q, updated_at = clock_timestamp() where id = balance.id;
  perform private.stock_add_line(operation_id, 1, source.batch_id, source.location_id, source.id, q, 0,
    balance.on_hand, balance.on_hand, balance.held, balance.held - q);
  return private.stock_result(operation_id);
end;
$$;

create function public.stock_preview_issue(p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare material public.materials; q numeric; scope_warehouse uuid; plan jsonb; total numeric; issue_date date; planned_line jsonb;
begin
  if not private.current_user_is_active() then raise exception 'Inventory access denied' using errcode = '42501'; end if;
  select * into material from public.materials where id = (p_input->>'material_id')::uuid;
  if not found or not material.is_active then raise exception 'Active material is required' using errcode = '22023'; end if;
  q := private.stock_convert(p_input->>'quantity', (p_input->>'unit')::public.stock_unit, material.base_unit, material.density);
  scope_warehouse := nullif(p_input->>'warehouse_id', '')::uuid;
  issue_date := nullif(p_input->>'occurred_on', '')::date;
  if issue_date is null or issue_date > (now() at time zone 'Asia/Seoul')::date or issue_date < date '1900-01-01' then
    raise exception 'Transaction date must be an actual date no later than today' using errcode = '22023';
  end if;
  if scope_warehouse is not null and not exists (select 1 from public.warehouses where id = scope_warehouse and is_active) then
    raise exception 'Active warehouse is required' using errcode = '22023';
  end if;
  with eligible as (
    select b.batch_id, b.location_id, r.received_on, r.test_number, l.lot_number, r.created_at,
      p.code location_code, w.code warehouse_code, b.on_hand - b.reserved - b.held available_quantity,
      coalesce(sum(b.on_hand - b.reserved - b.held) over (order by r.received_on, r.created_at, r.id, p.id rows between unbounded preceding and 1 preceding), 0) preceding_quantity
    from public.stock_balances b join public.stock_batches r on r.id = b.batch_id
    join public.material_lots l on l.id = r.lot_id join public.storage_locations p on p.id = b.location_id
    join public.warehouses w on w.id = p.warehouse_id
    where l.material_id = material.id and r.quality_status = 'APPROVED'
      and r.expires_on >= (now() at time zone 'Asia/Seoul')::date and p.is_active and w.is_active
      and (scope_warehouse is null or w.id = scope_warehouse) and b.on_hand > b.reserved + b.held
      and r.received_on <= issue_date
  ) select coalesce(sum(available_quantity), 0), coalesce(jsonb_agg(jsonb_build_object(
      'batch_id', batch_id, 'location_id', location_id, 'received_on', received_on, 'test_number', test_number,
      'lot_number', lot_number, 'location_code', location_code, 'warehouse_code', warehouse_code,
      'available', available_quantity, 'quantity', least(available_quantity, q - preceding_quantity))
      order by received_on, created_at, batch_id, location_id) filter(where preceding_quantity < q), '[]'::jsonb)
    into total, plan from eligible;
  for planned_line in select value from jsonb_array_elements(plan) loop
    perform private.stock_check_date((planned_line->>'batch_id')::uuid, (planned_line->>'location_id')::uuid, issue_date);
  end loop;
  return jsonb_build_object('material_id', material.id, 'quantity', q, 'base_unit', material.base_unit,
    'density_snapshot', material.density, 'available', total, 'shortage', greatest(q - total, 0), 'sufficient', total >= q, 'lines', plan);
end;
$$;

-- Preserve existing view column order; held is appended for Phase 2 consumers.
create or replace view public.inventory_rows with (security_invoker = true) as
with eligibility as (
  select b.id, m.id material_id, m.code material_code, m.name material_name, m.base_unit, m.min_stock,
    m.is_active material_active, l.id lot_id, l.lot_number,
    coalesce(nullif(l.manufacturer, ''), m.manufacturer) manufacturer,
    r.id batch_id, r.receipt_reference, r.received_on, r.expires_on, r.retest_on, r.test_number,
    r.quality_status,
    case when r.expires_on < (now() at time zone 'Asia/Seoul')::date then 'EXPIRED' else r.quality_status::text end effective_status,
    w.id warehouse_id, w.code warehouse_code, w.name warehouse_name,
    p.id location_id, p.code location_code, p.name location_name, b.on_hand, b.reserved, b.held,
    case when not m.is_active then 'MATERIAL_INACTIVE' when not w.is_active then 'WAREHOUSE_INACTIVE'
      when not p.is_active then 'LOCATION_INACTIVE' when r.quality_status <> 'APPROVED' then 'QUALITY_NOT_APPROVED'
      when r.expires_on is null then 'EXPIRY_UNKNOWN' when r.expires_on < (now() at time zone 'Asia/Seoul')::date then 'EXPIRED'
      else null end availability_reason,
    coalesce(r.retest_on <= (now() at time zone 'Asia/Seoul')::date + 30, false) retest_due,
    coalesce(r.expires_on between (now() at time zone 'Asia/Seoul')::date and (now() at time zone 'Asia/Seoul')::date + 30, false) expiry_due,
    lower(m.search_text || ' ' || l.lot_number || ' ' || r.test_number || ' ' || l.manufacturer || ' ' || r.receipt_reference) search_text
  from public.stock_balances b join public.stock_batches r on r.id = b.batch_id
  join public.material_lots l on l.id = r.lot_id join public.materials m on m.id = l.material_id
  join public.storage_locations p on p.id = b.location_id join public.warehouses w on w.id = p.warehouse_id
), quantities as (
  select eligibility.*, case when availability_reason is null then on_hand - reserved - held else 0 end available,
    case when availability_reason is null then held + 0 else on_hand + 0 end unavailable from eligibility
), totals as (
  select quantities.*, sum(available) over (partition by material_id) material_available from quantities
)
select id, material_id, material_code, material_name, base_unit, min_stock, material_active,
  lot_id, lot_number, manufacturer, batch_id, receipt_reference, received_on, expires_on, retest_on,
  test_number, quality_status, effective_status, warehouse_id, warehouse_code, warehouse_name,
  location_id, location_code, location_name, on_hand, reserved, available, unavailable,
  material_available, material_available < min_stock is_low_stock, retest_due, expiry_due, search_text, availability_reason, held
from totals;

create or replace view public.material_stock_summary with (security_invoker = true) as
select m.id material_id, m.code material_code, m.name material_name, m.base_unit, m.min_stock, m.is_active,
  coalesce(s.on_hand, 0) on_hand, coalesce(s.reserved, 0) reserved,
  coalesce(s.available, 0) available, coalesce(s.unavailable, 0) unavailable,
  coalesce(c.lot_count, 0) lot_count, coalesce(c.batch_count, 0) batch_count,
  coalesce(s.available, 0) < m.min_stock is_low_stock,
  trim(m.search_text || ' ' || coalesce(c.search_text, '')) search_text, coalesce(s.held, 0) held
from public.materials m
left join (select material_id, sum(on_hand) on_hand, sum(reserved) reserved, sum(available) available, sum(unavailable) unavailable, sum(held) held
  from public.inventory_rows group by material_id) s on s.material_id = m.id
left join (select l.material_id, count(distinct l.id) lot_count, count(distinct r.id) batch_count,
  lower(string_agg(l.lot_number || ' ' || l.manufacturer || ' ' || coalesce(r.test_number, '') || ' ' || coalesce(r.receipt_reference, ''), ' ')) search_text
  from public.material_lots l left join public.stock_batches r on r.lot_id = l.id group by l.material_id) c on c.material_id = m.id;

create view public.stock_batch_options with (security_invoker = true) as
select r.id batch_id, m.id material_id, m.code material_code, m.name material_name, l.lot_number,
  r.test_number, r.received_on, r.receipt_reference, m.base_unit, r.quality_status,
  coalesce(s.on_hand, 0) on_hand, coalesce(s.held, 0) held, coalesce(s.available, 0) available,
  lower(m.search_text || ' ' || l.lot_number || ' ' || r.test_number || ' ' || r.receipt_reference || ' ' ||
    coalesce((select string_agg(h.test_number, ' ') from public.stock_batch_quality_history h where h.batch_id = r.id), '')) search_text
from public.stock_batches r join public.material_lots l on l.id = r.lot_id join public.materials m on m.id = l.material_id
left join (select batch_id, sum(on_hand) on_hand, sum(held) held, sum(available) available from public.inventory_rows group by batch_id) s on s.batch_id = r.id;

create view public.stock_ledger_rows with (security_invoker = true) as
select l.*, o.request_key, o.kind, o.material_id, o.occurred_on, o.input_quantity, o.input_unit, o.base_unit,
  o.density_snapshot, o.production_item, o.production_batch, o.reason, o.notes, o.actor_id, o.actor_name, o.created_at,
  m.code material_code, m.name material_name, r.test_number current_test_number,
  case when o.kind = 'ISSUE' then l.quantity - coalesce(s.quantity, 0) else 0 end returnable_quantity,
  case when o.kind = 'RETURN' then l.quantity - coalesce(s.quantity, 0) else 0 end releasable_quantity,
  lower(m.search_text || ' ' || l.test_number_snapshot || ' ' || r.test_number || ' ' || l.lot_number_snapshot || ' ' ||
    o.production_item || ' ' || o.production_batch || ' ' || r.receipt_reference || ' ' ||
    coalesce((select string_agg(h.test_number, ' ') from public.stock_batch_quality_history h where h.batch_id = r.id), '')) search_text
from public.stock_transaction_lines l join public.stock_operations o on o.id = l.operation_id
join public.materials m on m.id = o.material_id join public.stock_batches r on r.id = l.batch_id
left join (select source_line_id, sum(quantity) quantity from public.stock_transaction_lines where source_line_id is not null group by source_line_id) s on s.source_line_id = l.id;

do $$
declare table_name text; routine record;
begin
  foreach table_name in array array['stock_operations', 'stock_transaction_lines'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('create policy stock_active_select on public.%I for select to authenticated using ((select private.current_user_is_active()))', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
  end loop;
  for routine in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (p.proname like 'stock_%' or p.proname like 'guard_stock_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', routine.signature);
  end loop;
end;
$$;
revoke all on public.stock_ledger_rows, public.stock_batch_options from public, anon, authenticated;
grant select on public.stock_ledger_rows, public.stock_batch_options to authenticated;
revoke all on function public.stock_receive(jsonb), public.stock_issue(jsonb), public.stock_return(jsonb),
  public.stock_release_return(jsonb), public.stock_preview_issue(jsonb) from public, anon, authenticated;
grant execute on function public.stock_receive(jsonb), public.stock_issue(jsonb), public.stock_return(jsonb),
  public.stock_release_return(jsonb), public.stock_preview_issue(jsonb) to authenticated;

comment on table public.stock_operations is 'Immutable Phase 3 operations. Existing Phase 2 balances are not fabricated as historical receipts.';
comment on table public.stock_transaction_lines is 'Immutable allocations; original issue and return lines link all reversals and releases.';
comment on column public.stock_balances.held is 'Returned quantity awaiting an explicit administrator release, excluded from availability.';
comment on column public.inventory_rows.unavailable is 'Full on-hand for ineligible stock; held returns only for eligible stock. Reserved quantity is reported separately.';
comment on function public.stock_issue(jsonb) is 'Atomic FIFO across active storage locations, optionally restricted to one warehouse. Preview is advisory; save rechecks under locks.';

commit;
