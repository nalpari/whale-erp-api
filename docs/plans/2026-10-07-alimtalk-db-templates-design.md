# 알림톡 DB 템플릿 전환 · 발송 이력 설계

- 날짜: 2026-10-07
- 브랜치: `snorlax` (worktree `machu-picchu`), PR #6 위에 잇는다
- 상태: 1단계 · 2단계 구현 (2026-10-08). 2단계 논리 ERD 는 front PR #2
- 앞선 설계: `docs/plans/2026-10-07-mail-sending-design.md` (메일)
- 고침: 2026-10-08 — `escapeBody` 는 없어졌다. 본문은 채널을 가리지 않고 일반 글로 채우고, 메일이 본문 전체를 이스케이프해 공통 틀에 넣는다. `renderTemplate` 은 버튼 링크 값을 `links` 로 돌려주고 가림본에서 언제나 가린다(NTF-22, PR #6 팀 리뷰)

## 목적

알림톡을 메일과 같은 방식으로 보낸다. 문구는 `notification_templates` 의 ALIMTALK 행에서 읽고,
발송 시도마다 알림톡 전용 이력 테이블에 한 행을 남긴다. 메일과 알림톡의 변수 검증 · 치환 · 가림
규칙은 한 곳의 코드를 같이 쓴다.

## 정해진 것

| 항목 | 결정 |
|---|---|
| 코드 구조 | 렌더를 `src/notification-templates/` 로 옮겨 메일과 알림톡이 같이 쓴다(접근안 A) |
| 문구 | `notification_templates` 의 `channel = ALIMTALK` 행. 코드 레지스트리(`ALIMTALK_TEMPLATES`)는 없앤다 |
| 카카오 템플릿 코드 | 행의 `kakao_template_code` 를 비즈뿌리오 `templatecode` 로 보낸다 |
| 제목(강조 표기형) | 없앤다 — CHECK `notification_templates_title_by_channel` 이 ALIMTALK 행의 `title` 을 비우게 한다 |
| 이력 테이블 | `alimtalk_send_logs` (가칭). 받는 사람은 전화번호 + 관련 업무(`related_type` · `related_id`) |
| 논리 ERD | front 저장소 `docs/erd/README.md` 가 원본이라 재영/기획 세션이 먼저 반영한다. api 는 그 뒤 |
| 브랜치 | `snorlax` 위에서 이어 간다 |

## 단계

**1단계 (지금)** — front 를 기다리지 않는 것.

1. `src/notification-templates/` 공용 코드
2. 메일이 공용 코드를 쓰도록 import 변경(동작 그대로)
3. `AlimtalkService` 를 DB 템플릿으로 전환
4. 테이블 제안서 `docs/plans/2026-10-07-alimtalk-send-logs-table.md` — 재영님께 전달
5. okf 갱신

**2단계 (front 논리 ERD 반영 뒤)** — 물리 모델 · 차이 마이그레이션 · 이력 기록 · `related` / `sentBy`.

## 인터페이스

```ts
// 1단계
alimtalk.send({
  templateCode: 'TALK_STAFF_INVITATION',
  to: '010-1234-5678',
  variables: { 근무지: '모리커피 연남점', 링크: 'erp.whale.test/i/abc' },
  maskedVariables: ['링크'], // 선택. 1단계는 검증만, 2단계부터 이력에 반영
}): Promise<{ refKey: string; messageKey?: string }>

// 2단계에 더한다
  related?: { type: string; id: number }, // 둘을 한 객체로 받아 하나만 있는 상태를 타입으로 막는다
  sentBy?: number,
```

메일은 시그니처가 그대로다(`send({ templateCode, to, variables, maskedVariables?, adminAccountId?, sentBy? })`).
두 채널로 보내야 하면 호출부가 각각 부른다 — 채널마다 받는 사람이 달라 한 번에 퍼뜨리는 함수는 두지 않는다.

`AlimtalkService` 를 부르는 곳은 아직 없어 시그니처 변경으로 깨지는 호출부가 없다.

## 공용 코드 `src/notification-templates/`

### `render-template.ts`

메일의 `renderMail` 을 옮겨 이름을 `renderTemplate` 으로 바꾼다.

```ts
renderTemplate(
  template: { templateCode: string; title: string | null; body: string; variables: TemplateVariable[] },
  values: Record<string, string>,
  maskedVariables?: readonly string[],
  options?: { escapeBody?: boolean },   // 기본 false
): { subject: string | null; body: string; maskedSubject: string | null; maskedBody: string }
```

- 규칙은 메일 때와 같다: 템플릿에 없는 변수 · 가림 이름은 던진다, 필수 변수 누락은 던진다(빈 문자열은 값),
  선언되지 않은 자리는 던진다, 선택 변수 누락은 빈 문자열, 한 번에 치환, 상속 속성은 값으로 쓰지 않는다,
  오류 메시지에 값을 넣지 않는다.
- `escapeBody: true` 면 본문 값을 HTML 이스케이프한다(메일). 제목은 언제나 그대로다.
- `title` 이 `null` 이면 `subject` · `maskedSubject` 도 `null` 이다(알림톡).
- 오류 메시지의 「메일」 은 「템플릿」 으로 바꾼다 — 두 채널이 같이 쓴다.
- 반환 필드 이름이 `html` → `body` 로 바뀐다. 메일 서비스가 이에 맞춰 고친다.

### `find-template.ts`

```ts
findSendableTemplate(
  prisma: Pick<PrismaService, 'notificationTemplate'>,
  templateCode: string,
  channel: NotificationTemplateChannel,
): Promise<NotificationTemplate>
```

행이 없거나 `is_active = false` 거나 `channel` 이 다르면 템플릿 코드를 담아 던진다. Nest 서비스가 아니라
Prisma 를 인자로 받는 함수다 — 모듈을 하나 더 두지 않으려고.

## 알림톡 흐름 (1단계)

```
send()
 1. 번호를 숫자만 남겨 ^01\d{8,9}$ 아니면 던짐 (지금과 같음)
 2. findSendableTemplate(prisma, code, 'ALIMTALK')
 3. renderTemplate(..., maskedVariables, { escapeBody: false })
    (1~3 실패: 비즈뿌리오 호출 없음)
 4. refKey 를 만들어 비즈뿌리오 sendMessage
    templatecode = kakao_template_code, message = 렌더한 본문
    ├ 접수 → logger.log (템플릿 코드 · refKey · messageKey · 가린 번호)
    └ 실패 → logger.warn (… · code · http · 메시지 1000자) → 원래 예외를 다시 던짐
```

- 본문은 로그에 남기지 않는다. 이름 · 초대 링크 같은 값이 들어간다.
- 접수는 전달이 아니다. 실제 결과는 비즈뿌리오 결과 리포트로 오며 아직 받지 않는다.
- `code` 없는 비즈뿌리오 오류(네트워크 · 끊긴 응답)는 「안 갔다」가 아니다 — 재시도하지 않는다.
- 트랜잭션 밖(커밋 뒤)에서 부른다.
- `kakao_template_code` 가 NULL 인 ALIMTALK 행은 CHECK `notification_templates_alimtalk_fields` 가 막는다.

### 없어지는 것

- `src/alimtalk/alimtalk-templates.ts` — 레지스트리와 컴파일 단계 변수 타입
- `ALIMTALK_TEMPLATE_REGISTRY` 주입(`alimtalk.module.ts`)
- 템플릿 제목 처리
- `AlimtalkService` 안의 `render` · `PLACEHOLDER`

컴파일 단계 변수 검사는 대신할 것 없이 사라진다. 변수 목록이 DB 에 있어 운영자가 고칠 때마다 호출부와
어긋날 수 있으므로, 검사는 발송 때로 옮겨진다(재영 2026-10-07, okf alimtalk).

## 2단계 — 이력 테이블 `alimtalk_send_logs` (제안)

| 컬럼 | 타입 | NULL | 기본값 | 비고 |
|---|---|---|---|---|
| `alimtalk_send_log_id` | integer | | IDENTITY | PK |
| `template_code` | text | | | 보낸 템플릿 코드 |
| `kakao_template_code` | text | | | 보낸 시점의 카카오 템플릿 코드 — 템플릿 행은 고쳐질 수 있다 |
| `to_phone` | text | | | 숫자만. CHECK `alimtalk_send_logs_to_phone_format`: `^01[0-9]{8,9}$` |
| `related_type` | text | NULL | | 관련 업무 유형 — 예 `INVITATION` |
| `related_id` | integer | NULL | | 관련 업무 ID |
| `body` | text | | | 보낸 본문. 호출부가 지정한 변수는 `********` |
| `result` | dispatch_result | | | SUCCEEDED · FAILED (3팀 기존 enum) |
| `failure_reason` | text | NULL | | 비즈뿌리오 code · HTTP status · 메시지 |
| `ref_key` | text | | | 우리가 만든 요청 키 — 결과 리포트의 REFKEY |
| `message_key` | text | NULL | | 비즈뿌리오 메시지 키 |
| `sent_by` | integer | NULL | | FK → admin_accounts. 관리자가 대신 보냈을 때 |
| `sent_at` | timestamptz(6) | | CURRENT_TIMESTAMP | 발송 시각 |

- CHECK `alimtalk_send_logs_related_pair`: `num_nonnulls("related_type", "related_id") <> 1`
- INDEX (`related_type`, `related_id`), INDEX (`to_phone`, `sent_at`)
- `is_deleted` 없음 — `_logs` 는 지우지 않는다(naming).
- 기존 `notification_deliveries` 를 쓰지 않는 이유: `notification_recipients` 행에 묶여 있어, 가입 초대처럼
  계정이 없는 사람에게 보내는 알림톡을 담을 수 없다.

### 2단계 흐름

1단계 흐름의 4번에서 접수 · 실패 모두 위 테이블에 한 행을 남긴다. 메일과 같은 규칙이다:
기록 INSERT 실패는 던지지 않고 `logger.error`(오류 이름 · 코드 · related · sentBy 만, 메시지는 남기지 않음),
이력에는 가린 본문만 넘긴다.

### 2단계 절차

1. front 논리 ERD 에 표가 들어온다(재영/기획 세션).
2. `_model.py` 에 물리 결정(enum · 기본값 · CHECK · 인덱스 · `sent_by` FK)을 더하고 생성기를 돌린다 —
   `schema.sql` · 물리 ERD 정의서 · `schema.prisma` 가 다시 만들어진다.
3. 바뀐 줄을 새 마이그레이션 `…_team3_alimtalk_send_logs` 에 옮기고, 「마이그레이션 전체 적용 DB = 1팀 DDL +
   새 schema.sql DB」를 PGlite 로 대조한다(퇴직 처리 마이그레이션과 같은 방법).
4. `AlimtalkService` 에 `related` · `sentBy` 와 기록을 더한다.

## 테스트 (1단계)

- `src/notification-templates/render-template.spec.ts` — 메일의 렌더 테스트를 옮기고 `escapeBody: false`
  (값 그대로) · `title: null`(제목 null) 경우를 더한다.
- `src/notification-templates/find-template.spec.ts` — 있음 · 없음 · 비활성 · 채널 다름.
- `src/mail/mail.service.spec.ts` — 그대로 통과해야 한다(동작 변경 없음).
- `src/alimtalk/alimtalk.service.spec.ts` — 다시 쓴다: DB 템플릿 조회, `kakao_template_code` 로 보냄,
  치환, 이스케이프 없음, 템플릿 없음 · 비활성 · 채널 다름 · 필수 변수 누락 · 모르는 가림 이름은 보내지 않고
  던짐, 번호 형식, 접수 로그(가린 번호 · 본문 없음), 비즈뿌리오 오류는 그대로 던짐.

## 범위 밖

- 2단계 전체(테이블 · 마이그레이션 · 기록) — front 논리 ERD 반영 뒤
- 비즈뿌리오 결과 리포트 조회 · 대체 발송(SMS) · 재시도
- 시드 ALIMTALK 템플릿 본문이 카카오 검수 문구와 같은지 확인 — 비즈뿌리오가 다르면 거절한다
- `AppModule` 연결 — 첫 사용처가 생길 때
