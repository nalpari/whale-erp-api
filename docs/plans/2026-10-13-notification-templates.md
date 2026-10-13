# 알림 템플릿 관리 API 계획

**목표:** 플랫폼 운영자가 관리자 웹에서 알림 템플릿(운영 알림 · 앱 푸시 · 메일 · 알림톡)을 보고, 고치고, 등록하고, 끄고, 기본 문구로 되돌리는 API를 만든다.

**짝 문서:** front `docs/plans/2026-10-13-notification-templates-screen.md`

**작업 위치:** 워크트리 `~/.whale-erp-worktrees/whale-erp-api/angkor`, 브랜치 `machop`(origin/main `2156b2b`에서 시작)

**Plane 일감:** #572 목록·상세 조회 · #573 수정과 되돌리기 · #581 등록과 사용 여부 · #574 알림 만들 때 템플릿 적용(남은 부분) · #577 권한 점검(테스트로). 화면 #575 · #576 · #579 · #582 는 front 계획.

## 이미 된 것 (이번에 만들지 않음)

| 일감 | 상태 |
|---|---|
| #569 데이터 구조 | `notification_templates` · `notification_template_histories` 와 CHECK 가 main 에 있다. 이번 결정(NOTIFY-17)에 따라 칸이 더해질 수 있다 |
| #570 변수 목록 | 템플릿 행의 `variables` JSON 칸이다(별도 테이블 아님). 모양 `[{ name, label, isRequired, sampleValue, isButtonLink? }]`. Plane 완료 조건의 `notification_template_variables` 는 옛 표기라 기획 세션에 알린다 |
| #571 기본 템플릿 | 40건(운영 알림 10 · 앱 푸시 5 · 메일 24 · 알림톡 1). 문서의 「37건」은 옛 숫자다 |
| #578 알림톡 문구를 템플릿에서 읽기 | `AlimtalkService` 가 이미 `findSendableTemplate` 로 읽는다 |
| #574 템플릿 적용 | 메일 · 알림톡 · 운영 알림이 모두 `findSendableTemplate` + `renderTemplate` 을 쓴다. 남은 것은 NOTIFY-19(못 읽을 때) 결정뿐 |

## 근거

| 근거 | 쓰는 곳 |
|---|---|
| 운영 정책 NTF-21 · 22 · 23 · 24 · 26 | 채널 · 이름 · 코드로 구분, 제목·본문 필수(알림톡은 본문만), 알림톡도 화면에서 고침, 코드는 고칠 수 있음, 기본 문구는 마이그레이션으로 한 번만 |
| Manyfast 「알림 템플릿 등록」 · 「운영 알림·앱 푸시·메일 템플릿 수정」 · 「알림톡 템플릿 관리」 | 검사 규칙, 변경 이력, 되돌리기, 권한 |
| 목업 NOTIFY-4 · 5 · 6 · 8 · 10 · 11 | 앱 푸시 40/100자, 메일 일반 글, 승인 상태 없음, 알림톡 본문 수정, 등록 · 모든 항목 수정, 공통코드 없이 코드로 구분 |
| api 패턴 `src/posts` | 플랫폼 관리자 확인(`AdminScopeService.isPlatformAdmin`), `updatedAt` 낙관적 잠금 409, 목록 `{ items, total }` |

## 쟁점 (front 목업 `docs/mockup/notify/overview.html`) — 2026-10-13 재영 모두 추천대로 확정

| ID | 내용 | 후보 | 확정 |
|---|---|---|---|
| NOTIFY-17 | 「기본 문구로 되돌리기」의 원본을 어디에 두나. 지금은 마이그레이션 SQL 에만 있다 | A 템플릿 행에 기본값 칸(`default_title` · `default_body` · `default_variables`)을 두고 마이그레이션으로 지금 값(40건 모두 아무도 안 고침)을 복사 / B api 코드에 상수로 둠 | A — 데이터 구조라 기획 세션에도 넘긴다. 기본값 칸이 비어 있으면 「등록한 템플릿」이라 되돌리기가 없다 |
| NOTIFY-18 | 되돌리면 무엇을 되돌리나 | A 제목 · 본문만 / B 제목 · 본문 · 변수 목록 | B — 운영자가 변수 이름을 바꿨으면 본문만 되돌릴 때 검사에 걸린다. 코드 · 이름 · 채널 · 사용 여부는 그대로 둔다 |
| NOTIFY-19 | 템플릿을 못 읽을 때 메일 · 앱 푸시 · 알림톡은 어떻게 하나(운영 정책 NTF-25 「기본 문구로 보냄」) | A 운영 알림(NOTIFY-15)과 같이 보내지 않고 로그 — 지금 코드 그대로 / B 코드에 기본 문구 한 벌을 두고 그것으로 보냄 | A — DB 를 못 읽는 상황이면 DB 에 둔 기본값도 못 읽는다. 다른 채널에 걸려 기획 세션에 넘긴다 |
| NOTIFY-20 | 변수 목록 편집 칸에 「버튼 링크」(`isButtonLink`) 표시를 둘까 | A 메일 · 알림톡에서만 「버튼 링크」 체크 칸을 보인다 / B 화면에 두지 않고 기존 값을 그대로 지킨다(새 변수는 늘 false) | A — 표시가 없으면 운영자가 링크 변수를 새로 만들 수 없다 |

