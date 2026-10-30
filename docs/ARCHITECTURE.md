# Phase 1·2 아키텍처

단일 Nuxt 4 프로젝트 안에 Vue 화면과 Nitro Server API를 함께 둔다.

```text
Browser / Nuxt SSR
  └─ 같은 출처의 /api/auth/*, /api/materials, /api/lots, /api/batches,
       /api/warehouses, /api/locations, /api/inventory
      └─ Nuxt Server API: Zod 입력 검증, 세션 검증, 권한 검증
          └─ 요청별 Supabase 서버 클라이언트
              ├─ Supabase Auth: 이메일/비밀번호와 세션 갱신
              └─ PostgreSQL: profiles + 업무 테이블/RLS + 재고 조회 뷰
```

Supabase URL과 Publishable Key는 Nuxt의 서버 runtimeConfig에서 읽는다. 브라우저는 Nuxt API만 호출하며 Supabase 비밀 관리자 키를 사용하지 않는다. 서버도 사용자 세션 토큰으로 DB를 호출하므로 RLS가 적용된다. Cloud 프로젝트 ID와 접속 주소를 소스 코드에 고정하지 않는다.

Auth 쿠키는 HttpOnly와 SameSite 정책을 사용한다. 서버는 `getUser()`로 Auth 사용자 신원을 검증한 후, DB에서 활성 프로필과 현재 역할을 읽는다. 쿠키에 담긴 임의 사용자 정보나 수정 가능한 Auth metadata로 권한을 판단하지 않는다. 세션이 없거나 비활성 계정이면 보호 API 접근을 거부한다. 로그인·로그아웃 POST에는 같은 출처 검사, 인증 응답에는 캐시 방지를 적용한다.

| 디렉터리 | 책임 |
| --- | --- |
| `app/` | 로그인, 공통 레이아웃, 원료·LOT·입고건·재고·창고 화면, 라우트 가드 |
| `server/` | 인증·업무 API, 입력/권한 검증, CSV 다운로드, Supabase 서버 연결 |
| `shared/` | Zod 스키마, 역할·권한 정의, API 타입 |
| `supabase/migrations/` | DB 스키마·RLS·트리거 변경 이력 |
| `tests/` | 입력·권한 검증과 DB 정책 테스트 |

Viewer/Operator/Admin은 조회할 수 있고 Admin만 기준정보를 변경한다. 화면 버튼 제한과 별도로 Server API 및 DB RLS가 권한을 검증한다. 변경 요청은 JSON 및 같은 Origin을 요구하고 보호 페이지/API는 `private, no-store`를 사용한다. Supabase 클라이언트는 요청 단위로 재사용하여 인증 중 갱신한 세션이 DB 조회에도 적용되게 한다.

원료코드는 업무 식별키이며 이름·약어는 검색용이다. 제조 LOT 아래에 실제 입고건을 두고 시험·재시험 이력은 같은 입고건에 연결한다. 재고 조회 뷰가 품질·기한·예약·사용상태를 반영해 수량을 계산한다. 화면 검색·필터·페이지는 URL query에 저장한다.

신규 입고건 메타데이터는 수량을 만들지 않고 가상 seed가 테스트 잔고를 준비한다. 대시보드 통계는 Phase 4 범위다. 원료/상세재고 CSV는 필터를 적용해 최대 10,000건을 내려받는다. Excel/XLSM/CSV 가져오기는 포함하지 않는다.

재고 변경은 Phase 3에서 서버 입력 검증 후 PostgreSQL RPC로 구현한다. 수량 검증, 행 잠금, 잔량 변경, 거래 이력 기록을 하나의 DB 트랜잭션에 포함해야 한다. Phase 1에는 재고 수정 경로나 임시 메모리 DB를 만들지 않는다.
