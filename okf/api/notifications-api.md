---
type: API
title: Operations notifications
description: 운영 알림 — 업무 쪽이 부르는 공통 함수 OpsNotificationService.notify와 수신자 판정 셋, 관리자 웹 운영 알림함 API(GET /notifications · 읽음 · 모두 읽음 · 선택 삭제).
tags: [notifications, admin, inbox, template]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-14T00:31:01Z }
sources:
  - id: ops-notification-service
    resource: ../../src/notifications/ops-notification.service.ts
    title: OpsNotificationService.notify — 공통 생성 함수
    last_modified: 2026-10-14T00:31:01Z
  - id: recipients
    resource: ../../src/notifications/recipients.ts
    title: platformOperators · storeManagers · activeAdmin
    last_modified: 2026-10-13T06:00:00Z
  - id: notifications-service
    resource: ../../src/notifications/notifications.service.ts
    title: 운영 알림함 목록 · 읽음 · 모두 읽음 · 삭제
    last_modified: 2026-10-13T06:00:00Z
  - id: notifications-controller
    resource: ../../src/notifications/notifications.controller.ts
    title: /notifications (admin only)
    last_modified: 2026-10-13T06:00:00Z
  - id: plan
    resource: ../../docs/plans/2026-10-13-ops-notifications.md
    title: 운영 알림 API 계획
    last_modified: 2026-10-13T06:00:00Z
---

# 운영 알림

