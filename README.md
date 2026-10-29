# Warehouse AI — Phase 1

제약회사 원료·자재 재고관리 시스템의 기반 프로젝트입니다. **현재 구현 범위는 Phase 1**이며, Nuxt 4 한 프로젝트에서 화면과 Server API를 실행합니다.

> 저장소의 기획서 파일명은 `PRD.md`가 아니라 [`PRO.md`](./PRO.md)입니다. 해당 파일의 10장 Phase 1을 기준으로 구현했습니다. 원본 기획서는 변경하지 않았습니다.

## 구현 범위

- Nuxt 4 + TypeScript, Nuxt UI 4 + Tailwind CSS 4
- Supabase Auth 이메일/비밀번호 로그인, 로그아웃, 새로고침 시 세션 유지
- 로그인 사용자만 접근 가능한 대시보드와 Server API
- 공통 사이드바·상단 메뉴·로그인 사용자 및 역할 표시
- Viewer / Operator / Admin 권한 정의, 서버 검증, PostgreSQL RLS
- 사용자 프로필 자동 생성 및 권한·활성 상태 변경 감사 기록
- 환경변수, SQL migration, 자동 테스트, Cloud → Self-hosted 이전 문서

원료 CRUD, LOT·창고·재고 조회, 입고·불출·반납, 재고 RPC, 통계 및 AI 분석은 **구현하지 않았습니다**. 관련 메뉴는 `준비 중`, 대시보드 수치는 `—`로 표시됩니다. Phase 1에는 재고를 변경하는 코드가 없습니다. 향후 재고 변경은 PostgreSQL RPC 트랜잭션에서 검증·잠금·이력 기록을 함께 처리해야 합니다.

## 1. 개발 환경

- Node.js **24 LTS, 24.15 이상** (검증 버전: 24.22.1)
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

적용 파일은 `supabase/migrations/20261029000100_identity_foundation.sql`입니다. `profiles`, `profile_role_audit`, 프로필 생성·감사 트리거, RLS 정책 및 권한을 만듭니다. 기존 Auth 사용자도 Viewer로 안전하게 연결합니다. 업무 재고 테이블은 만들지 않습니다.

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
3. 대시보드에서 사용자명·역할, 기본 현황 카드와 준비 중 메뉴를 확인합니다.
4. 브라우저를 새로고침해 세션 유지를 확인합니다.
5. 상단 로그아웃을 누른 후 `/` 재접근이 차단되는지 확인합니다.

Supabase 환경변수 없이도 개발 서버와 로그인 화면을 열 수 있습니다. 설정 안내가 표시되고 로그인은 비활성화됩니다. **인증을 우회하는 데모 로그인은 없습니다.**

### 빌드 및 배포 실행

```powershell
pnpm build
pnpm preview
```

실제 배포에서는 환경변수를 서버에 설정하고 `node .output/server/index.mjs`로 실행합니다. 이 명령은 `.env`를 자동으로 읽지 않으므로 배포 환경에서 직접 주입해야 합니다. 운영은 HTTPS가 필요하며 세션 쿠키는 `HttpOnly`, `SameSite=Lax`, 운영 빌드에서 `Secure`입니다. 로컬 HTTP 화면 확인에는 `pnpm dev`를 사용하세요.

리버스 프록시를 사용한다면 신뢰 가능한 프록시에서만 원래 Host·HTTPS 프로토콜을 전달하고, 외부에서 임의의 전달 헤더를 주입하지 못하게 구성하세요. 쿠키를 사용하는 페이지/API를 CDN·프록시에 캐시하지 마세요. POST API는 같은 Origin을 요구합니다.

## 4. 테스트

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
```

- **단위 테스트:** Zod 입력 검증, 역할별 권한 경계
- **DB 테스트:** PGlite PostgreSQL 엔진에 실제 migration 적용, 익명 접근 차단, 본인/관리자 조회 범위, 권한 상승 차단, 비활성 계정, 변경 감사 기록
- **HTTP 통합 테스트:** 빌드된 Nuxt 서버를 실행해 로그인·대시보드·SSR 새로고침·토큰 갱신·로그아웃·CSRF·외부 인증 장애를 확인

통합 테스트는 `tests/fixtures/supabase.mjs`의 **테스트 전용 외부 서비스 모형**을 사용합니다. 실제 Nuxt API와 Supabase JS/SSR 클라이언트는 그대로 실행하며, 운영 코드에 테스트 우회 분기를 넣지 않았습니다. 이 검증은 실제 Supabase Cloud 접속 테스트를 대신하지 않으므로, 프로젝트 설정 후 위 수동 시나리오도 수행하세요. 테스트에는 실회사 정보가 없습니다.

선택적으로 Docker와 Supabase CLI가 있다면 `pnpm dlx supabase start`, `pnpm dlx supabase db reset`으로 로컬 Supabase에도 migration을 적용할 수 있습니다. `db reset`은 **로컬 개발 DB를 초기화**하므로 필요한 데이터를 먼저 보존하세요. `supabase status`에서 받은 로컬 URL/anon 키를 `.env`에 설정합니다. `seed.sql`은 의도적으로 사용자나 업무 데이터를 삽입하지 않습니다.

## 5. 주요 파일

```text
app/
  assets/css/main.css     Tailwind / Nuxt UI 및 공통 스타일
  components/            사이드바·로고 등 공통 UI
  composables/           인증 상태와 API 호출
  layouts/               공통 관리자 레이아웃
  middleware/            페이지 인증 가드
  pages/                 로그인·기본 대시보드
server/
  api/auth/              session, login, logout
  api/dashboard.get.ts   인증을 요구하는 Phase 1 기본 응답
  services/auth.ts       사용자·활성 프로필·권한 검증
  utils/                 Supabase 서버 클라이언트·쿠키·Origin 검증
shared/
  schemas/auth.ts        Zod 로그인 검증
  types/                 인증·DB·대시보드 타입
  utils/permissions.ts   역할별 권한 정의
supabase/
  migrations/            DB 스키마·RLS·함수·트리거
  config.toml            선택적 로컬 Supabase 설정
  seed.sql               Phase 1 가상 데이터 정책 안내
tests/                   단위·DB·HTTP 통합 테스트
docs/                    구조·DB·Self-hosted 이전 안내
.env.example             서버 환경변수 예시
nuxt.config.ts           Nuxt/UI/runtime 설정
pnpm-lock.yaml           재현 가능한 의존성 버전
```

## 6. 다음 단계 준비

- Supabase Cloud 연결, migration 적용, 가상 계정별 로그인 확인
- 초기 Admin 계정 및 계정 발급·비활성화 담당자 결정
- Phase 2에서 원료·LOT·창고 스키마와 RLS를 새 migration으로 추가
- Phase 3에서 PostgreSQL RPC·행 잠금·원자적 재고 변경·거래 이력 구현
- 실제 업무 적용 전 별도 검증·승인, 백업/복구 및 운영 정책 수립

이 프로젝트는 PRD상 시범 개발 단계이며, 승인된 GMP 운영 시스템이 아닙니다.

관련 문서: [아키텍처](./docs/ARCHITECTURE.md) · [데이터베이스](./docs/DATABASE.md) · [Self-hosted 이전](./docs/MIGRATION.md).

구현 참고: [Nuxt UI 공식 설치 안내](https://nuxt.com/modules/ui), [Supabase 서버 클라이언트](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Supabase SSR 세션·캐시 안내](https://supabase.com/docs/guides/auth/server-side/advanced-guide).
