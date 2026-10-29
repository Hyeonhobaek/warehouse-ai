# Phase 1 데이터베이스

원본 기획서는 루트의 `PRO.md`이다. Phase 1은 사용자 인증·권한 기반만 생성한다. 원료, LOT, 창고, 재고, 입출고 테이블과 재고 변경 RPC는 아직 없다.

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
