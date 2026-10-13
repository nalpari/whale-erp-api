# 관리자 웹 로그인 · 로그인 정보 — 구현 계획

- 작성: claude-code/opus-5.5 · 2026-10-13 (재영 지시, 계획 승인 → 구현 완료, 커밋 전)
- 정책 근거: front `okf/auth.md` 「로그인 · 세션」(2026-10-13 로그인 정보 줄), `okf/system.md` `PL-AMTMVC`, `okf/config.md` `S-KUDELB` · `S-OENTFQ`
- 형식 견본: 3팀 직원 앱 로그인 `src/auth/account-auth.*`, `src/auth-session/` — 같은 규칙(잠금 행 잠금, 같은 문구·같은 시간, jti · typ, 세션 확인 가드)을 1팀 테이블로 옮긴다
- 스키마 변경 없음. `admin_accounts` · `admin_sessions` · `admin_login_logs` · `temporary_passwords` · `role_groups` · `role_group_menus` · `menus` · `admin_store_mappings` · `stores` · `bp_codes` · `code_groups` · `code_items` 를 그대로 쓴다

## 정책 요약

| 항목 | 규칙 |
|---|---|
| 토큰 | 접근 1시간, 갱신은 마지막 사용 후 1시간(밀어 줌, 회전 안 함). 접근 토큰에 `type: 'admin'` · `sid` · `jti` |
| 화면 정보 | 로그인 직후 `GET /auth/admin/login-info` 를 한 번 받아 그린다. 바뀐 값은 다시 로그인할 때 |
| 판정 | 업무 API 의 메뉴 권한 · 점포 범위는 요청마다 현재 DB 로. 권한 없음 403 「권한이 변경되었습니다. 다시 로그인해 주세요」 |
| 계정 상태 | 미사용 · 삭제 · 탈퇴는 로그인 거절, 갱신 거절. 살아 있는 접근 토큰은 끊지 않는다(최대 1시간) — front `auth.md:38` |

## API

| 경로 | 인증 | 내용 |
|---|---|---|
| `POST /auth/admin/login` | 공개 · 요청 제한 | `{ loginId, password, deviceInformation? }` → `{ accessToken, refreshToken, refreshTokenExpiresAt, account }` (직원 앱과 같은 모양). `account` 에 `bp: { bpCodeId, bpCode, tradeName, isPlatform }` — front 가 로그인 뒤 BP 데이터를 `bpCodeId` 로 가른다 |
| `POST /auth/admin/refresh` | 공개 · 요청 제한 | `{ refreshToken }` → `{ accessToken, refreshTokenExpiresAt }` |
| `POST /auth/admin/logout` | admin | 이 세션만 종료. 204 |
| `POST /auth/admin/temporary-passwords` | 공개 · 요청 제한 | `{ name, loginId, email }` → 일치 여부와 상관없이 같은 202. 일치하면 1시간짜리 임시 비밀번호 메일(단계 7) |
| `GET /auth/admin/login-info` | admin | `{ account, menus, stores, codes }` — 부를 때의 현재 값 |
| `GET /public-bp-codes/{bpCode}/code-items?groups=` | 공개 | 그 BP 가 보는 공통코드(`groups` 를 주면 그 그룹만) `{ codes: { GROUP: [{ value, label, order }] } }` |
| `GET /bp-codes/{bpCodeId}/stores` · `code-items` | PM · PA | 고른 고객 BP 의 점포 전체 · 공통코드 |

## 단계 (각 단계 TDD: 실패 spec → 최소 구현 → 리팩터)

### 1. 관리자 세션 — `src/admin-session/`
- `AdminSessionService`: `issue(tx)` · `find(refreshToken)` · `extend(sid, accessToken, cap?)` · `isActive(sid, adminAccountId)` · `revoke(sid)` — 계획의 `validate` 는 찾기(`find`)와 밀기(`extend`)로 나뉘었다. 갱신 상한(임시 비밀번호 만료)을 그 사이에서 계산해야 해서다. `revokeAll` 은 부르는 곳이 없어 만들지 않았다
- `AuthSessionService` 를 넓히지 않고 따로 둔다 — 테이블 · 수명(1시간 vs 30일) · 칸(`access_token_hash` 필수, `refresh_last_used_at`)이 달라 분기만 늘어난다
- 수명: `expires_at = refresh_last_used_at + 1h`. `extend` 가 조건부 `updateMany` 로 민다(직원 앱과 같은 경합 처리)
- `access_token_hash` 는 NOT NULL 이라 발급 · 갱신 때 접근 토큰 해시를 같이 쓴다
- 갱신 거절: 없는 토큰 · 종료 · 만료 · 삭제된 세션 · 계정 미사용/삭제/탈퇴 — 같은 문구 401
- spec: 만료 경계(같은 순간 = 만료), 종료된 세션 되살리지 않음, 다른 계정 sid 거부, 기기별 이전 세션 종료

