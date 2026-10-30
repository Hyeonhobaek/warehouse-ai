# Warehouse AI — Phase 3

제약회사 원료·자재 재고관리 시스템입니다. **현재 구현 범위는 Phase 1~3**이며, Nuxt 4 한 프로젝트에서 화면과 Server API를 실행합니다.

> 원본 기획서는 [`PRO.md`](./PRO.md)입니다. Phase 2에는 참고 엑셀에서 확인한 원료 별칭, 제조 LOT와 입고건·시험번호 구분을 반영했습니다. 원본 엑셀과 실제 회사 데이터는 저장소·seed에 포함하지 않습니다.

## 구현 범위

- Nuxt 4 + TypeScript, Nuxt UI 4 + Tailwind CSS 4
- Supabase Auth 이메일/비밀번호 로그인, 로그아웃, 새로고침 시 세션 유지
- 로그인 사용자만 접근 가능한 대시보드와 Server API
- 공통 사이드바·상단 메뉴·로그인 사용자 및 역할 표시
- Viewer / Operator / Admin 권한 정의, 서버 검증, PostgreSQL RLS
- 사용자 프로필 자동 생성 및 권한·활성 상태 변경 감사 기록
- 환경변수, SQL migration, 자동 테스트, Cloud → Self-hosted 이전 문서
- 원료 등록·검색·수정, 미참조 원료 삭제 및 사용 중지, 별칭·포장규격·밀도 관리
- 원료별 제조 LOT, 실제 입고건의 시험번호·기한·품질정보 및 변경 이력
- 창고·보관위치 등록·수정·사용상태 관리
- 원료 합계와 LOT·입고건·위치별 재고 조회, 검색·필터·페이지네이션
- 현재고·예약·가용·사용불가 구분, 부족·재시험·기한 임박 표시, 원료/상세재고 CSV 다운로드
- 실제 입고 등록과 시험대기 재고 생성, 입력단위·밀도를 반영한 기본단위 환산
- 창고 선택 또는 전체 창고의 실제 입고일 기준 FIFO 불출, 여러 입고건 자동 분할 차감
- 세척 18L 단위 FIFO, 입고건별 18L 미만 잔량 보존 및 입력 L·환산 재고량 표시
- 웹 BOM·생산일정 등록, 일정 변경 시 미출고 예정만 재계산, 예정 출고 확정
- 불출 내역에 연결된 반납·보류 재고 및 관리자 반납 승인
- 시험번호별 날짜순 원장, 거래 당시 시험번호·입력단위·전후 잔량·담당자·사유 보존
- 재고 RPC의 잠금·전체 취소·중복 재시도 방지 및 수정할 수 없는 거래 이력
- 재실행 시 기존 데이터를 덮어쓰지 않는 가상 업무 seed

입고·FIFO 불출·반납·반납 승인과 시험번호별 원장을 제공합니다. 원료 상세의 입고건 기초정보 등록은 수량을 증가시키지 않으며, 실제 수량은 **입고 관리**에서 등록합니다. 대시보드 통계·알림·AI 분석은 **Phase 4**입니다. 원본 Excel/XLSM 자동 가져오기와 원료 CSV 업로드는 이번 범위에 포함하지 않습니다. 재시험 이월·계획 행·단위 혼용에 대한 변환·대사 규칙을 정한 후 별도 구현합니다.

## 1. 개발 환경

- Node.js **24 LTS, 24.15 이상** (Phase 2 검증 버전: 24.15.0)
- pnpm **11.25.0** (`packageManager`에 고정)
- Supabase Cloud 테스트 프로젝트
- Windows PowerShell 또는 일반 터미널

pnpm이 없다면 신뢰할 수 있는 Node 설치 환경에서 `npm install -g pnpm@11.25.0`으로 설치합니다. NVM이 패키지 관리자의 신뢰 검증 오류를 표시하면 기존 설치를 복구한 뒤 실행하세요.

