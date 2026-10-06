# Directory Update Log

## 2026-10-06
* **Creation**: `2026-10-06-3팀-물리-ERD.md` · `2026-10-06-3팀-schema.sql` 에서 [Team 3 physical schema](/domain/team3-physical-schema.md)
  를 만들었다(재영 승인). 1팀 스키마 위에 얹는다는 점, Prisma 가 옮기지 못하는 CHECK·부분 고유·겹침 금지,
  논리 ERD 와 달리 물리에서 정한 것(발행 문서 스냅숏, is_deleted 범위, integer 금액, 추가 컬럼)을 적었다.
  `domain/` 아래 첫 concept 이다.
* **Update**: `2026-09-30-네이밍-규칙.md`(md5 d203fb0d, 세 저장소 동일)의 1팀 변경 둘을
  [Naming conventions](/conventions/naming.md) 에 반영했다. 「사람 · 조직」 역할 값을
  `PLATFORM_MASTER` 류에서 공통코드 `ROLE_TYPE` 상세코드(`PM`·`PA`·`BM`·`BA`·`FM`·`FA`)로 바꿨다 —
  긴 형식은 세 저장소 어디에서도 쓰이는 곳이 없었고, 1팀 물리 모델의 `role_groups.role_code`
  CHECK 제약(`^[A-Z]{2}[0-9]{6}$`)이 유형코드를 대문자 2글자로 못 박아 접두로 쓸 수도 없다.
  약관 유형 상세코드 `STAFF_PRIVACY_COLLECT` 는 21자라 `code_items.item_code` 의 20자 제약을
  넘겨 `STAFF_PRIVACY`(13자)로 줄였다. 이 저장소 코드에는 영향이 없다 — 두 값 모두 아직
  스키마에 없고, `staff`·`customers` 는 네이밍 규칙이 예제·템플릿으로 남겨 둔 테이블이다.
* **Update**: `2026-09-30-네이밍-규칙.md`(md5 8f295c76, 세 저장소 동일)를 [Naming conventions](/conventions/naming.md)
  에 반영했다. 재영 결정(고침 2026-10-06): 역할 외래키 `{역할}_by` — 「Primary keys are named
  after the table」 의 "외래키는 기본키와 같은 이름" 예외로도 적었다 —, 대응표에 직무 `job_title`,
  임금계약서 `wage_contract`, 계약서 파일 구분 4종, 4대보험 가입 여부 두 칸. 같은 원자료에 1팀
  변경이 함께 들어와 반영했다: 약어 예외 `admin`, `auth_type_code`→`role_type_code`, 약관 유형 6종,
  BP 기본키 `bp_id`→`bp_code_id`, `repeat_until`→`repeat_end_date`, `effective_from`→
  `effective_start_date`, `public_holiday_sync_log`→`public_holiday_synchronization_log`. 이 1팀
  변경은 원자료 「고침: 2026-10-02 — (1팀, 커밋 f300ef3·c1a05da) …」 줄에 기록돼 있다(처음에
  빠져 있다가 2026-10-06 재영 지시로 추가됨, md5 c87a7dad).

## 2026-10-02
* **Update**: 원자료 「고침: 2026-10-02 — 6장 바꾸는 방법을 실제 운영에 맞춤」을 받았다.
  [Naming conventions](/conventions/naming.md) 의 「Changing it」 이 이미 같은 내용이라 concept 은
  고치지 않았다(`verified` 유지).
* **Update**: [Naming conventions](/conventions/naming.md) 의 「Changing it」 을 실제 운영에 맞췄다.
  원자료는 날짜 붙은 새 파일이 아니라 한 파일을 제자리에서 고친다. 이어서 재영이 10-01 이후
  변경분(삭제 표시 · 기본키 · 1팀 추가분 · 10-02 결정 두 건 · 이 수정)을 검토해 `verified` 를
  올렸다. `generated.at` 과 같은 시각이라 검토 후 변경 신호는 꺼져 있다.