### 2. 가드 · 타입 — `src/auth/`
- `AdminUser` 는 `{ type, id, loginId, sid }` — `email` 은 뺐다(관리자 이메일은 null 가능하고, 식별은 `loginId`). main 의 컨트롤러 spec 다섯 개도 이 모양으로 고쳤다
- `JwtAuthGuard`: admin 도 `sid` 필수 + `AdminSessionService.isActive`. 지금은 서명만 맞으면 통과하는 상태라 이 단계가 보안 구멍을 막는다
- spec: sid 없는 admin 토큰 401, 종료된 세션 401, account 경로 회귀 없음

### 3. 로그인 · 갱신 · 로그아웃 — `AdminAuthService` · `AdminAuthController` (`/auth/admin`)
- 판정 순서(front `auth.md`): **잠금 → 아이디·비밀번호 → 계정 상태 → 강제 변경**
  - 없는 아이디 · 삭제 · 탈퇴 · 비밀번호 불일치 · 임시 비밀번호 불일치 → 같은 문구 401, 같은 검증 시간(더미 해시)
  - 잠금(5회 · 5분, `attempt-lock.ts` 재사용, `SELECT … FOR UPDATE`) → 429. 잠긴 동안은 비밀번호를 보지 않고 세지 않는다
  - 미사용은 비밀번호까지 맞을 때만 「이용 제한」 403
  - 강제 변경 대상이면 로그인은 되고 `account.isPasswordChangeRequired = true` (팝업은 front)
- 임시 · 초기 비밀번호로도 로그인: 만료 전 · 무효화 안 된 · 미삭제 최신 `temporary_passwords` 와 대조. 쓴 것도 만료까지 다시 쓸 수 있고 `used_at` 은 처음 쓸 때만 찍는다 — 첫 사용에 태우면 강제 변경 전에 탭을 닫은 사용자가 갇힌다. 기존 비밀번호로 들어오면 쓰지 않은 찾기(`TEMPORARY`) 임시 비밀번호를 무효화하고 강제 변경 표시를 끈다(`auth.md` 계정 찾기 절)
- 임시 비밀번호로 들어온 세션은 그 임시 비밀번호 만료 시각을 넘겨 갱신하지 않는다(`auth.md` 강제 변경 절) — 칸 추가 없이 갱신 때 「강제 변경 대상 + 최근 사용 임시 비밀번호의 만료」로 상한을 건다
- 성공 처리 한 트랜잭션: 행 잠금 → 다시 읽기(잠금 · 비밀번호 · 상태 경합) → 실패 횟수 초기화 → `last_login_at` → 세션 발급 → 로그인 이력
- `admin_login_logs`: 접속 IP, 성공 여부, 실패 사유(`login_failure_reason`). 없는 아이디는 `admin_account_id` NULL
- 요청 제한: 기존 `AUTH_THROTTLERS` 두 축. 계정 축이 본문 `email` 만 보므로 `loginId` 도 보게 넓힌다
- e2e(일회용 DB): 상태 코드 · 응답 모양 · 잠금 동시성 · 로그아웃 후 접근 토큰 거부

### 4. 로그인 정보 — `GET /auth/admin/login-info`
```
account: { adminAccountId, loginId, name, email, roleTypeCode,
           bp: { bpCodeId, bpCode, tradeName, isPlatform },
           isPasswordChangeRequired, temporaryPasswordExpiresAt | null, isTermsAgreementRequired }
menus:   [{ menuCode, name, url, depth, sortOrder, permission: { read, create, update, delete }, children: [...] }]
stores:  [{ storeId, storeCode, name, storeTypeCode, storeStatusCode }]
codes:   { [groupCode]: [{ value, label, order }] }
```
- menus: 계정 권한 그룹의 `role_group_menus` 중 `is_readable`, 메뉴 사용 · 미삭제, 서비스 코드 사용 중. 조회 권한 없는 메뉴는 뺀다. 하위가 보이면 상위도 넣는다
- stores: `AdminScopeService` 에 목록 메서드 추가 — `is_all_stores` 면 그 BP 전체, 아니면 매핑. 판정(`canManageStore`)과 같은 규칙
- codes: 계정 BP 기준 상세코드(아래 결정 3)
- spec: 권한 없는 메뉴 제외, 3단계 트리, 매핑 · 전체 점포, 삭제 행 제외

