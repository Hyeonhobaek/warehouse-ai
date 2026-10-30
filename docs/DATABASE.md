# 데이터베이스 — Phase 1·2·3

원본 기획서는 루트의 `PRO.md`이다. Phase 1의 인증 기반 위에 Phase 2의 원료·LOT·입고건·창고·재고 조회를 추가한다. Phase 3은 아래 거래 RPC와 변경할 수 없는 원장을 추가한다.

## Phase 2 적용과 모델

Phase 1 이후 `supabase/migrations/20261030000100_inventory_foundation.sql`을 적용한다. 가상 데이터 전용 프로젝트에서 `supabase/seed.sql`을 실행하면 원료 6개·LOT 6개·입고건 8개·잔고 10개를 준비한다. Auth 계정은 생성하지 않는다. seed 재실행은 기존 행을 덮어쓰지 않으며 상대 날짜는 최초 실행일 기준이다. `db push`는 seed를 자동 실행하지 않는다.

| 객체 | 역할 |
| --- | --- |
| `materials` | 원료코드·이름·별칭·규격·제조사·기본단위·최소재고·보관조건·포장규격·밀도·사용상태 |
| `material_lots` | 원료+제조번호의 유일 조합, 실제 제조사·제조일 |
| `stock_batches` | 실제 입고건, 입고 참조번호·입고일·시험번호·품질상태·판정일·유효기한·재시험일 |
| `stock_batch_quality_history` | 최초 및 시험번호·품질상태·판정일·기한 변경 이력, 사유·처리자 |
| `warehouses`, `storage_locations` | 창고와 창고 안의 위치, 사용상태 |
| `stock_balances` | 입고건+위치별 현재고·예약수량 |
| `inventory_rows` | 상세 재고와 품질·부족·재시험/기한 임박 표시 |
| `material_stock_summary` | 무재고 원료를 포함한 원료별 합계 |

제조번호·시험번호는 선행 0을 보존하는 문자열이다. 같은 제조 LOT의 분할 입고는 서로 다른 입고건으로 관리한다. 재시험은 기존 입고건의 QC 정보를 갱신하고 이력을 남긴다. 기초정보 API의 입고건 등록은 잔고를 생성하지 않으므로 수량은 0이다. 실제 입고는 stock_receive RPC로 새 입고건과 수량을 함께 만든다.

### 수량과 날짜

- 수량은 `NUMERIC(15,6)`, 기본단위는 `kg`, `g`, `L`, `mL`, `EA`이다. SQL에서 계산하며 다른 원료·단위 수량을 하나로 합산하지 않는다.
- 포장규격은 기준정보이며 박스·포대 자동 환산은 제공하지 않는다. 입고·불출 RPC는 kg↔g, L↔mL를 환산하고 질량↔부피 환산은 등록된 밀도(kg/L)가 있을 때만 허용한다. 입력수량·단위·기본단위·밀도 snapshot을 보존하며 최종 기본수량을 소수 6자리로 반올림한다. 반올림 후 0 또는 범위를 초과하면 거절한다. 반납·반납 승인은 기본단위만 허용한다.
- 음수 재고 불가, 예약 + 반납보류(held) ≤ 현재고. 참조 LOT가 있는 원료의 기본단위는 변경 불가다.
- 날짜는 `DATE`, 기준일은 `Asia/Seoul`이다. 유효기한 당일까지 유효하며 오늘보다 이른 기한은 `EXPIRED`로 계산한다. 기존 QC 판정은 보존한다.
- 가용재고는 적합·유효기간 확인 완료·유효·활성 원료/창고/위치인 경우 `현재고 − 예약 − 반납보류`, 그 외 0이다. 유효기간 공란은 미확인이며 무기한 사용 가능으로 취급하지 않는다. `availability_reason`에 사용불가 사유를 제공한다.
- 사용불가재고는 품질·기한·사용상태가 부적격이면 전체 현재고, 적격이면 반납보류 수량이다. 예약과 다른 개념이며 사용불가 재고에도 기존 예약이 남을 수 있어 세 항목을 무조건 합산하지 않는다.
- 부족은 **전체 위치의 원료별 가용재고 합계 < 최소재고**이다. 상세 위치/품질 필터를 걸어도 전체 기준을 유지한다.
- 재시험 예정은 오늘+30일 이내이며 경과 건을 포함한다. 재시험일 경과로 QC 판정을 자동 변경하지 않는다. 유효기간 임박은 오늘~30일 이내이며 기한 경과는 별도 필터다.
- 제조일 ≤ 입고일, 판정일·재시험일·유효기한 ≥ 입고일을 검증한다. 실제 입고일·판정일은 서울 기준 오늘까지만 허용한다. 재고 또는 거래가 연결된 입고건의 입고일·입고 참조번호는 변경할 수 없다. LOT의 원료, 입고건의 LOT, 위치의 창고 소속도 변경할 수 없다.

