# 메일 발송 공통 기능 설계

- 날짜: 2026-10-07
- 브랜치: `snorlax` (worktree `machu-picchu`)
- 상태: 설계 확정, 구현 계획 전

## 목적

여러 도메인(1팀 임시 비밀번호 발급·계정 생성, 3팀 비밀번호 찾기·도입문의 등)이 같은
방법으로 메일을 보내고, 보낸 결과가 `mail_send_logs` 에 남게 한다. 도메인은
`MailService` 하나만 주입받아 템플릿 코드와 변수로 보낸다.

이전 시도(PR #5, `gengar`)는 머지하지 않았고 이 설계는 그것을 이어받지 않는다.

## 정해진 것

| 항목 | 결정 |
|---|---|
| 발송 수단 | Gmail SMTP (`smtp.gmail.com:465`, TLS, 앱 비밀번호) |
| 문구 | `notification_templates` 의 `channel = EMAIL` 행 |
| 본문 형식 | 템플릿 `body` 가 완성된 HTML 이다(나중에 메일 전용 에디터가 통째로 저장). 감싸는 공통 틀은 없다. HTML 파트 하나만 보낸다 |
| 링크 | 에디터가 본문에 `<a href="#{링크}">` 로 넣는다. 발송 코드는 `isButtonLink` 를 읽지 않는다 |
| 발송 이력 | 발송을 시도하면 성공·실패 모두 `mail_send_logs` 에 한 행 |
| 가림 | 호출부가 `maskedVariables` 로 지정한 변수 값을 이력에서 `********` 로 바꾼다 |
| 구조 | 메일 모듈 하나가 조회·렌더·발송·기록을 맡는다. 렌더는 순수 함수로 떼어 둔다 |

## 인터페이스

```ts
mailService.send({
  templateCode: 'EMAIL_TEMP_PASSWORD',
  to: 'hong@example.com',
  variables: { 관리자이름: '이서준', 임시비밀번호: 'x8Rk-2mPq', 링크: 'https://…' },
  maskedVariables: ['임시비밀번호'], // 선택
  adminAccountId: 12,               // 선택. 받는 사람이 관리자 계정일 때
  sentBy: 3,                        // 선택. 관리자가 대신 보냈을 때
}): Promise<{ messageId: string }>
```

- 변수 이름은 템플릿 `variables[].name` 그대로다(시드는 한글 이름).
- `mail_type_code` 에는 `templateCode` 를 넣는다(네이밍 규칙 2026-10-07 고침).
- `MailModule` 은 `MailService` 만 내보낸다. `AppModule` 에는 넣지 않고, 메일을
  쓰는 모듈이 import 한다 — 넣으면 쓰는 곳이 없어도 모든 환경이 `MAIL_*` 를 요구한다.

## 흐름

```
send()
 1. 검증 ─ 실패면 예외. SMTP 호출 없음, 이력 없음
 2. 렌더 → { subject, html }, 이력용 { maskedSubject, maskedHtml }
 3. SMTP sendMail
    ├ 성공 → mail_send_logs SUCCEEDED
    └ 실패 → mail_send_logs FAILED + failure_reason → 원래 예외를 다시 던짐
 4. 이력 INSERT 실패 → logger.error 만 남기고 삼킨다
```

### 1. 검증 (발송 전, 예외)

- 템플릿이 없다 · `is_active = false` · `channel ≠ EMAIL`
- `isRequired` 변수가 `variables` 에 없다
- 템플릿 `variables` 에 없는 이름을 넘겼다
- `maskedVariables` 에 템플릿에 없는 이름이 있다 — 오타가 나면 가림이 조용히 빠져
  비밀번호가 평문으로 남으므로 예외로 막는다
- `to` 가 주소 한 개가 아니다 — 쉼표·세미콜론·꺾쇠·따옴표·괄호·콜론·역슬래시·공백이
  있으면 nodemailer 가 받는 사람을 여럿으로 나누거나 표시 이름으로 읽는다

보낸 것이 없으므로 이력도 남기지 않는다.

### 2. 렌더 (`render-template.ts`, 순수 함수)

- 제목·본문의 `#{이름}` 을 모두 값으로 바꾼다.
- 본문에 들어가는 값은 HTML 이스케이프한다(`& < > " '`). 제목은 메일 헤더라
  이스케이프하지 않는다.
- 같은 렌더를 가림 값(`********`)으로 한 번 더 해서 이력용 제목·본문을 만든다.

### 3. 발송과 이력

| 컬럼 | 값 |
|---|---|
| `mail_type_code` | `templateCode` |
| `admin_account_id` · `sent_by` | 호출부가 넘긴 값, 없으면 NULL |
| `from_email` | `MAIL_USERNAME` |
| `to_email` | `to` |
| `subject` · `body` | 가린 제목 · 가린 HTML |
| `result` | `SUCCEEDED` / `FAILED` |
| `failure_reason` | 실패 때 SMTP `code` · `responseCode` · 메시지 요약 |

- 재시도하지 않는다. `ETIMEDOUT` 은 「안 갔다」가 아니다 — Gmail 이 이미 받았을 수
  있으므로 자동 재시도는 임시 비밀번호를 두 번 보낼 수 있다. `FAILED` 로 남기되
  `failure_reason` 의 코드로 구분된다. 다시 보낼지는 호출부가 정한다.
- 발신 표시 이름은 `WHALE ERP` 고정.

### 4. 이력 기록 실패

메일은 이미 나갔으므로 예외를 던지지 않는다. 던지면 호출부는 실패로 보고 다시
발급·발송할 수 있다 — 이력 한 줄이 빠지는 것보다 메일이 두 번 가는 것이 더 나쁘다.
`logger.error` 에 템플릿 코드와 가린 주소를 남긴다.

### 트랜잭션

DB 트랜잭션 안에서 부르지 않는다. 롤백돼도 메일은 이미 나간다. 호출부는 커밋 뒤
`send()` 한다. 서비스 주석과 okf 문서에 적는다.

### 로그

애플리케이션 로그에는 템플릿 코드, `messageId`, 가린 주소(`h***@example.com`)만
남긴다. 본문은 남기지 않는다.

## 설정

- `MAIL_USERNAME`, `MAIL_PASSWORD` — 비면 `MailModule` 생성 때 예외(기동 중단).
  `.env.example` 에 키만 추가한다.
- `smtp.gmail.com:465`, `secure: true`, `connectionTimeout` · `socketTimeout` 30초
  (기본값은 2분·10분이라 Gmail 이 멈추면 호출부가 그만큼 묶인다).

## 파일

```
src/mail/
  mail.config.ts            MAIL_* 읽기·검증
  mail.config.spec.ts
  render-template.ts        검증 + 치환 + 이스케이프 + 가림 (순수)
  render-template.spec.ts
  mail.service.ts           조회 → 렌더 → 발송 → 이력
  mail.service.spec.ts
  mail.module.ts            transport · config 프로바이더
okf/api/mail.md             개념 문서 (+ okf/index.md, okf/log.md)
.env.example                MAIL_USERNAME= · MAIL_PASSWORD=
package.json                nodemailer
```

## 테스트

TDD. 단위 테스트만 둔다 — HTTP 경로가 없어 e2e 대상이 없고, 실제 Gmail 발송은
자동 테스트에 넣지 않는다.

- `render-template.spec.ts`
  - 제목·본문 치환, 같은 변수 여러 번
  - 본문 값 이스케이프, 제목 값은 그대로
  - 필수 변수 누락 · 템플릿에 없는 변수 · 템플릿에 없는 가림 이름 → 예외
  - 가림: 지정 변수만 `********`, 제목에도 적용
- `mail.service.spec.ts` (Prisma · transport mock)
  - 템플릿 없음 · 비활성 · 채널 불일치 · 주소 형식 → 예외, transport · 이력 호출 없음
  - 성공 → `SUCCEEDED` 행의 각 컬럼
  - SMTP 실패 → `FAILED` 행 + `failure_reason`, 원래 예외 재던짐
  - 성공 뒤 이력 INSERT 실패 → 예외 없이 `messageId` 반환
- `mail.config.spec.ts` — 키가 비면 예외

## 범위 밖

- **시드 템플릿 본문.** EMAIL 템플릿의 `body` 는 아직 일반 텍스트이고 `#{링크}` 가
  본문에 없다. 이대로 보내면 줄바꿈이 사라지고 링크가 빠진다. 에디터로 HTML 을
  넣거나 새 마이그레이션으로 바꾸기 전에는 실제 발송에 쓸 수 없다 — okf 에 적는다.
- 메일 에디터, 템플릿 관리 API.
- 알림톡의 DB 템플릿 전환과 렌더 공용화.
- 직원 앱 계정(`accounts`) 수신자 연결 — `mail_send_logs` 에 자리가 없어
  `admin_account_id` NULL 로 `to_email` 만 남는다.
- 반송·수신 결과 추적, 재시도, 발송 큐.
- `AppModule` 연결 — 첫 사용처가 생길 때.
