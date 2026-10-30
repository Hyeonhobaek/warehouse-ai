begin;

create type public.stock_unit as enum ('kg', 'g', 'L', 'mL', 'EA');
create type public.quality_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'HOLD');

create function private.current_user_is_active()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and is_active);
$$;

-- Unlike array_to_string, this narrowly typed helper is immutable and can be
-- used in a stored generated column. Aliases remain searchable as substrings.
create function private.material_search_text(code text, name text, aliases text[], manufacturer text)
returns text language sql immutable set search_path = '' as $$
  select lower(code || ' ' || name || ' ' || array_to_string(aliases, ' ') || ' ' || manufacturer);
$$;

create function private.valid_material_aliases(aliases text[])
returns boolean language sql immutable set search_path = '' as $$
  select cardinality(aliases) <= 20 and not exists (
    select 1 from unnest(aliases) alias where alias is null or char_length(trim(alias)) not between 1 and 100
  );
$$;

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(trim(code)) between 1 and 80 and code = trim(code)),
  name text not null check (char_length(trim(name)) between 1 and 200),
  aliases text[] not null default '{}' check (private.valid_material_aliases(aliases)),
  specification text not null default '' check (char_length(specification) <= 500),
  manufacturer text not null default '' check (char_length(manufacturer) <= 200),
  base_unit public.stock_unit not null,
  min_stock numeric(15,6) not null default 0 check (min_stock >= 0 and min_stock <> 'NaN'::numeric),
  storage_condition text not null default '' check (char_length(storage_condition) <= 500),
  package_size numeric(15,6) check (package_size > 0 and package_size <> 'NaN'::numeric),
  package_unit public.stock_unit,
  density numeric(15,6) check (density > 0 and density <> 'NaN'::numeric),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text text generated always as (private.material_search_text(code, name, aliases, manufacturer)) stored,
  check ((package_size is null) = (package_unit is null))
);

create table public.material_lots (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id) on delete restrict,
  lot_number text not null check (char_length(trim(lot_number)) between 1 and 100 and lot_number = trim(lot_number)),
  manufacturer text not null default '' check (char_length(manufacturer) <= 200),
  manufactured_on date check (manufactured_on between date '1900-01-01' and date '2199-12-31'),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (material_id, lot_number)
);