### 업무 권한과 이력

활성 Viewer/Operator/Admin은 업무 데이터를 조회하며 Admin만 기준정보를 생성/수정한다. 미참조 원료만 삭제 가능하고 LOT가 연결된 원료는 사용 중지한다. 다른 업무 테이블에는 삭제 권한을 부여하지 않는다. 서버 검증과 DB RLS를 함께 적용하며 뷰는 `security_invoker=true`를 사용한다.

**Admin도 잔고·품질 이력을 직접 INSERT/UPDATE/DELETE할 수 없다.** 가상 seed는 신뢰된 DB 관리 연결에서만 실행한다. 품질정보 변경은 트리거가 같은 트랜잭션에서 이력을 남긴다. 변경 사유는 필수이고 `auth.uid()`를 처리자로 기록한다. 초기 관리자의 품질정보 기록이며 QA 전자승인이나 전체 거래 감사추적은 아니다.

## Phase 3 입출고·반납·원장

Phase 2 다음에 `20261030000200_stock_transactions.sql` 전체를 한 번 적용한다. 기존 잔량은 유지하며 `stock_balances.held`는 0으로 시작한다. 엑셀의 과거 거래를 소급 생성하지 않는다. 도입 이전 잔량은 입고건별 현재고에서 확인하며 원장은 도입 이후 거래만 보여준다.

| 객체 | 역할 |
| --- | --- |
| `stock_operations` | 요청키, 유형, 원료, 업무일, 입력/기본수량·단위·밀도, 품목·제조배치, 담당자·사유·처리시각 |
| `stock_transaction_lines` | 입고건·위치별 배분, 당시 LOT·시험번호·입고일·위치, 전후 현재고·보류, 원불출/반납행 연결 |
| `stock_ledger_rows` | 거래 원장, 현재/과거 시험번호 검색, 반납 가능량·승인 대기량 |
| `stock_batch_options` | 재시험 이력 검색을 포함한 입고건 목록과 현재고·가용·보류 합계 |

`stock_receive`, `stock_issue`, `stock_return`, `stock_release_return`는 JSONB `p_input`을 받고 `{ operation, lines }`를 반환한다. 입력에는 UUID `request_key`, 양수 `quantity`, `unit`, 필수 `reason`이 필요하다. 입고는 `received_on`, 나머지는 `occurred_on`을 사용한다. 미래일 및 대상 위치의 마지막 거래보다 이전 날짜는 허용하지 않는다.

- **입고:** 활성 원료·위치를 확인하고 기존 제조 LOT를 재사용하거나 신규 생성한다. 새 실제 입고건은 항상 PENDING이다. 같은 LOT여도 새 물량을 기존 적합 재고에 섞지 않는다.
- **불출:** 원료 행을 잠근 뒤 QC와 잔고·위치 행도 잠그고 적합·현재 기한 유효·활성 재고에서 예약·보류를 제외한다. 실제 입고일, 입고건 등록시각, 입고건 ID, 위치 ID 순으로 차감한다. `warehouse_id`를 지정하면 해당 창고로 제한한다. 수동 FIFO 예외는 없다. 수량이 부족하면 헤더·분할행·잔량을 전부 취소한다.
- **반납:** `issue_line_id`를 통해 원불출 분할행에 연결한다. 누적 반납량은 그 행의 불출량을 초과하지 않는다. 선택한 활성 위치로 현재고와 보류를 함께 증가시키며 원입고건의 QC 상태를 바꾸지 않는다. 비활성/기한경과 원료도 반납 보류는 가능하다.
- **반납 승인:** Admin만 `return_line_id`의 미승인 수량 범위에서 처리한다. 현재고는 그대로 두고 보류만 감소시키며 원료·위치 활성, QC 적합, 유효기간을 다시 확인한다. 일반 QC 변경으로 보류를 해제할 수 없다.
- **미리보기:** 읽기 RPC `stock_preview_issue`는 예상 분할량과 부족량을 반환한다. 예약하거나 잔고를 변경하지 않으며 저장 시 다시 계산한다.

모든 쓰기 RPC는 `security definer`와 빈 `search_path`를 사용하고 내부에서 활성 프로필 및 역할을 다시 확인한다. 내부 helper 실행권한은 공개하지 않는다. Viewer는 조회/미리보기만, Operator와 Admin은 입고·불출·반납, Admin은 반납 승인까지 가능하다. 모든 역할에 잔고·거래의 직접 쓰기를 금지한다. 거래 헤더·분할행에는 UPDATE/DELETE 차단 트리거와 RLS를 적용한다.