```powershell
git clone https://github.com/Hyeonhobaek/warehouse-ai.git
cd warehouse-ai
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

이미 저장소가 있다면 해당 폴더에서 설치부터 진행합니다. `.env`는 Git에서 제외되어 있습니다.

## 2. Supabase Cloud 설정

1. **가상 데이터 전용** Supabase 프로젝트를 생성합니다.
2. 프로젝트의 Connect/API 설정에서 Project URL과 Publishable Key를 확인합니다. 기존 프로젝트의 `anon` 키도 지원합니다. `secret` / `service_role` 키는 앱에 사용하지 않습니다.
3. `.env`를 편집합니다.

```dotenv
NUXT_SUPABASE_URL=https://your-project.supabase.co
NUXT_SUPABASE_PUBLISHABLE_KEY=your-publishable-key-or-legacy-anon-key
```

환경변수는 Nuxt **서버 전용** runtime config로 읽습니다. 브라우저에 키나 토큰을 전달하지 않으며, 브라우저는 같은 출처의 `/api/*`만 호출합니다. 변경 후 개발 서버를 다시 시작하세요.

### Migration 적용

Supabase CLI로 새 테스트 프로젝트에 연결한 뒤 적용합니다. 연결 대상 프로젝트를 확인한 후 `db push`를 실행하세요.

```powershell
pnpm dlx supabase login
pnpm dlx supabase link --project-ref YOUR_PROJECT_REF
pnpm dlx supabase db push
```

순서대로 적용할 파일은 다음과 같습니다.

1. `supabase/migrations/20261029000100_identity_foundation.sql`: 인증·프로필·역할 감사 기반
2. `supabase/migrations/20261030000100_inventory_foundation.sql`: 원료·LOT·입고건·품질 이력·창고·위치·재고 및 RLS/조회 뷰
3. `supabase/migrations/20261030000200_stock_transactions.sql`: 입출고·반납·승인 RPC, 보류 수량, 거래 원장과 권한
4. `supabase/migrations/20261030000300_cleaning_fifo.sql`: 세척 18L 단위 배정, 용도와 입력량·환산량 표시
5. `supabase/migrations/20261030000400_bom_planning.sql`: BOM·생산일정·예정 불출, 변경 이력과 출고 확정

Phase 2까지 적용한 DB에는 3→4→5번을 순서대로 추가합니다. 3번을 이미 적용했다면 4→5번만 추가합니다. 기존 재고 수량은 유지되며, 도입 전 엑셀 거래 내역을 소급 생성하지 않습니다. 한 migration 파일 전체를 한 번에 실행하세요. 화면 코드와 함께 적용해야 새 API를 사용할 수 있습니다. CLI를 사용하지 않는 테스트 프로젝트에서는 Supabase SQL Editor에서 아직 적용하지 않은 파일의 SQL을 실행할 수 있습니다. 이 경우 추후 CLI 전환 시 migration 이력을 맞춰야 합니다.

그다음 **가상 데이터 전용 프로젝트**의 SQL Editor에서 `supabase/seed.sql`을 실행합니다. `db push`는 seed를 자동 실행하지 않습니다. seed는 원료 6개, LOT 6개, 입고건 8개와 창고·위치·재고를 추가하며, Auth 사용자나 비밀번호를 만들지 않습니다. 재실행해도 기존 행과 수량을 덮어쓰지 않습니다. 상대 날짜는 최초 실행일을 기준으로 생성됩니다.

### 테스트 사용자 생성

Supabase Dashboard → Authentication → Users에서 테스트 이메일/비밀번호 사용자를 생성하고 이메일 확인을 완료합니다. 앱에는 회원가입이나 사용자 관리 화면이 없습니다. 사내 초대형 운영을 위해 프로젝트의 공개 신규 가입을 끄고 관리자가 계정을 발급하는 구성을 권장합니다.

예시 이메일은 `viewer@example.test`, `operator@example.test`, `admin@example.test`입니다. 비밀번호는 직접 정하고 저장소에 기록하지 마세요. 생성된 사용자의 기본 역할은 항상 Viewer입니다. 사용자 metadata의 `role`은 권한 근거로 사용하지 않습니다.

관리자·운영자 지정은 신뢰할 수 있는 Supabase SQL Editor에서 다음처럼 처리합니다. 이는 초기 설정이며 앱의 클라이언트 권한으로 실행할 수 없습니다.

```sql
begin;
set local app.audit_reason = 'Phase 1 가상 테스트 관리자 지정';
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'admin@example.test');
commit;
```

운영자는 `'operator'`를 지정합니다. `role` 또는 `is_active` 변경에는 사유가 필요하며 전후 값과 처리 시점이 감사 테이블에 남습니다. 상세 내용은 [DB 문서](./docs/DATABASE.md)를 참고하세요.

## 3. 실행

```powershell
pnpm dev
```

터미널에 표시되는 주소(기본 [http://127.0.0.1:3000](http://127.0.0.1:3000))에 접속합니다.

1. `/` 접근 시 로그인 화면으로 이동합니다.
2. Supabase에 생성한 테스트 계정으로 로그인합니다.
3. `/materials`에서 원료를 검색하고 상세 화면에서 LOT·입고건·품질 이력을 확인합니다. Admin은 등록·수정할 수 있습니다.
4. `/inventory`에서 원료 합계/상세재고, 품질·창고·위치·재시험·부족 필터와 CSV 다운로드를 확인합니다.
5. `/warehouses`에서 창고와 보관위치를 확인합니다. Admin은 등록·수정·사용 중지할 수 있습니다.
6. Operator 또는 Admin으로 `/receipts`에서 원료·제조 LOT·보관위치·수량을 입력합니다. 신규 입고는 시험대기이며, Admin이 원료 상세에서 적합 판정과 유효기간을 확인해야 불출할 수 있습니다.
7. `/issues`에서 원료·수량을 입력하고 FIFO 배분 미리보기를 확인한 후 불출합니다. 저장 시 실제 가용재고를 다시 확인합니다.
8. `/returns`에서 원래 불출 내역을 찾아 기본단위로 반납합니다. 반납분은 보류되며 Admin이 같은 화면에서 확인·승인합니다.
9. `/transactions`에서 원료 및 시험번호별 입고건을 골라 날짜순 거래와 잔량을 확인합니다. 이전 시험번호로도 입고건을 검색할 수 있습니다.
10. 검색 후 새로고침·뒤로 가기로 URL 필터 상태와 세션 유지를 확인하고 로그아웃 후 보호 페이지 접근이 차단되는지 확인합니다.

Supabase 환경변수 없이도 개발 서버와 로그인 화면을 열 수 있습니다. 설정 안내가 표시되고 로그인은 비활성화됩니다. **인증을 우회하는 데모 로그인은 없습니다.**

### 빌드 및 배포 실행

```powershell
pnpm build
pnpm preview
```

실제 배포에서는 환경변수를 서버에 설정하고 `node .output/server/index.mjs`로 실행합니다. 이 명령은 `.env`를 자동으로 읽지 않으므로 배포 환경에서 직접 주입해야 합니다. 운영은 HTTPS가 필요하며 세션 쿠키는 `HttpOnly`, `SameSite=Lax`, 운영 빌드에서 `Secure`입니다. 로컬 HTTP 화면 확인에는 `pnpm dev`를 사용하세요.

리버스 프록시를 사용한다면 신뢰 가능한 프록시에서만 원래 Host·HTTPS 프로토콜을 전달하고, 외부에서 임의의 전달 헤더를 주입하지 못하게 구성하세요. 쿠키를 사용하는 페이지/API를 CDN·프록시에 캐시하지 마세요. POST/PATCH/DELETE API는 같은 Origin을 요구합니다.

## 4. 테스트

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
```

Docker에 `postgres:17-alpine` 이미지가 준비되어 있으면 독립 PostgreSQL 연결 간 경합도 검증할 수 있습니다.

```powershell
node --test tests/integration-postgres/transactions.test.mjs
```

이 검증은 포트를 공개하지 않는 전용 임시 컨테이너를 생성하고 종료 시 제거합니다. 기존 컨테이너·DB는 변경하지 않습니다.

- **단위 테스트:** Zod 날짜·수량·식별자·필터 검증, CSV 처리, 역할별 권한 경계
- **DB 테스트:** PGlite PostgreSQL에 실제 migration/seed 적용, RLS·관리자 변경 범위·재고 직접 수정 차단·품질 이력·재고 집계·seed 재실행 검증
- **HTTP 통합 테스트:** 빌드된 Nuxt 서버와 Supabase JS/SSR 클라이언트로 로그인·세션 갱신·CRUD·재고 필터·품질 이력·CSV·CSRF·SSR을 확인
- **거래 검증:** 실제 migration으로 FIFO 분할·부족 시 전체 취소·반납 보류/부분 승인·중복 요청 방지·시험번호 변경 이력·단위 환산을 검증하고, 실제 PostgreSQL에서는 동시 불출·반납·동일 요청 및 QC 변경 경합을 확인

통합 테스트는 `tests/fixtures/supabase.mjs`의 Auth 서비스 모형과 `tests/fixtures/inventory.mjs`의 **실제 migration을 실행하는 PGlite 기반 PostgREST 모형**을 사용합니다. 실제 Nuxt API와 Supabase JS/SSR 클라이언트는 그대로 실행하며, 운영 코드에는 테스트 우회 분기가 없습니다. 실제 Supabase Cloud의 Auth/PostgREST 접속 검증을 대신하지 않으므로 프로젝트 설정 후 위 수동 시나리오도 수행하세요. 모든 테스트 데이터는 가상입니다.

선택적으로 Docker와 Supabase CLI가 있다면 `pnpm dlx supabase start`, `pnpm dlx supabase db reset`으로 로컬 Supabase에 migration과 가상 seed를 적용할 수 있습니다. `db reset`은 **로컬 개발 DB를 초기화**하므로 필요한 데이터를 먼저 보존하세요. `supabase status`에서 받은 로컬 URL/anon 키를 `.env`에 설정합니다. 테스트용 Auth 사용자는 별도로 생성합니다.

## 5. 주요 파일

```text
app/
  assets/css/main.css     Tailwind / Nuxt UI 및 공통 스타일
  components/            사이드바·로고 등 공통 UI
  composables/           인증 상태와 API 호출
  layouts/               공통 관리자 레이아웃
  middleware/            페이지 인증 가드
  pages/                 로그인·대시보드·원료/LOT·재고·창고 화면
server/
  api/auth/              session, login, logout
  api/                   원료·LOT·입고건·창고·재고 및 CSV API
  services/auth.ts       사용자·활성 프로필·권한 검증
  utils/                 Supabase 서버 클라이언트·쿠키·Origin 검증
shared/
  schemas/               Zod 로그인·업무 입력·검색 조건 검증
  types/                 인증·DB·대시보드 타입
  utils/permissions.ts   역할별 권한 정의
supabase/
  migrations/            DB 스키마·RLS·함수·트리거
  config.toml            선택적 로컬 Supabase 설정
  seed.sql               Phase 2 가상 원료·입고건·위치별 재고
tests/                   단위·DB·HTTP 통합 테스트
docs/                    구조·DB·Self-hosted 이전 안내
.env.example             서버 환경변수 예시
nuxt.config.ts           Nuxt/UI/runtime 설정
pnpm-lock.yaml           재현 가능한 의존성 버전
```

## 6. BOM·생산일정 사용 순서

1. Admin으로 **BOM 관리 → BOM 등록**에서 제품명과 기준 생산 1회분의 원료·소요량·단위·용도를 입력합니다. 세척용은 L와 18L 배수로 등록하고 질량 원료에는 밀도를 먼저 등록합니다.
2. Operator 또는 Admin으로 **생산일정 → 생산일정 등록**에서 BOM, 예정일, 생산 배수, 제조 배치를 입력합니다. 소요량 × 배수의 예정 불출이 생성됩니다. 이 단계에서는 재고가 차감되지 않습니다.
3. 일정이나 생산량이 바뀌면 해당 일정을 수정합니다. 미출고 예정만 새 날짜·수량으로 변경되고, 이미 출고한 내역은 유지됩니다. BOM 자체를 수정한 경우도 해당 일정을 다시 저장하면 최신 배합이 반영됩니다.
4. 예정 불출의 **실제 불출**에서 FIFO 미리보기를 확인하고 저장하면 실제 재고가 차감됩니다. 세척은 예를 들어 25L·100L에서 36L를 출고할 때 18L씩 사용하고 앞의 7L를 남깁니다.
5. 별도 추가 출고는 **불출 관리**에서 수기로 등록합니다. 일정 수정·취소가 이 수기 내역을 덮어쓰지 않습니다.

Viewer는 조회만 가능합니다. 월 재고조사 화면과 차이 수량의 재고조정은 처리 정책 확인 후 추가할 항목입니다.

## 7. 다음 단계 준비

- Supabase Cloud 연결, migration 적용, 가상 계정별 로그인 확인
- 초기 Admin 계정 및 계정 발급·비활성화 담당자 결정
- 원료코드·약어, 입고건과 시험번호, 기본단위 및 환산 기준을 실제 운영 규칙과 대조
- 월 재고조사의 기록·승인·재고조정 처리 정책 확정
- Phase 4 대시보드 통계·알림·규칙 기반 분석 구현
- 실제 업무 적용 전 별도 검증·승인, 백업/복구 및 운영 정책 수립

이 프로젝트는 PRD상 시범 개발 단계이며, 승인된 GMP 운영 시스템이 아닙니다.

관련 문서: [Phase 3 검증 기록](./docs/PHASE3-VALIDATION.md) · [Phase 2 검증 기록](./docs/PHASE2-VALIDATION.md) · [아키텍처](./docs/ARCHITECTURE.md) · [데이터베이스](./docs/DATABASE.md) · [Self-hosted 이전](./docs/MIGRATION.md).

구현 참고: [Nuxt UI 공식 설치 안내](https://nuxt.com/modules/ui), [Supabase 서버 클라이언트](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Supabase SSR 세션·캐시 안내](https://supabase.com/docs/guides/auth/server-side/advanced-guide).
