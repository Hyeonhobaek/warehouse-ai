# Supabase Cloud → Self-hosted 이전 준비

Phase 1은 표준 PostgreSQL 테이블·RLS·트리거와 Supabase Auth/JS SDK만 사용한다. Edge Functions, Cloud 프로젝트 ID, Storage, 외부 AI 서비스에 의존하지 않는다. 이 문서는 이전 설계 가이드이며 실제 이전을 수행한 기록은 아니다.

1. 호환되는 PostgreSQL과 Supabase Auth/PostgREST 버전의 Self-hosted 환경을 준비한다. DB 마이그레이션 실행용 관리 계정과 앱용 Publishable/legacy anon 키를 구분한다.
2. 원본 DB·Auth 설정을 백업하고 복구 시험을 수행한다. 새 환경의 `auth` 스키마는 Supabase가 관리한다. 애플리케이션 migration만으로 Auth 서비스 전체를 설치하지 않는다.
3. 빈 대상 앱 DB에 `supabase/migrations/`를 순서대로 적용한다. Auth 사용자 UUID를 보존하여 사용자와 프로필 관계를 유지한다. Auth 사용자가 먼저 복원되어 자동 생성된 프로필이 있다면 기존 역할·활성 상태를 덮어쓰지 않도록 데이터 복원 순서와 트리거 처리를 별도 점검한다.
4. 기존 DB 전체 복구를 사용하는 경우 이미 있는 테이블에 초기 migration을 중복 실행하지 않는다. 복구한 DB와 migration 이력을 대조한다. 프로필, 역할 변경 이력, Auth 사용자 수 및 UUID 참조 무결성을 검증한다.
5. 대상 서비스 URL/Publishable Key 또는 해당 버전의 legacy anon 키로 `NUXT_SUPABASE_URL`, `NUXT_SUPABASE_PUBLISHABLE_KEY`를 변경한다. Self-hosted 인증 키를 프론트 코드에 넣지 않는다. Auth Site URL, 허용 URL, 공개 회원가입 비활성화, 이메일 설정도 재구성한다.
6. HTTPS와 reverse proxy를 구성하고 앱을 재시작한다. Proxy는 외부 요청의 `Host`를 보존하고 `X-Forwarded-Proto: https`를 설정해야 로그인·로그아웃 API의 같은 출처 검사가 일치한다. 클라이언트가 보낸 forwarded 헤더는 proxy에서 덮어쓰고 앱 포트는 proxy 뒤에 둔다. 운영 세션 쿠키가 Secure로 전달되는지 확인한다. 서명 키를 변경했다면 기존 로그인 세션이 유지된다고 가정하지 않고 재로그인을 안내한다.
7. Viewer/Operator/Admin 가상 계정으로 로그인, 새로고침, 로그아웃, 미인증 접근, 비활성 계정 차단, 직접 DB 권한 상승 차단을 확인한다. 백업·복구, 보안 업데이트, 모니터링 운영 절차를 정한다.

향후 원료·LOT·재고·Storage 기능이 생기면 이 문서에 파일 이전, 단위/수량 대사, 재고 변동 이력 대조, 동시 불출 테스트를 추가한다. 현재 Phase 1에는 해당 데이터와 기능이 없다.
