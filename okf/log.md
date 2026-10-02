# Directory Update Log

## 2026-10-02
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