## 데이터

- NOTIFY-17 A 에 따라 마이그레이션 `20261013153521_team3_notification_template_defaults`: `notification_templates` 에 `default_title text` · `default_body text` · `default_variables jsonb` 를 더하고 기존 40행에 지금 값을 복사(`UPDATE … SET default_* = title, body, variables WHERE updated_by IS NULL`). 논리 ERD → `_model.py` → 생성기 → 마이그레이션 순서. CHECK: 셋은 함께 있거나 함께 없다.
- 변경 이력은 지금 스키마 그대로 「바뀌기 전 행 전체」를 남긴다(수정 · 되돌리기 · 사용 여부 바꿈 모두).

## API

모두 `@UserTypes('admin')` + 플랫폼 마스터 · 플랫폼 관리자(`isPlatformAdmin`)만. 아니면 403. 경로 `:id` 는 1..2147483647 밖이면 404.

| 메서드 · 경로 | 요청 | 응답 |
|---|---|---|
| `GET /notification-templates?channel=&page=&pageSize=` | channel 필수 | `{ items, total }` — 한 줄: id · templateCode · channel · templateName · preferenceCategory · title · body 앞부분 · kakaoTemplateCode · isActive · hasDefault · updatedBy(이름) · updatedAt. 정렬 templateCode, id |
| `GET /notification-templates/:id` | — | 모든 칸 + variables + hasDefault + histories(최근순: 일시 · 수정자 이름 · 무엇이 바뀌었나 요약) |
| `POST /notification-templates` | channel · templateName · templateCode · preferenceCategory? · title? · body · variables · kakaoTemplateCode? · isActive | 201 + 상세. 코드가 겹치면 409 |
| `PUT /notification-templates/:id` | 위와 같은 칸 + `updatedAt`(읽은 값) | 상세. 그사이 누가 고쳤으면 409. 바뀌기 전 행을 이력에 |
| `POST /notification-templates/:id/restore` | `updatedAt` | 기본값으로 되돌린 상세. 기본값이 없으면 409 「등록한 템플릿은 되돌릴 기본 문구가 없습니다」 |
| `PATCH /notification-templates/:id/active` | `isActive` · `updatedAt` | 상세. 이력에 남김 |

지우는 API 는 두지 않는다(운영 정책 NTF-21).

### 저장 검사 (등록 · 수정 공통, 400 — 어느 칸 몇째 줄인지 메시지에)

- 템플릿 코드: `^[A-Z][A-Z0-9_]*$`, 채널 접두(NTF_ · PUSH_ · EMAIL_ · TALK_)로 시작하는지는 등록 때만 화면이 채운다 — api 는 형식 · 고유만 본다(코드는 고칠 수 있고 채널을 바꿔도 저절로 바뀌지 않는다, #573).
- 템플릿 이름 필수, 100자.
- 채널별: 운영 알림 · 앱 푸시 · 메일은 제목 · 본문 필수, 알림톡은 제목을 받지 않고 카카오 템플릿 코드 필수. 앱 푸시만 수신 설정 묶음 필수(그 밖은 받지 않음). 앱 푸시는 제목 40자 · 본문 100자(NOTIFY-4).
- 변수 목록: 이름 필수 · 겹치지 않음 · `#` · 중괄호 · 공백 없음(한글 허용), 표시 이름 필수, 50개까지.
- 제목 · 본문의 `#{…}` 가 모두 목록 안에 있는지, 닫히지 않은 `#{` 가 없는지, 필수 변수(버튼 링크 제외)가 제목 · 본문에 있는지 — `renderTemplate` 과 같은 규칙을 저장 쪽 검사 함수(`validate-template.ts`)로 한 번 더 둔다.
- NUL 은 받지 않는다(`NO_NUL`).

## 테스트 (먼저 쓴다)

- `validate-template.spec.ts` — 채널별 필수 칸, 앱 푸시 글자 수, 변수 이름 규칙, 목록에 없는 변수 · 닫히지 않은 `#{` · 빠진 필수 변수의 위치 메시지, 버튼 링크는 필수 검사에서 빠짐
- `notification-templates.service.spec.ts` — 목록 채널 거르기 · 쪽, 상세 이력, 등록 409, 수정 시 이력 한 줄 · 409 잠금, 되돌리기(기본값 없음 409 · 이력), 사용 여부
- `notification-templates.controller.spec.ts` — 플랫폼 관리자가 아니면 403, id 범위 404
- `test/notification-templates.e2e-spec.ts` — 실제 DB 로 CHECK(채널별 칸) · 고유 코드 · 기본값 복사 확인

## 할 일 순서

1. 쟁점 결정 → (NOTIFY-17 A 면) 마이그레이션
2. `validate-template.ts` 테스트 → 구현
3. 서비스 · 컨트롤러 · DTO 테스트 → 구현, e2e
4. `pnpm openapi:export`, okf `api/notification-templates.md` · `log.md`, `naming.md` 의 「37건」 고침
5. lint · test · test:e2e