* **Update**: [Naming conventions](/conventions/naming.md) — 재영 결정 두 가지(기획 세션 전달).
  1팀 추가분은 1팀이 판단하는 영역이라 재영 확인 대상이 아니라고 Status 절을 고쳤다. 로그인
  토큰 수명(1팀 관리자 1시간·1시간, api 15분·7일, 직원 근무 앱 30일)은 맞출 대상이 아니라고
  인증·계정 절에 적었다.
* **Update**: `2026-09-30-네이밍-규칙.md` 에 1팀이 더한 내용을 [Naming conventions](/conventions/naming.md)
  에 반영했다. 약어 예외 `biz`·`ceo`, 「Identifier exceptions (1팀)」 절, 인증·계정 · BP·점포 ·
  설정·시스템관리 대응표. `customers` → `admin_accounts` 개명을 「Where this repository already
  disagrees」 에 넣었다(코드와 로그인 경로는 아직 `customers`). `admin_session` 수명(1시간·1시간)이
  api 의 실제 발급값(15분·7일)과 다르다는 점과, 원자료 상태 줄에 1팀 추가분의 재영 확인이 없다는
  점을 함께 적었다.
* **Update**: `2026-09-30-네이밍-규칙.md` 의 기본키 규칙을 [Naming conventions](/conventions/naming.md)
  에 반영했다. 기본키도 `{참조 단수}_id` 로 짓고(`contracts.contract_id`) 새 테이블부터
  적용한다. 「Where this repository already disagrees」 에 기본키 줄을 넣으면서, 지금 있는
  4개 테이블은 예제·템플릿 인증 주체라 결함이 아니며 계정 테이블·첫 도메인 모듈과 함께
  정리된다는 이유를 적었다.
* **Update**: [Naming conventions](/conventions/naming.md) 의 DB 절에 삭제 표시 규칙을
  넣었다(재영 지시). `is_deleted boolean NOT NULL DEFAULT false` 하나로 표시하고, 시각 예시의
  `deleted_at` 은 뺐다. 삭제가 가능한 테이블에만 두며 `stock_movements` 와 `*_logs`·`*_histories`
  에는 두지 않는다. 조회마다 `is_deleted = false` 를 걸어야 하고, 유니크 제약은 부분 인덱스로
  바꿔야 한다는 두 함정을 함께 적었다. 원자료에는 아직 없다 — 기획 세션에 반영을 요청했다.

## 2026-10-01
* **Update**: [Naming conventions](/conventions/naming.md) 에 `verified` 를 넣었다.
  재영이 1~5장 전체를 확인한 사실이 본문 Status 절에만 있어, 내용이 나중에 바뀌어도
  그 문장이 그대로 남아 거짓이 되는 상태였다. 번들의 첫 `verified` 항목이다.
  `generated.at` 은 올리지 않았다 — 본문이 바뀐 것이 아니므로 올리면
  `verified.at < generated.at` 이 되어 방금 기록한 검토가 그 자리에서 무효가 된다.
* **Update**: [Naming](/conventions/naming.md) 문서 전체(1~5장)를 2026-10-01 재영 확인으로 확정했다.
* **Update**: [Naming](/conventions/naming.md) 의 영문 식별자 대응표를 2026-10-01 재영 확인으로 표시했다. 1~4장 계층별 규칙은 여전히 제안이다.
* **Update**: `2026-09-30-네이밍-규칙.md` 가 바뀌어 [Naming conventions](/conventions/naming.md)
  에 반영했다. 「API 목록 응답」 절이 새로 생겼고(`{ items, total }`, `findMany`+`count` 를
  `$transaction` 으로, `page`·`pageSize` 기본 20, 정렬 끝에 `id`), 오류 응답은 Nest 기본을
  유지하는 쪽으로 바뀌어 「Where this repository already disagrees」 의 오류 형식 줄을 지웠다.
  날짜·시각 형식 규칙은 원자료에서 빠졌다. 문서 상태를 `draft` 로 내렸다 — 원자료가 전체를
  「기획 세션 제안 · 재영 검토 전」으로 표시하고 목록 응답만 재영 확인이다.

