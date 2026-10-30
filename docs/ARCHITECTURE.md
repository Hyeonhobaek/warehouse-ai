# Phase 1·2·3 아키텍처

단일 Nuxt 4 프로젝트 안에 Vue 화면과 Nitro Server API를 함께 둔다.

```text
Browser / Nuxt SSR
  └─ 같은 출처의 /api/auth/*, /api/materials, /api/lots, /api/batches,
       /api/warehouses, /api/locations, /api/inventory, /api/transactions/*,
       /api/boms, /api/production/*
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

Viewer/Operator/Admin은 조회할 수 있고 Admin만 기준정보를 변경한다. Operator와 Admin은 입고·불출·반납 RPC를 실행하며 반납 보류 해제는 Admin만 가능하다. 입고 RPC 안에서 신규 제조 LOT도 함께 생성할 수 있다. 화면 버튼 제한과 별도로 Server API 및 DB RLS가 권한을 검증한다. 변경 요청은 JSON 및 같은 Origin을 요구하고 보호 페이지/API는 `private, no-store`를 사용한다. Supabase 클라이언트는 요청 단위로 재사용하여 인증 중 갱신한 세션이 DB 조회에도 적용되게 한다.

원료코드는 업무 식별키이며 이름·약어는 검색용이다. 제조 LOT 아래에 실제 입고건을 두고 시험·재시험 이력은 같은 입고건에 연결한다. 재고 조회 뷰가 품질·기한·예약·사용상태를 반영해 수량을 계산한다. 화면 검색·필터·페이지는 URL query에 저장한다.

신규 입고건 메타데이터는 수량을 만들지 않고 가상 seed가 테스트 잔고를 준비한다. 대시보드 통계는 Phase 4 범위다. 원료/상세재고 CSV는 필터를 적용해 최대 10,000건을 내려받는다. Excel/XLSM/CSV 가져오기는 포함하지 않는다.

재고 변경은 서버 입력 검증 후 하나의 PostgreSQL RPC로 실행한다. RPC는 역할을 다시 검사하고 요청키 잠금, 원료·재고·품질·위치 잠금, NUMERIC 환산, 재고 갱신, 거래 헤더와 분할 내역 저장을 하나의 트랜잭션에서 처리한다. 실패하면 모든 변경을 취소한다. 같은 요청키와 내용의 재시도는 기존 결과를 반환하며 내용이 달라지면 거부한다. 미리보기는 참고용이고 저장 시 FIFO를 다시 계산한다.

반납은 원래 불출 상세행을 참조하여 수량을 제한하고, 현재고와 별도 held 수량을 함께 늘린다. 관리자 승인은 held만 줄이며 원입고건의 QC·기한·활성 상태를 다시 검사한다. 원장의 시험번호·LOT·위치·전후 잔량은 거래 당시 값으로 보존한다. 기존 엑셀 잔량은 배치별 현재고로 표시하고 Phase 3 도입 이전의 거래를 추정하지 않는다.

세척은 `issue_purpose=CLEANING`으로 구분한다. 미리보기와 실제 차감이 같은 SQL 배정 함수를 사용하며, 입고건별로 선택 창고 안의 가용량을 합쳐 18L 단위 배정 가능량을 계산한다. 제조 LOT가 같아도 입고건은 합치지 않는다. 입력 18L를 기본단위로 환산한 값의 배수로 차감하며 원래 입력량·밀도를 보존한다.

BOM과 생산일정은 웹에서 관리한다. BOM은 Admin, 일정 변경과 계획 출고 확정은 Operator/Admin이 처리한다. 계획 생성·변경은 재고를 예약하지 않으며 일정별 미출고 계획만 재계산한다. BOM 편집 후 기존 일정은 다시 저장할 때 최신 BOM을 반영한다. 일정과 계획의 revision으로 오래된 화면에서의 변경을 거부하고, 일정 행 잠금으로 일정 변경과 출고 확정을 직렬화한다. 계획 출고 RPC는 재고 RPC와 같은 트랜잭션 안에서 차감·원장 생성·계획 완료를 저장한다. 출고 완료 계획과 원장은 변경할 수 없다. 수기 불출은 일정 재계산과 독립적이다.