create table public.stock_batches (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.material_lots(id) on delete restrict,
  receipt_reference text not null unique check (char_length(trim(receipt_reference)) between 1 and 100 and receipt_reference = trim(receipt_reference)),
  received_on date not null check (received_on between date '1900-01-01' and date '2199-12-31'),
  expires_on date check (expires_on between date '1900-01-01' and date '2199-12-31' and expires_on >= received_on),
  retest_on date check (retest_on between date '1900-01-01' and date '2199-12-31' and retest_on >= received_on),
  test_number text not null default '' check (char_length(test_number) <= 100),
  quality_status public.quality_status not null default 'PENDING',
  decision_on date check (decision_on between date '1900-01-01' and date '2199-12-31' and decision_on >= received_on),
  quality_reason text not null check (char_length(trim(quality_reason)) between 1 and 1000),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stock_batch_quality_history (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.stock_batches(id) on delete restrict,
  test_number text not null,
  quality_status public.quality_status not null,
  decision_on date,
  expires_on date,
  retest_on date,
  reason text not null check (char_length(trim(reason)) between 1 and 1000),
  -- Retain the recorded actor even if an authentication account is deleted.
  actor_id uuid,
  created_at timestamptz not null default now()
);

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(trim(code)) between 1 and 80 and code = trim(code)),
  name text not null check (char_length(trim(name)) between 1 and 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.storage_locations (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  code text not null check (char_length(trim(code)) between 1 and 80 and code = trim(code)),
  name text not null check (char_length(trim(name)) between 1 and 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (warehouse_id, code)
);

-- Only trusted migrations/seed may initialize balances in Phase 2. A metadata
-- receipt has zero stock until a Phase 3 stock transaction creates a balance.
create table public.stock_balances (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.stock_batches(id) on delete restrict,
  location_id uuid not null references public.storage_locations(id) on delete restrict,
  on_hand numeric(15,6) not null default 0 check (on_hand >= 0 and on_hand <> 'NaN'::numeric),
  reserved numeric(15,6) not null default 0 check (reserved >= 0 and reserved <> 'NaN'::numeric),
  updated_at timestamptz not null default now(),
  unique (batch_id, location_id),
  check (reserved <= on_hand)
);

create index material_lots_material_idx on public.material_lots(material_id);
create index material_lots_number_idx on public.material_lots(lot_number);
create index stock_batches_lot_idx on public.stock_batches(lot_id);
create index stock_batches_test_idx on public.stock_batches(test_number);
create index stock_batches_retest_idx on public.stock_batches(retest_on);
create index stock_batches_expiry_idx on public.stock_batches(expires_on);
create index stock_batches_quality_idx on public.stock_batches(quality_status);
create index stock_batch_quality_history_batch_idx on public.stock_batch_quality_history(batch_id, created_at desc);
create index stock_balances_location_idx on public.stock_balances(location_id);

create function private.guard_inventory_metadata()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.id is distinct from new.id then raise exception 'Inventory identity is immutable' using errcode = '23503'; end if;
    new.created_at := old.created_at;
    new.updated_at := now();
    if tg_table_name = 'materials' then
      if old.base_unit is distinct from new.base_unit and exists (
        select 1 from public.material_lots where material_id = old.id
      ) then raise exception 'Base unit cannot change after LOT registration' using errcode = '23503'; end if;
    elsif tg_table_name = 'material_lots' then
      if old.material_id is distinct from new.material_id then raise exception 'LOT material is immutable' using errcode = '23503'; end if;
    elsif tg_table_name = 'stock_batches' then
      if old.lot_id is distinct from new.lot_id then raise exception 'Batch LOT is immutable' using errcode = '23503'; end if;
    elsif tg_table_name = 'storage_locations' then
      if old.warehouse_id is distinct from new.warehouse_id then raise exception 'Location warehouse is immutable' using errcode = '23503'; end if;
    end if;
  end if;
  if tg_table_name = 'stock_batches' then
    -- These are completed receipt/QC dates, not future plans or reservations.
    if new.received_on > (now() at time zone 'Asia/Seoul')::date then
      raise exception 'Receipt date cannot be in the future' using errcode = '23514';
    end if;
    if new.decision_on > (now() at time zone 'Asia/Seoul')::date then
      raise exception 'Quality decision date cannot be in the future' using errcode = '23514';
    end if;
    -- Serialize receipt validation with a concurrent manufacture-date correction.
    perform 1 from public.material_lots where id = new.lot_id for share;
    if exists (select 1 from public.material_lots where id = new.lot_id and manufactured_on > new.received_on) then
      raise exception 'Receipt date cannot precede manufacture date' using errcode = '23514';
    end if;
  elsif tg_table_name = 'material_lots' then
    -- A new LOT must not race a base-unit change on its parent material.
    perform 1 from public.materials where id = new.material_id for share;
    if exists (select 1 from public.stock_batches where lot_id = new.id and received_on < new.manufactured_on) then
      raise exception 'Manufacture date cannot follow an existing receipt date' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger materials_metadata_guard before update on public.materials for each row execute function private.guard_inventory_metadata();
create trigger material_lots_metadata_guard before insert or update on public.material_lots for each row execute function private.guard_inventory_metadata();
create trigger stock_batches_metadata_guard before insert or update on public.stock_batches for each row execute function private.guard_inventory_metadata();
create trigger warehouses_metadata_guard before update on public.warehouses for each row execute function private.guard_inventory_metadata();
create trigger storage_locations_metadata_guard before update on public.storage_locations for each row execute function private.guard_inventory_metadata();

create function private.record_batch_quality_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or
     row(old.test_number, old.quality_status, old.decision_on, old.expires_on, old.retest_on)
     is distinct from row(new.test_number, new.quality_status, new.decision_on, new.expires_on, new.retest_on) then
    insert into public.stock_batch_quality_history (
      batch_id, test_number, quality_status, decision_on, expires_on, retest_on, reason, actor_id
    ) values (
      new.id, new.test_number, new.quality_status, new.decision_on, new.expires_on, new.retest_on, new.quality_reason, auth.uid()
    );
  end if;
  return new;
end;
$$;
create trigger stock_batch_quality_record after insert or update on public.stock_batches for each row execute function private.record_batch_quality_history();

do $$
declare table_name text;
begin
  foreach table_name in array array['materials', 'material_lots', 'stock_batches', 'warehouses', 'storage_locations', 'stock_balances', 'stock_batch_quality_history'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('create policy inventory_active_select on public.%I for select to authenticated using ((select private.current_user_is_active()))', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
  end loop;
  foreach table_name in array array['materials', 'material_lots', 'stock_batches', 'warehouses', 'storage_locations'] loop
    execute format('create policy inventory_admin_insert on public.%I for insert to authenticated with check ((select private.current_user_is_admin()))', table_name);
    execute format('create policy inventory_admin_update on public.%I for update to authenticated using ((select private.current_user_is_admin())) with check ((select private.current_user_is_admin()))', table_name);
    execute format('grant insert, update on public.%I to authenticated', table_name);
  end loop;
end;
$$;

-- FK RESTRICT makes referenced material deletion fail, even for administrators.
create policy materials_admin_delete on public.materials for delete to authenticated using ((select private.current_user_is_admin()));
grant delete on public.materials to authenticated;

create view public.inventory_rows with (security_invoker = true) as
with eligibility as (
  select b.id, m.id material_id, m.code material_code, m.name material_name, m.base_unit, m.min_stock,
    m.is_active material_active, l.id lot_id, l.lot_number,
    coalesce(nullif(l.manufacturer, ''), m.manufacturer) manufacturer,
    r.id batch_id, r.receipt_reference, r.received_on, r.expires_on, r.retest_on, r.test_number,
    r.quality_status,
    case when r.expires_on < (now() at time zone 'Asia/Seoul')::date then 'EXPIRED' else r.quality_status::text end effective_status,
    w.id warehouse_id, w.code warehouse_code, w.name warehouse_name,
    p.id location_id, p.code location_code, p.name location_name,
    b.on_hand, b.reserved,
    case
      when not m.is_active then 'MATERIAL_INACTIVE'
      when not w.is_active then 'WAREHOUSE_INACTIVE'
      when not p.is_active then 'LOCATION_INACTIVE'
      when r.quality_status <> 'APPROVED' then 'QUALITY_NOT_APPROVED'
      when r.expires_on is null then 'EXPIRY_UNKNOWN'
      when r.expires_on < (now() at time zone 'Asia/Seoul')::date then 'EXPIRED'
      else null
    end availability_reason,
    -- Overdue retests remain due; expired stock uses EXPIRED rather than expiry_due.
    coalesce(r.retest_on <= (now() at time zone 'Asia/Seoul')::date + 30, false) retest_due,
    coalesce(r.expires_on between (now() at time zone 'Asia/Seoul')::date and (now() at time zone 'Asia/Seoul')::date + 30, false) expiry_due,
    lower(m.search_text || ' ' || l.lot_number || ' ' || r.test_number || ' ' || l.manufacturer || ' ' || r.receipt_reference) search_text
  from public.stock_balances b
  join public.stock_batches r on r.id = b.batch_id
  join public.material_lots l on l.id = r.lot_id
  join public.materials m on m.id = l.material_id
  join public.storage_locations p on p.id = b.location_id
  join public.warehouses w on w.id = p.warehouse_id
), quantities as (
  select eligibility.*,
    case when availability_reason is null then on_hand - reserved else 0 end available,
    case when availability_reason is null then 0 else on_hand end unavailable
  from eligibility
), totals as (
  select quantities.*, sum(available) over (partition by material_id) material_available from quantities
)
select id, material_id, material_code, material_name, base_unit, min_stock, material_active,
  lot_id, lot_number, manufacturer, batch_id, receipt_reference, received_on, expires_on, retest_on,
  test_number, quality_status, effective_status, warehouse_id, warehouse_code, warehouse_name,
  location_id, location_code, location_name, on_hand, reserved, available, unavailable,
  material_available, material_available < min_stock is_low_stock, retest_due, expiry_due, search_text, availability_reason
from totals;

create view public.material_stock_summary with (security_invoker = true) as
select m.id material_id, m.code material_code, m.name material_name, m.base_unit, m.min_stock, m.is_active,
  coalesce(s.on_hand, 0) on_hand, coalesce(s.reserved, 0) reserved,
  coalesce(s.available, 0) available, coalesce(s.unavailable, 0) unavailable,
  coalesce(c.lot_count, 0) lot_count, coalesce(c.batch_count, 0) batch_count,
  coalesce(s.available, 0) < m.min_stock is_low_stock,
  trim(m.search_text || ' ' || coalesce(c.search_text, '')) search_text
from public.materials m
left join (
  select material_id, sum(on_hand) on_hand, sum(reserved) reserved, sum(available) available, sum(unavailable) unavailable
  from public.inventory_rows group by material_id
) s on s.material_id = m.id
left join (
  select l.material_id, count(distinct l.id) lot_count, count(distinct r.id) batch_count,
    lower(string_agg(l.lot_number || ' ' || l.manufacturer || ' ' || coalesce(r.test_number, '') || ' ' || coalesce(r.receipt_reference, ''), ' ')) search_text
  from public.material_lots l left join public.stock_batches r on r.lot_id = l.id group by l.material_id
) c on c.material_id = m.id;

revoke all on public.inventory_rows, public.material_stock_summary from public, anon, authenticated;
grant select on public.inventory_rows, public.material_stock_summary to authenticated;
revoke all on function private.current_user_is_active(), private.material_search_text(text, text, text[], text), private.valid_material_aliases(text[]), private.guard_inventory_metadata(), private.record_batch_quality_history() from public, anon, authenticated;
grant execute on function private.current_user_is_active(), private.material_search_text(text, text, text[], text), private.valid_material_aliases(text[]) to authenticated;

comment on table public.stock_batches is 'Physical receipt cohort. Retesting changes metadata and appends history without duplicating stock.';
comment on table public.stock_balances is 'Phase 2 read-only stock balances. Stock mutation RPCs belong to Phase 3.';
comment on table public.stock_batch_quality_history is 'Append-only QC snapshots. Inserted by a protected trigger with authenticated actor and reason.';
comment on column public.materials.density is 'Optional verified kg/L conversion factor. No automatic quantity conversion in Phase 2.';
comment on column public.inventory_rows.retest_due is 'Retest date is within the next 30 days or overdue, as of Asia/Seoul.';
comment on column public.inventory_rows.unavailable is 'Full on-hand quantity excluded by QC, expiry or inactive master/location. Reserved eligible stock is reported separately.';
comment on column public.inventory_rows.availability_reason is 'First reason stock is unavailable: inactive material/warehouse/location, unapproved QC, unknown expiry or expired. Null means eligible before reservations.';

commit;