## 2026-09-30
* **Update**: [Naming conventions](/conventions/naming.md) — `items` 를 규칙에 맞추지
  않기로 한 결정을 적었다. 예제일 뿐이고 맞추려면 `whale-erp-front` 를 같이 고쳐야 한다.
  첫 실제 도메인 모듈을 규칙대로 만들어 새 본보기로 삼는다. `okf/index.md` 가 아직
  [Items API](/api/items-api.md) 를 복사 대상으로 가리키는 점도 함께 남겼다.
* **Update**: [Naming conventions](/conventions/naming.md) — `/items` 에 부르는 쪽이
  없다고 적은 것을 고쳤다. `whale-erp-front` 의 `listItems`(`src/lib/api.ts:145`)가
  `/items?take=` 로 부르고 응답을 `Item[]` 로 읽는다. 파라미터를 빼면 전역
  `ValidationPipe` 의 `forbidNonWhitelisted` 때문에 400 이 되므로, 이 저장소만으로는
  규칙에 맞출 수 없다.
* **Creation**: `2026-09-30-네이밍-규칙.md` 의 DB·API·FRONT 규칙과 용어집 영문 식별자
  대응표를 [Naming conventions](/conventions/naming.md) 로 새로 만들었다. 규칙과 현재
  코드가 어긋나는 네 곳(목록 응답 모양, 페이지 파라미터, 오류 형식, `staff` 테이블의
  정체)을 같은 문서에 적었다 — `items` 가 worked example 이라 그대로 복사하면
  불일치가 번진다.

## 2026-08-31
* **Update**: [Testing conventions](/conventions/testing.md) — the single-case example no longer shows the `pnpm test -- -t` form that CLAUDE.md forbids, and the concept now says which tests belong in e2e.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) — the frontmatter description called the service a skeleton with no domain code, contradicting its own body.
* **Update**: [Authentication](/api/auth.md) — losing the rotation race now revokes the session too, the signing key is length-checked at startup, the login routes are rate limited on IP and account axes, and `user:create` no longer takes the password as an argument.
* **Update**: [Authentication](/api/auth.md) — refresh reuse now revokes the whole session, rotation became a single conditional write, login runs the password comparison even for unknown accounts, and scrypt parameters are stored in the hash.
* **Update**: [Items API](/api/items-api.md) — the item routes are staff-token-only (`@UserTypes('staff')`); a customer token gets 403.

## 2026-08-28
* **Creation**: Added the [Authentication](/api/auth.md) concept: staff/customer tables, the deny-by-default global guard, and rotating refresh tokens.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) no longer describes the service as unauthenticated; every route now needs a bearer token unless marked `@Public()`.
* **Update**: Added update and delete endpoints to [Items API](/api/items-api.md); deletion is restricted by the movement foreign key rather than cascading.
* **Update**: Narrowed id columns from bigint to integer; responses now carry numeric ids ([Items API](/api/items-api.md)).
* **Update**: Default listen port moved from 3000 to 8000 in [Whale ERP API](/api/whale-erp-api.md).
* **Update**: Noted the Swagger endpoints and their production cut-off on [Items API](/api/items-api.md).
* **Creation**: Added the [Items API](/api/items-api.md) concept covering derived stock, the row lock, and the two-layer constraints.
* **Update**: Recorded the ConfigModule wiring and the APP_ENV profile scheme in [Whale ERP API](/api/whale-erp-api.md); the service is no longer config-less.
* **Update**: Recorded the test-first policy for API code in [testing conventions](/conventions/testing.md); the directive itself lives in CLAUDE.md.
* **Initialization**: Established the bundle root, targeting OKF v0.2.
* **Creation**: Added the [Whale ERP API](/api/whale-erp-api.md) service concept.
* **Creation**: Added [testing](/conventions/testing.md) and [TypeScript/lint](/conventions/typescript.md) convention concepts.
