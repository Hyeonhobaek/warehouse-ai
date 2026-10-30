-- Fictional demo data only. No customer spreadsheet rows or Auth credentials.
-- Run after migrations using a trusted database connection (e.g. supabase db reset).
-- Fixed UUIDs and DO NOTHING preserve existing data on every subsequent run.
-- Auth users are still created privately using docs/DATABASE.md.
begin;

insert into public.materials (id, code, name, aliases, specification, manufacturer, base_unit, min_stock, storage_condition, package_size, package_unit, density)
values
  ('10000000-0000-4000-8000-000000000001', 'DEMO-SOL-01', '가상 세척용 원료 A', array['DEMO-A', '가상용제'], '시험용 규격', '가상 제조사 A', 'kg', 25, '상온 보관', 20, 'L', 0.8),
  ('10000000-0000-4000-8000-000000000002', 'DEMO-POW-02', '가상 분말 원료 B', array['DEMO-B'], '시험용 규격', '가상 제조사 B', 'g', 200, '건조 보관', 1, 'kg', null),
  ('10000000-0000-4000-8000-000000000003', 'DEMO-LIQ-03', '가상 액상 원료 C', array['DEMO-C'], '시험용 규격', '가상 제조사 C', 'L', 100, '차광 보관', 10, 'L', 1.1),
  ('10000000-0000-4000-8000-000000000004', 'DEMO-ADD-04', '가상 첨가 원료 D', array['DEMO-D'], '시험용 규격', '가상 제조사 D', 'mL', 200, '냉장 보관', 500, 'mL', null),
  ('10000000-0000-4000-8000-000000000005', 'DEMO-UNIT-05', '가상 개수 원료 E', array['DEMO-E'], '시험용 규격', '가상 제조사 E', 'EA', 0, '상온 보관', 10, 'EA', null),
  ('10000000-0000-4000-8000-000000000006', 'DEMO-ZERO-06', '가상 미입고 원료 F', array['DEMO-F'], '시험용 규격', '가상 제조사 F', 'kg', 10, '상온 보관', null, null, null)
on conflict do nothing;

insert into public.warehouses (id, code, name, is_active) values
  ('20000000-0000-4000-8000-000000000001', 'DEMO-WH-A', '가상 원료 창고 A', true),
  ('20000000-0000-4000-8000-000000000002', 'DEMO-WH-B', '가상 원료 창고 B', true),
  ('20000000-0000-4000-8000-000000000003', 'DEMO-WH-OFF', '가상 운영중지 창고', false)
on conflict do nothing;

insert into public.storage_locations (id, warehouse_id, code, name, is_active) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'A-01', '가상 선반 A-01', true),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'QC-01', '가상 품질 격리 구역', true),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'OFF-01', '가상 사용중지 선반', false),
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000002', 'B-01', '가상 선반 B-01', true),
  ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000003', 'OFF-01', '가상 운영중지 창고 선반', true)
on conflict do nothing;

insert into public.material_lots (id, material_id, lot_number, manufacturer, manufactured_on, notes) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '000123-DEMO', '가상 제조사 A', (now() at time zone 'Asia/Seoul')::date - 120, '같은 제조 LOT의 두 입고건 / 선행 0 보존'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'DEMO-B-LOT', '가상 제조사 B', (now() at time zone 'Asia/Seoul')::date - 120, '사용보류 사례'),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'DEMO-C-OLD', '가상 제조사 C', (now() at time zone 'Asia/Seoul')::date - 120, '기한 경과 사례'),
  ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', 'DEMO-C-NEW', '가상 제조사 C', (now() at time zone 'Asia/Seoul')::date - 120, '유효기간 임박 / 부족 사례'),
  ('40000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000004', 'DEMO-D-LOT', '가상 제조사 D', (now() at time zone 'Asia/Seoul')::date - 120, '재시험 예정일 경과 / 비활성 위치 사례'),
  ('40000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000005', 'DEMO-E-LOT', '가상 제조사 E', (now() at time zone 'Asia/Seoul')::date - 120, '시험대기 / 부적합 사례')
on conflict do nothing;

insert into public.stock_batches (id, lot_id, receipt_reference, received_on, expires_on, retest_on, test_number, quality_status, decision_on, quality_reason)
select v.id::uuid, v.lot_id::uuid, v.receipt_reference, d.today - 60, d.today + v.expiry_days,
  case when v.retest_days is null then null else d.today + v.retest_days end,
  v.test_number, v.quality_status::public.quality_status,
  case when v.quality_status = 'PENDING' then null else d.today - 55 end,
  '가상 데모 데이터 최초 등록'
from (values
  ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'DEMO-RCV-001', 180, 20, 'DEMO-QC-001', 'APPROVED'),
  ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 'DEMO-RCV-002', 200, 60, 'DEMO-QC-002', 'APPROVED'),
  ('50000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000002', 'DEMO-RCV-003', 180, null, 'DEMO-QC-003', 'HOLD'),
  ('50000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000003', 'DEMO-RCV-004', -1, null, 'DEMO-QC-004', 'APPROVED'),
  ('50000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000004', 'DEMO-RCV-005', 14, 7, 'DEMO-QC-005', 'APPROVED'),
  ('50000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000005', 'DEMO-RCV-006', 180, -2, 'DEMO-QC-006', 'APPROVED'),
  ('50000000-0000-4000-8000-000000000007', '40000000-0000-4000-8000-000000000006', 'DEMO-RCV-007', 180, null, 'DEMO-QC-007', 'PENDING'),
  ('50000000-0000-4000-8000-000000000008', '40000000-0000-4000-8000-000000000006', 'DEMO-RCV-008', 180, null, 'DEMO-QC-008', 'REJECTED')
) v(id, lot_id, receipt_reference, expiry_days, retest_days, test_number, quality_status)
cross join (select (now() at time zone 'Asia/Seoul')::date today) d
on conflict do nothing;

insert into public.stock_balances (id, batch_id, location_id, on_hand, reserved) values
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 70, 10),
  ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000004', 40, 0),
  ('60000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000002', 250, 0),
  ('60000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000001', 150, 0),
  ('60000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000001', 40, 5),
  ('60000000-0000-4000-8000-000000000006', '50000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000001', 150, 50),
  ('60000000-0000-4000-8000-000000000007', '50000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000003', 200, 0),
  ('60000000-0000-4000-8000-000000000008', '50000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000002', 20, 0),
  ('60000000-0000-4000-8000-000000000009', '50000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000002', 5, 0),
  ('60000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000005', 15, 0)
on conflict do nothing;

commit;