### 4-1. 공개 공통코드 API — `src/codes/` (2026-10-13 재영 추가)
- `GET /public-bp-codes/{bpCode}/code-items` — `@Public()`(2026-10-13 front 요청으로 `GET /code-items?bpCode=` 에서 옮김). 그 BP 가 보는 공통코드(login-info 와 같은 규칙)를 준다. 비로그인 화면(BP 회원가입 · 도입문의 · 문의 등)은 플랫폼 BP 코드를 넘긴다(2026-10-13 재영 — 그룹 지정 → 플랫폼고정 전체 → BP 코드 지정 순으로 바꿈). `bpCode` 형식이 틀리면 400, 없거나 삭제 · 탈퇴한 BP 는 404
- `GET /bp-codes/{bpCodeId}/code-items` — 로그인 뒤 플랫폼 사용자(PM · PA)가 고른 고객 BP. 401 · 403(PM · PA 아님) · 404(없는 · 삭제 · 플랫폼 BP, 정수 범위 밖)는 `GET /bp-codes/{bpCodeId}/stores` 와 같고, 탈퇴한 BP 도 답한다
- `groups`(두 경로 모두 선택): 쉼표 목록 또는 반복 파라미터, 최대 50, 각각 `code_groups` 형식. 주면 그 그룹만 — 없거나 사용하지 않는 그룹도 `[]` 로 키를 둔다. 빈 칸 · 형식 오류 · 50 초과는 400. 없으면 전체
- 캐시 없음 — API 는 캐시 헤더를 보내지 않고 front 도 화면이 열릴 때 부른다(4시간 Next 캐시 안은 없앴다)
- 사용 중 그룹 · 사용 중 상세만, 표시 순서대로
- 응답은 `{ codes: { [groupCode]: [{ value, label, order }] } }` — 항목 모양은 `/enums` 와 같다.
- `login-info.codes` 와 같은 `CodesService` 로 만든다 — 공개는 넘겨받은 BP, 로그인 정보는 계정 BP 기준
- spec: 삭제 · 사용중지 제외, 순서, 없는 · 탈퇴 BP 404, 형식 오류 400, `groups` 거르기 · 빈 목록, 고객 BP id 조회

### 5. 업무 API 판정 장치
- `@MenuPermission('MN000123', 'update')` + `MenuPermissionGuard`: 요청마다 현재 `role_group_menus` 로 판정, 실패 403 「권한이 변경되었습니다. 다시 로그인해 주세요」
- 점포 범위는 지금처럼 `AdminScopeService.canManageStore`
- 이번에는 장치만 만들고 붙일 업무 API 는 없다(첫 1팀 업무 API 가 견본)

### 5-1. 플랫폼 사용자의 BP 진입 — `src/bp-codes/` (2026-10-13 재영 추가)
- `GET /bp-codes/{bpCodeId}/stores` — 고른 고객 BP 의 미삭제 점포 전체(운영 상태 무관, 이름순, 페이지 없음) `{ items, total }`. 항목 모양은 `login-info.stores` 와 같다
- `GET /bp-codes/{bpCodeId}/code-items` — 4-1
- 접근: 사용 중인 플랫폼 BP 의 PM · PA(`AdminScopeService.isPlatformUser`). 처음엔 PM 만이었다가 front 요청으로 PA 를 넣었다. BP 진입만 열린 것이고, 고객 점포 업무 범위(`canManageStore`)는 여전히 WHALEERP-301

### 6. 마무리
- `pnpm openapi:export` 로 `openapi/openapi.json` 커밋
- okf `api/admin-auth.md` 새 개념, `okf/index.md` · `log.md`, CLAUDE.md 「Authentication」의 "관리자 웹 login does not exist" 고침
- `pnpm lint` · `pnpm test` · e2e

