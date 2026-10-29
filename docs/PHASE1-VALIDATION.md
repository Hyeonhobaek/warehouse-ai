# Phase 1 구현 및 검증 기록

검증일: 2026-10-29 (Asia/Seoul)

## 구현 범위

기준 기획서는 저장소의 `PRO.md`입니다. Nuxt 4 / TypeScript 단일 프로젝트, Nuxt UI / Tailwind, Supabase 인증 연결, 로그인·로그아웃, 공통 관리자 레이아웃, 기본 대시보드, 역할·RLS 기반 권한 구조를 구현했습니다.

원료·LOT·창고·재고 CRUD와 재고 변경 RPC, 거래 처리, 실제 통계, AI 기능은 후속 Phase의 범위로 남겼습니다. 숫자 카드에는 `—`를 표시하고 준비 중 메뉴는 비활성화했습니다.

## 자동 검증

| 명령 | 결과 | 확인 내용 |
|---|---|---|
| `pnpm typecheck` | 통과 | 앱·서버·공유 TypeScript 타입 |
| `pnpm test` | 22개 통과 | Zod·역할 권한 7개, PostgreSQL migration·RLS 15개 |
| `pnpm build` | 통과 | Nuxt production client/server 및 Nitro Node 빌드 |
| `pnpm test:integration` | 7개 통과 | 빌드 서버 HTTP 인증·페이지·쿠키·오류 흐름 |

HTTP 테스트는 비인증 페이지 리다이렉트/API 거부, 잘못된 로그인·JSON·역할 주입 거부, 교차 출처 요청 거부, 역할별 로그인, 비활성 사용자 차단, SSR 세션 유지·토큰 갱신 쿠키 전달, 로그아웃과 외부 인증 장애 처리를 포함합니다.

SSR 테스트에서 Nitro의 요청별 fetch 함수가 `.raw()`를 제공하지 않는 문제를 발견했습니다. 전역 `$fetch.raw`와 명시적 서버 Cookie 전달을 사용하도록 수정했고, 갱신된 쿠키는 SSR 응답과 같은 요청의 후속 API에 반영합니다. 토큰은 hydration payload에 저장하지 않습니다.

## 브라우저 확인

테스트 전용 가상 인증 서비스에 연결한 빌드를 브라우저로 실행했습니다.

- 가상 Viewer 계정의 폼 로그인 → 대시보드 진입
- 사용자명·역할 및 연결 상태 표시
- 브라우저 새로고침 후 인증 유지
- 대시보드 새로고침 버튼 작동
- PC 1440px / 태블릿 820px 레이아웃과 사이드바 열기·닫기
- 로그아웃 후 로그인 화면 복귀
- 브라우저 console error / warning 없음

## 검증의 한계와 남은 설정

- DB 테스트는 실제 migration을 PGlite PostgreSQL 엔진에 실행했습니다. Supabase Cloud 또는 Docker Supabase 전체 서비스 배포 검증은 아닙니다.
- HTTP와 브라우저 검증은 `tests/fixtures/supabase.mjs`의 가상 서비스로 실행했습니다. 실제 Cloud 계정 로그인 및 Cloud migration 적용 결과는 검증하지 않았습니다.
- Cloud Project URL / Publishable Key를 `.env`에 설정하고 migration을 적용한 뒤 가상 Auth 계정을 생성하여 실제 환경에서 확인해야 합니다.
- 초기 관리자 권한은 README에 설명된 사유 포함 SQL 트랜잭션으로 지정합니다.
- 실제 재고 기능이 추가될 때에는 PostgreSQL 트랜잭션·동시성·거래 감사 테스트를 추가해야 합니다.
