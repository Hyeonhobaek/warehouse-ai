# Phase 1 아키텍처

단일 Nuxt 4 프로젝트 안에 Vue 화면과 Nitro Server API를 함께 둔다.

```text
Browser / Nuxt SSR
  └─ 같은 출처의 /api/auth/*, /api/dashboard
      └─ Nuxt Server API: Zod 입력 검증, 세션 검증, 권한 검증
          └─ 요청별 Supabase 서버 클라이언트
              ├─ Supabase Auth: 이메일/비밀번호와 세션 갱신
              └─ PostgreSQL: profiles + RLS
```

Supabase URL과 Publishable Key는 Nuxt의 서버 runtimeConfig에서 읽는다. 브라우저는 Nuxt API만 호출하며 Supabase 비밀 관리자 키를 사용하지 않는다. 서버도 사용자 세션 토큰으로 DB를 호출하므로 RLS가 적용된다. Cloud 프로젝트 ID와 접속 주소를 소스 코드에 고정하지 않는다.

Auth 쿠키는 HttpOnly와 SameSite 정책을 사용한다. 서버는 `getUser()`로 Auth 사용자 신원을 검증한 후, DB에서 활성 프로필과 현재 역할을 읽는다. 쿠키에 담긴 임의 사용자 정보나 수정 가능한 Auth metadata로 권한을 판단하지 않는다. 세션이 없거나 비활성 계정이면 보호 API 접근을 거부한다. 로그인·로그아웃 POST에는 같은 출처 검사, 인증 응답에는 캐시 방지를 적용한다.

| 디렉터리 | 책임 |
| --- | --- |
| `app/` | 로그인, 공통 레이아웃, 기본 대시보드, 라우트 가드 |
| `server/` | Auth API, 보호된 대시보드 API, Supabase 서버 연결 |
| `shared/` | Zod 스키마, 역할·권한 정의, API 타입 |
| `supabase/migrations/` | DB 스키마·RLS·트리거 변경 이력 |
| `tests/` | 입력·권한 검증과 DB 정책 테스트 |

Viewer/Operator/Admin의 업무 권한 정의는 향후 기능의 공통 기반이다. Phase 1에서 실제 제공하는 업무 화면은 대시보드뿐이며, 원료·재고·입출고·분석·사용자 관리 기능은 아직 제공하지 않는다. 대시보드 수치는 미연결 상태로 표시하고 실제 집계인 것처럼 가상 수치를 보여 주지 않는다.

재고 변경은 Phase 3에서 서버 입력 검증 후 PostgreSQL RPC로 구현한다. 수량 검증, 행 잠금, 잔량 변경, 거래 이력 기록을 하나의 DB 트랜잭션에 포함해야 한다. Phase 1에는 재고 수정 경로나 임시 메모리 DB를 만들지 않는다.