요청키에 트랜잭션 advisory lock을 걸어 동일 사용자·동일 내용 재시도를 한 번만 반영한다. 같은 키에 다른 내용 또는 사용자를 넣으면 거절한다. 모든 재고 RPC가 원료 행 잠금을 공유하여 같은 원료의 불출·반납·승인을 직렬화한다. 교착상태나 일시적 잠금 오류는 같은 요청키로 재시도할 수 있다.

## 세척 18L·BOM·생산일정 확장

`20261030000200_stock_transactions.sql` 다음에 `20261030000300_cleaning_fifo.sql`, `20261030000400_bom_planning.sql`을 순서대로 적용한다. 기존 거래의 `issue_purpose`는 GENERAL로 초기화하며 과거 재고·원장 수량을 변경하지 않는다.

- `stock_operations.issue_purpose`: GENERAL 또는 CLEANING. CLEANING은 입력 L의 양수 18배수만 허용한다. 입고건별 가용량에서 완전한 18L만 배정하고 나머지는 보존한다. 같은 입고건의 여러 위치는 선택 창고 범위에서 합산한다.
- `stock_preview_issue`: 실제 차감과 같은 배정 함수를 사용한다. `available`은 해당 방식으로 배정 가능한 기본단위 수량, `raw_available`은 블록 제한 전 가용량이다. `input_quantity`, `input_unit`, `block_liters`와 환산 수량을 함께 반환한다.
- `bom_recipes`: 고유 코드·제품명·revision·활성 상태·JSON 구성 원료(최대 100개). 원료/용도 조합은 유일하며 참조 원료 삭제를 막는다. BOM 저장과 일정 생성 시 단위·밀도·세척 배수를 검사한다.
- `production_schedules`: 고유 일정 코드, BOM, 예정일, 생산 배수, 제조 배치, ACTIVE/CANCELLED 상태, revision 및 적용 BOM revision.
- `stock_issue_plans`: 일정/원료/용도별 고유 계획, 예정일·입력 수량·단위, PLANNED/ISSUED/CANCELLED 상태, revision 및 연결 거래. 출고 완료 계획은 변경·삭제할 수 없다.
- `planning_change_history`: 담당자·시각·사유 및 변경 전후 JSON을 기록하며 변경·삭제를 금지한다.

조회는 활성 사용자 모두 허용하고 직접 쓰기는 모든 역할에 금지한다. `planning_save_bom`은 Admin만, `planning_save_schedule`·`planning_issue_plan`은 Operator/Admin만 실행한다. 새 BOM/일정은 `id=null, expected_revision=null`, 수정은 기존 ID와 현재 revision을 전달한다. 변경 이력은 RPC 안에서 함께 생성한다.

일정 저장은 현재 BOM 소요량 × 생산 배수를 소수 6자리 범위에서 정확히 계산한다. 미출고 계획만 생성·변경·취소하며 같은 구성요소의 ID를 유지한다. 출고된 계획이 있는 일정은 다른 BOM으로 교체할 수 없다. BOM 자체 편집은 기존 일정을 자동 재저장하지 않는다. 계획은 예약·차감에 영향을 주지 않으며 실제 확정 시 가용량을 다시 검사한다.

계획 출고는 `{plan_id, expected_revision, request_key, occurred_on, warehouse_id, reason, notes}`를 받는다. 수량·원료·용도는 클라이언트가 바꿀 수 없으며 잠근 계획에서 가져온다. 미래 예정일·예정일 이전 출고를 차단한다. 일정→계획 잠금 후 기존 불출 RPC를 실행하고 같은 트랜잭션으로 계획을 완료 처리한다. 동일 요청 재시도는 기존 거래를 반환하며 다른 키의 중복 출고를 막는다.

월 재고조사·조정 거래는 처리 정책 미확정으로 포함하지 않는다.

## Phase 1 인증 기반

## 적용

Supabase Cloud의 **SQL Editor**에서 `supabase/migrations/20261029000100_identity_foundation.sql` 전체를 한 번 실행한다. 이 경로는 빠른 초기 설정용이다. 이후 CLI로 전환할 때 이미 적용한 migration을 다시 실행하지 말고 migration 이력을 먼저 맞춘다.

처음부터 Supabase CLI를 사용한다면 저장소 루트에서 다음을 실행한다. CLI 로그인은 개발자의 계정에서 직접 진행한다.

```powershell
supabase login
supabase link --project-ref <개발용-project-ref>
supabase db push
```