운영 알림 묶음(Plane #244 · #245) 가운데 공통 부분만 이 모듈이 맡는다. 사건을 알아채 알림을 부르는 일은 각 업무
일감이 맡는다(#247, 2026-10-13 재영) — 이 모듈은 배치 · 계약 · 문의 처리를 건드리지 않는다. 유형마다 함수를 두지
않는다. 유형이 늘면 템플릿만 등록하고 같은 함수를 부른다.

# 업무 쪽이 부르는 법

`NotificationsModule` 을 import 하고 `OpsNotificationService` 를 주입한다. **업무 트랜잭션이 커밋된 뒤에** 부른다
— 안에서 부르면 알림 쪽 오류가 업무를 되돌릴 수 있다. `notify` 는 어떤 실패에도 던지지 않고 서버 로그에 남긴다
(운영 정책 NTF-08). 결과를 기다릴 필요도 없다.

```ts
await this.opsNotification.notify({
  templateCode: 'NTF_CONTRACT_SIGNED',
  variables: { 직원이름: staff.name, 근무지: store.name }, // 템플릿 variables 이름 그대로
  related: { type: 'CONTRACT', id: contract.contractId },
  link: `/contracts/${contract.contractId}`,           // 눌러서 갈 내 화면 — 업무 쪽이 정한다
  eventKey: String(history.contractStatusHistoryId),     // 사건마다 하나인 값
  recipients: await storeManagers(this.prisma, contract.staffMemberId),
});
```

- **링크**는 알림을 만드는 업무 쪽이 자기 관리자 웹 화면 경로를 넘긴다(NOTIFY-16, 2026-10-13 재영). 운영 알림 쪽은 업무
  화면 경로를 모른다. `/` 로 시작하는 관리자 웹 안의 경로만 받고(`//` · 바깥 주소 · 백슬래시 · 공백은 버리고 warn
  로그, 알림은 만든다 — DB CHECK `notifications_link_internal_path` 도 같다), 갈 화면이 없으면 빼면 된다. 알림함 · 종은
  `/notifications/{id}/open` 에서 읽음 처리한 뒤 이 링크로 간다.
- **받는 사람**은 `src/notifications/recipients.ts` 의 셋으로 만든다(운영 정책 NTF-04). 규칙은 그 안에만 있다.
  - `platformOperators(prisma)` — 사용 중인 플랫폼 마스터 · 플랫폼 관리자
  - `storeManagers(prisma, staffMemberId)` — 그 직원 근무지 BP 의 사업자 관리자 가운데 전체 점포이거나 그 점포가
    매핑된 사람. 가맹 점포면 BP 마스터 · BP 관리자는 그 직원이 본사 제공에 동의했을 때만 받는다(`hidesPersonalData`
    기준, NOTIFY-13 2026-10-13 재영). api #21 이 그 함수에 동의 인자를 더하면 셋째 인자로 넘긴다
  - `activeAdmin(prisma, adminAccountId)` — 그 한 사람이 사용 중이면 `[id]`
- **중복**: `dedupe_key = {템플릿 코드}:{eventKey}` 에 부분 유일 인덱스가 있다. 같은 사건으로 두 번 부르면 두 번째는
  만들지 않는다(NTF-05). 같은 대상에서 되풀이되는 사건(재발송 뒤 다시 만료)은 상태 이력 ID 처럼 사건마다 다른
  값을 넘긴다.
- **문구**는 `notification_templates` 의 NOTIFICATION 채널 템플릿에서 읽어 알림에 박아 둔다. 템플릿을 고쳐도 이미 만든
  알림은 바뀌지 않는다. 템플릿이 없거나 꺼졌거나 읽다 실패하거나 필수 변수가 비면 만들지 않고 서버 로그만 남긴다
  (NOTIFY-15 2026-10-13 재영, 운영 정책 NTF-25).
- **받는 사람이 없으면** 만들지 않고 warn 로그를 남긴다.
- **메일은 붙이지 않는다**(운영 정책 NTF-03 v114, 2026-10-13 재영). 운영 알림 · 메일 · 둘 다 가운데 무엇을 보낼지는
  업무 쪽이 정하고, 메일이 필요하면 `MailService.send` 를 따로 부른다([Mail](/api/mail.md)). 메일 버튼은
  `ADMIN_WEB_URL + 업무 경로` 로 바로 가고, 메일로 봐도 알림함 읽음은 맞추지 않는다. #249(짝 메일)는 취소했다.

| 템플릿 코드 | 사건 키 | 받는 사람 | 부르는 업무 일감 |
|---|---|---|---|
| `NTF_INQUIRY_RECEIVED` | 문의 ID | `platformOperators` | #281 |
| `NTF_LEAD_RECEIVED` | 도입문의 ID | `platformOperators` | #296 |
| `NTF_INQUIRY_ANSWERED` | 문의 ID (첫 답변만, 고칠 때는 부르지 않음 — CNT-17) | `activeAdmin(문의 등록자)` | #274 |
| `NTF_LEAD_ANSWERED` | 상태 변경 이력 ID | `platformOperators` | 맡은 일감 없음 |
| `NTF_CONTRACT_SIGNED` · `NTF_CONTRACT_REJECTED` · `NTF_CONTRACT_EXPIRED` | 상태 이력 ID | `storeManagers(계약 직원 레코드)` | #154 |
| `NTF_CONTRACT_RENEWAL_DUE` | 계약 ID (계약당 한 번) | `storeManagers(계약 직원 레코드)` | #152 · #154 |
| `NTF_LINK_HOLD` | 보류 ID | `activeAdmin(contracts.created_by)` | #137 |
| `NTF_AFFILIATION_REJECTED` | 초대 ID | `activeAdmin(contracts.created_by)` | 맡은 일감 없음 |

`related.type` 은 `CONTRACT` · `INQUIRY` · `LEAD` · `STAFF_MEMBER` 다(`src/notifications/related-type.ts`). 가입 연결
보류 · 소속 추가 확인 거절은 직원 레코드를 가리킨다. 화면의 「관련 업무 #41」 표시와 중복 방지에 쓰고, 갈 곳은 `link` 가 정한다.

# 제목

템플릿의 제목을 `notifications.title`, 둘째 줄을 `body` 에 박아 둔다(NOTIFY-12 2026-10-13 재영,
`20261013144718_team3_notification_title`). 알림함 목록 · 종 팝오버가 제목을 쓴다. 운영 알림은 열 가지뿐이고, 만 19세
미만 가입 불가 · 직원 자료 일괄 저장 완료 · 실패는 운영 알림이 아니라 각 화면 상태로 보인다(NOTIFY-14).

# 운영 알림함 API

모두 관리자 웹 전용(`@UserTypes('admin')`)이고 늘 로그인한 관리자가 받은 행(`admin_account_id = 나`, 지우지 않은 것)만
다룬다. 가드가 계정 사용 여부를 보지 않아 서비스가 다시 확인한다 — 사용 중이 아니면 403.

| 메서드 · 경로 | 응답 |
|---|---|
| `GET /notifications?page&pageSize` | `{ items, total, unreadCount }`. 최신순. 종 팝오버는 `pageSize=5` |
| `POST /notifications/:id/read` | 그 한 줄(갈 곳 `relatedType` · `relatedId` 포함). 이미 읽었으면 읽은 시각을 그대로 둔다. 남의 것 · 지운 것은 404 |
| `POST /notifications/read-all` | `{ updated }` — 내 미확인만 |
| `DELETE /notifications?ids=1,2` | 204. 받은 사람별 지운 표시. 남의 ID 는 조용히 빠진다 |

한 줄의 `id` 는 받는 사람별 행(`notification_recipient_id`)이다. `kind` 는 지금 템플릿 이름이고 템플릿이 없으면
템플릿 코드다. `link` 는 알림을 만든 업무 쪽이 정한 관리자 웹 경로다.

# 검증

단위 테스트는 `src/notifications/*.spec.ts`. `test/notifications.e2e-spec.ts` 는 실제 DB 로 수신자 판정의 관계
조건 · 중복 방지 인덱스 · 읽음 · 삭제를 본다. PGlite 소켓 서버에서는 「같은 사건으로 다시 부르면」이 실패한다 —
유일 위반으로 트랜잭션이 깨진 뒤 응답 순서가 어긋나는 PGlite 의 한계라, 실제 PostgreSQL 에서 돌린다.