### 7. 임시 비밀번호 발급 — `POST /auth/admin/temporary-passwords` (2026-10-13 추가, squirtle(교토) 구현에서 옮김)
- 이름 · 아이디 · 이메일이 사용 중 · 미삭제 계정과 모두 맞을 때만 발급. 아니면 같은 202, 메일 없음 — 계정 존재를 알리지 않는다. 계정당 1시간 5회(429, 전부 맞을 때만 알림)
- 메일(`EMAIL_TEMP_PASSWORD`)을 먼저 보내고, 실패하면 503 이며 아무것도 저장하지 않는다
- 성공하면 계정 행 잠금 아래에서: 살아 있는 임시 비밀번호를 쓴 것까지 모두 무효화 → 새 것 1시간 저장 → 로그인 잠금 해제 → `is_password_change_required = true`. 본인 비밀번호는 그대로 둔다
- `mail_send_logs` 에는 `#{임시비밀번호}` 를 가려 남긴다. 메일 버튼은 `ADMIN_WEB_URL` + `/login`(운영에서 비면 기동 중지, 그 밖은 `http://localhost:3000`)
- 메일 설정이 없어도 앱은 뜬다 — `MailModule` 을 import 하지 않고 `ADMIN_MAIL`(MAIL_* 가 없으면 null)을 직접 만든다. 3팀 재설정 링크(api #28)와 같은 방식이고, 처음엔 import 해서 앱 전체가 `MAIL_*` 를 요구했던 것을 main 에 맞춰 바꿨다. 없으면 맞는 계정에 503, 반만 넣으면 기동 중지. 비밀번호는 Gmail 계정 비밀번호가 아니라 앱 비밀번호여야 한다(계정 비밀번호는 534-5.7.9 로 거절)

## 이번에 하지 않는 것
- 아이디 찾기(`POST /auth/admin/login-id-find-attempts` 제안), 강제 비밀번호 변경 · 약관 동의 저장(`POST /auth/admin/password-change` 제안), BP 회원가입
- 플랫폼 계정이 고를 BP 목록 API
- 플랫폼 사용자(PM · PA)의 고객 BP 점포 업무 범위(WHALEERP-301) — 진입 조회만 열렸다

플랫폼 마스터(`'!'`)의 첫 로그인은 단계 7 로 한다. 공용 DB 에서 2026-10-13 whaleadmin 으로 발급 메일 발송까지 확인했다(`mail_send_logs` `SUCCEEDED`).

## 검토가 필요한 결정

1. **세션 서비스 분리** — 3팀 `AuthSessionService` 를 넓히지 않고 `AdminSessionService` 를 따로 둔다.
2. **플랫폼 계정의 stores** — 지금 규칙(같은 BP)으로는 빈 목록. 플랫폼 사용자는 BP 를 골라 일하므로 `[]` 로 두고 BP 선택은 다른 API 로 한다.
3. **codes 범위** — 플랫폼고정 그룹은 플랫폼 원본, BP 적용된 플랫폼제공 · BP전용은 그 BP 행, 미적용 플랫폼제공은 플랫폼 원본. 사용중지 그룹 · 상세는 뺀다.
4. **약관 동의 필요 표시** — 플랫폼등록 계정의 약관 미동의를 `isTermsAgreementRequired` 로 알려만 주고 저장 API 는 다음 단계.
5. **임시 비밀번호 로그인 포함** — 발급은 다음 단계지만 로그인 판정은 이번에 넣는다.
6. **미사용 응답 코드** — 403 「이용이 제한된 계정입니다」.

## 결과 (2026-10-13)

- 단계 1~7 과 4-1 · 5-1 구현. 결정 1~6 은 위 안 그대로(2 의 「다른 API」가 5-1 이다).
- origin/main(4613a7d) 위로 옮겼다. 그 결과 main 의 테스트도 고쳤다 — 컨트롤러 spec 다섯 개는 `AdminUser` 를 `loginId` · `sid` 로, e2e 다섯 개(code-groups · posts · staff-members · contracts · stores)는 실제 `admin_sessions` 로 토큰을 받게. 동시 요청 시험이 있는 code-groups · posts e2e 는 앱을 미리 띄운다(`app.listen(0)`).
- 기존 e2e 두 곳(`staff-retirement`, `account-status-policy`)도 서명만 한 관리자 토큰을 쓰고 있어 실제 관리자 세션을 만들도록 고쳤다 — 가드가 admin 세션을 확인하게 된 결과다.
- 단위 테스트 866개 통과(2 todo). e2e 는 일회용 PostgreSQL 18(도커)에 마이그레이션 전체를 적용해 돌렸다 — 269개 통과,
  `enums.e2e-spec.ts` 2건은 이번 변경 전부터 실패(지워진 `WorkType` 을 기대한다).
- `openapi/openapi.json` 경로 30개.
- 개념 문서: `okf/api/admin-auth.md`.