SQL Editor에서 이미 적용한 후 CLI를 연결했다면 해당 SQL과 DB가 일치하는지 확인한 뒤 `supabase migration repair 20261029000100 --status applied --linked`로 이력을 맞춘다. 운영 DB에 `supabase db reset`을 실행하지 않는다.

Migration 이력 관리 방식은 [Supabase 공식 migration 가이드](https://supabase.com/docs/guides/deployment/database-migrations)를 참고한다. 로컬 CLI 설정은 [공식 config 문서](https://supabase.com/docs/guides/local-development/cli/config)의 항목을 사용한다.

## 테이블과 정책

| 객체 | 용도 | 애플리케이션 권한 |
| --- | --- | --- |
| `public.app_role` | `viewer`, `operator`, `admin` 역할 | 프로필에서 읽기 |
| `public.profiles` | Auth UUID, 표시 이름, 역할, 활성 여부, 생성·수정 시각 | 활성 사용자 본인 조회; 활성 Admin은 전체 조회 |
| `public.profile_role_audit` | 권한·활성 상태 변경 전후 값, 대상·처리자 UUID, DB 세션 사용자, 시각, 사유 | 활성 Admin만 조회 |

모든 테이블에 RLS를 적용한다. `anon`은 테이블 권한이 없다. `authenticated`에는 SELECT만 부여하며 INSERT/UPDATE/DELETE 정책과 권한을 제공하지 않는다. 클라이언트가 Admin 계정으로 접근해도 프로필을 직접 변경할 수 없다. 관리자 권한 검사 함수는 노출하지 않는 `private` 스키마에 두고 `search_path`를 고정한다.

Auth 신규 계정 트리거는 프로필을 항상 Viewer로 생성한다. 사용자가 수정할 수 있는 `raw_user_meta_data.role`을 신뢰하지 않는다. 표시 이름만 최대 80자로 정리해서 사용한다. Migration 적용 전에 존재한 계정도 Viewer로 초기화한다.

## 가상 테스트 계정

Cloud의 **Authentication → Users → Add user**에서 아래 가상 계정을 생성하고 개발자만 아는 고유 비밀번호를 설정한다. 테스트 계정에는 Auto Confirm을 선택한다. 비밀번호를 소스 또는 seed 파일에 저장하지 않는다.

| 이메일 예시 | 역할 |
| --- | --- |
| `viewer@example.test` | Viewer (기본값) |
| `operator@example.test` | Operator |
| `admin@example.test` | Admin |

Cloud Auth 설정에서 공개 회원가입을 비활성화한다. 앱 자체에도 회원가입 화면/API는 없다. `supabase/config.toml`의 로컬 Auth는 회원가입이 비활성화되어 있다.

Phase 1에서 계정 생성·권한 부여는 신뢰할 수 있는 운영자가 Supabase Dashboard/SQL Editor로 수행한다. 다음 SQL은 생성한 가상 계정에만 실행한다.

```sql
begin;
set local app.audit_reason = 'Phase 1 가상 테스트 관리자 초기 지정';
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'admin@example.test');
commit;

begin;
set local app.audit_reason = 'Phase 1 가상 테스트 작업자 초기 지정';
update public.profiles
set role = 'operator'
where id = (select id from auth.users where email = 'operator@example.test');
commit;
```

계정 중지는 같은 방법으로 `is_active = false`를 설정한다. 역할 또는 활성 상태 변경에는 1~500자 사유가 필수다. 사유가 없으면 변경 전체가 실패한다. 트리거는 변경과 감사 기록을 같은 PostgreSQL 트랜잭션에서 저장한다. SQL Editor의 변경은 사용자 JWT가 없으므로 `actor_id`가 null일 수 있으며 `database_actor`에 DB 세션 사용자가 기록된다. 사유에는 변경 요청 또는 작업 기록 식별자를 남기는 것을 권장한다.

```sql
select p.id, u.email, p.role, p.is_active
from public.profiles p join auth.users u on u.id = p.id;

select * from public.profile_role_audit order by created_at desc;
```

## 검증 범위

`tests/database.test.ts`는 PGlite의 PostgreSQL 엔진에 실제 migration을 적용하고 RLS, 읽기 권한, 직접 권한 상승 차단, 기본 역할, 비활성 계정, 감사 기록을 검증한다. 테스트용 `auth.users`/`auth.uid()`는 Supabase Auth 계약을 재현한 최소 fixture다. Cloud의 Auth 서비스나 PostgREST를 실행하는 통합 테스트와는 구분한다.

DB 소유자는 RLS와 트리거를 관리할 수 있으므로 운영 DB 관리 권한은 별도 통제가 필요하다. 이 구현은 Phase 1 시범 개발 기반이며 정식 GMP 시스템 검증을 의미하지 않는다.
