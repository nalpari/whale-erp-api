---
type: API
title: Notification templates
description: 알림 템플릿 관리 — 플랫폼 운영자가 운영 알림 · 앱 푸시 · 메일 · 알림톡 문구를 보고 · 고치고 · 등록하고 · 끄고 · 기본 문구로 되돌리는 /notification-templates.
tags: [notifications, templates, admin, platform]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-30T04:48:59Z }
sources:
  - id: reject-notices-without-reason
    resource: ../../prisma/migrations/20261030120100_team3_reject_notices_without_reason/migration.sql
    title: 근로계약 거부 · 소속 추가 거절 알림 4건에서 사유 줄 · 변수를 뺌 (WHALEERP-635)
    last_modified: 2026-10-30T10:00:00Z
  - id: wording-cleanup
    resource: ../../prisma/migrations/20261030093710_team3_notification_template_wording/migration.sql
    title: 기본 문구 42건을 「알림톡_템플릿_20261029.xlsx」 새 문구로 (운영자가 고친 문구는 그대로)
    last_modified: 2026-10-30T00:40:00Z
  - id: payslip-resent-same-wording
    resource: ../../prisma/migrations/20261021100935_team3_payslip_resent_same_wording/migration.sql
    title: 급여명세서 다시 발송 두 템플릿을 처음 발송 문구와 같게 (NOTI-6)
    last_modified: 2026-10-21T01:10:50Z
  - id: staff-signup-template
    resource: ../../prisma/migrations/20261021103042_team3_staff_signup/migration.sql
    title: 42번째 기본 템플릿 NTF_SIGNUP_UNDER_AGE(가입 불가 — 만 19세 미만, default_* 도 채움)
    last_modified: 2026-10-21T01:30:58Z
  - id: lead-reply-mail-template
    resource: ../../prisma/migrations/20261015140832_team3_lead_reply_mail_template/migration.sql
    title: 41번째 기본 템플릿 EMAIL_LEAD_REPLY — default_* 를 같은 INSERT 에서 채움
    last_modified: 2026-10-15T06:30:00Z
  - id: excel-mail-templates
    resource: ../../prisma/migrations/20261028140448_team1_excel_download_logs/migration.sql
    title: 공통 엑셀 완료 · 실패 메일 기본 템플릿 2건
    last_modified: 2026-10-28T10:30:00Z
  - id: service
    resource: ../../src/notification-templates/notification-templates.service.ts
    title: 목록 · 상세 · 등록 · 수정 · 되돌리기 · 사용 여부
    last_modified: 2026-10-29T05:17:36Z
  - id: validate
    resource: ../../src/notification-templates/validate-template.ts
    title: 저장 검사(validateTemplate)
    last_modified: 2026-10-30T04:48:59Z
  - id: controller
    resource: ../../src/notification-templates/notification-templates.controller.ts
    title: /notification-templates (플랫폼 관리자만)
    last_modified: 2026-10-29T05:17:36Z
  - id: plan
    resource: ../../docs/plans/2026-10-13-notification-templates.md
    title: 알림 템플릿 관리 API 계획
    last_modified: 2026-10-13T07:30:00Z
---

# 알림 템플릿 관리

문구의 운영 원본은 `notification_templates` 다. 메일 · 알림톡 · 운영 알림은 발송할 때마다 `findSendableTemplate` 으로 이 표를
읽고 `renderTemplate` 으로 채운다. 이 API 는 그 표를 플랫폼 마스터 · 플랫폼 관리자가 관리자 웹에서 고치게 한다
(WHALEERP-572 · 573 · 581). 다른 관리자는 403. 지우는 길은 없고 사용 여부로 끈다(운영 정책 NTF-21).

| 메서드 · 경로 | 하는 일 |
|---|---|
| `GET /notification-templates?channel=&page=&pageSize=` | 채널 탭 하나. 템플릿 코드순 `{ items, total }` |
| `GET /notification-templates/:id` | 상세 + 변수 목록 + 변경 이력(최근 것부터, 「제목 · 본문」처럼 바뀐 것 요약) |
| `POST /notification-templates` | 등록. 기본 문구가 없다 |
| `PUT /notification-templates/:id` | 모든 칸 수정(NOTIFY-10). 읽은 `updatedAt` 이 다르면 409 |
| `POST /notification-templates/:id/restore` | 기본 문구로 되돌리기 — 제목 · 본문 · 변수 목록만(NOTIFY-18). 기본 문구가 없으면 409. 채널이 바뀌어 기본 문구가 지금 채널 규칙에 맞지 않으면 400 으로 되돌리지 않는다 |
| `PATCH /notification-templates/:id/active` | 사용 / 사용 안 함 |

- **고칠 때마다 바뀌기 전 행 전체를 `notification_template_histories` 에 남긴다** — 수정 · 되돌리기 · 사용 여부 모두. 한
  트랜잭션에서 이력을 쓰고, 고치기가 0건(그사이 누가 고침)이면 함께 되돌린다.
- **기본 문구**는 기본 템플릿 46건(처음 넣은 40건과 뒤에 더한 `EMAIL_LEAD_REPLY` · `NTF_SIGNUP_UNDER_AGE` · `TALK_STAFF_AFFILIATION_REQUEST` · `EMAIL_STAFF_AFFILIATION_REQUEST` · `EMAIL_EXCEL_READY` · `EMAIL_EXCEL_FAILED`)의 `default_title` · `default_body` · `default_variables` 다(NOTIFY-17). 목록 · 상세의
  `hasDefault` 가 되돌리기 단추를 보일지 정한다. 채널이 바뀌어 기본 문구가 지금 채널 규칙에 맞지 않으면 400 으로 되돌리지
  않는다(NOTIFY-18).
- **급여명세서를 다시 보내도 처음 발송과 같은 문구다**(쟁점 NOTI-6, 2026-10-20 재영 · 운영 정책 NTF-20).
  `20261021100935_team3_payslip_resent_same_wording` 이 `PUSH_PAYSLIP_RESENT` · `EMAIL_PAYSLIP_RESENT` 의 기본 문구를
  `PUSH_PAYSLIP_SENT` · `EMAIL_PAYSLIP_SENT` 의 기본 문구로 바꾸고(앱 푸시 변수에 `#{근무지}` 가 더해진다), 지금 문구는
  제목 · 본문 · 변수 목록이 셋 다 옛 기본값일 때만 같이 바꾼다 — 운영자가 고친 문구는 그대로 둔다. 코드 · 이름 · 채널 ·
  수신 설정 묶음 · 사용 여부는 그대로다.
- **기본 문구 정리**(2026-10-29 노영주, 「알림톡_템플릿_20261029.xlsx」 — 카카오 심사 전 문구 다듬기 포함).
  `20261030093710_team3_notification_template_wording` 이 기본 템플릿 46건 중 42건의 `default_title` · `default_body` 를 새 문구로
  바꾸고, 엑셀에 없는 4건(`EMAIL_EXCEL_READY` · `EMAIL_EXCEL_FAILED` · `TALK_STAFF_AFFILIATION_REQUEST` · `EMAIL_STAFF_AFFILIATION_REQUEST`)은
  건드리지 않는다. `default_variables` 는 `NTF_AFFILIATION_REJECTED` · `EMAIL_AFFILIATION_REJECTED` 두 건만 바뀐다 — 선택 변수
  `#{거절사유}`(`isRequired: false`)가 더해진다. 소속 추가 거절 발송은 `거절사유` 를 넘기지 않아 빈칸으로 렌더됐고, 곧이은
  `20261030120100_team3_reject_notices_without_reason`(WHALEERP-635 — 두 거절 모두 사유를 받지 않는다)이 이 두 건의 「- 거절 사유」 줄과
  변수를 다시 뺀다. 같은 마이그레이션이 근로계약 거부 두 건의 「- 거부 사유」 줄도 걷는다 — 운영 알림은 그 자리를 「- 근무지: #{근무지}」로
  바꾸고 변수도 근무지(필수)로 바뀐다. 이 네 건은 운영자가 고친 문구도 덮어쓴다([근로계약 API](/api/contracts-api.md)).
  `TALK_STAFF_INVITATION` 의 제목은 null 그대로다. 지금 문구(`title` · `body` · `variables`)는 셋 다 옛 기본값 그대로일 때만 같이
  바꾸고(운영자가 고친 문구는 그대로), 되돌리기 원본은 늘 바꾼다. 코드 · 이름 · 채널 · 수신 설정 묶음 · 사용 여부 · 카카오 템플릿
  코드는 그대로이고 변경 이력은 남기지 않는다.
  예외로 `PUSH_PAYSLIP_RESENT` · `EMAIL_PAYSLIP_RESENT` 는 엑셀의 재발송 문구 대신 `PUSH_PAYSLIP_SENT` · `EMAIL_PAYSLIP_SENT` 의 새 문구를 따른다 — 다시 보내도 처음 발송과 같은 문구(NTF-20 유지, 2026-10-29 노영주).
- **템플릿 코드**는 고칠 수 있다. 형식(`^[A-Z][A-Z0-9_]*$`)과 고유만 보고 겹치면 409. 채널을 바꿔도 코드가 저절로 바뀌지
  않는다. 발송 코드가 이 값으로 부르므로 화면이 「발송 코드도 함께 바꿔야 합니다」 확인을 받는다.

# 저장 검사 (`validateTemplate`)

등록 · 수정 모두 400 과 고칠 문장 목록(`message` 배열)을 준다. 발송 때의 `renderTemplate` 과 같은 규칙을 저장 쪽에서 먼저
막아, 운영자가 고친 템플릿 때문에 발송이 멈추지 않게 한다.

- 채널별: 운영 알림 · 앱 푸시 · 메일은 제목 · 본문 필수, 알림톡은 제목 없이 본문 · 카카오 템플릿 코드 필수(NTF-22 · 23).
  수신 설정 묶음은 앱 푸시만. 앱 푸시는 제목 40자 · 본문 100자(NOTIFY-4).
- 변수 목록: 이름 필수 · 겹치지 않음 · `#` · 중괄호 · 공백 없음, 표시 이름 필수, 50개까지. 「버튼 링크」(`isButtonLink`)는
  메일 · 알림톡 변수에만(NOTIFY-20). 알림톡은 버튼 링크 변수를 하나까지만 — 카카오에 등록한 버튼 하나만 싣고 둘 이상이면 발송이
  보내기 전에 던진다. 버튼 링크가 있으면 그 템플릿 코드의 버튼 이름이 코드(`ALIMTALK_BUTTON_NAMES`)에 있어야 한다 — 없으면
  「이 템플릿 코드는 알림톡 버튼 이름이 정해지지 않아 버튼 링크를 쓸 수 없습니다. …」(WHALEERP-636, `alimtalkButtonProblem`,
  [Kakao Alimtalk](/api/alimtalk.md)). 이미 저장된 행은 다음 저장 때 막힌다.
- 제목 · 본문의 `#{…}` 가 모두 목록 안에 있는지, 닫히지 않은 `#{` 가 없는지 — 「본문 2번째 줄: …」처럼 위치를 알려 준다.
  필수 변수(버튼 링크 제외)는 제목 · 본문 어딘가에 있어야 한다.
- NUL 은 받지 않는다.

# 발송 쪽 규칙

템플릿이 없거나 · 사용 안 함이거나 · 읽다 실패하면 채널과 상관없이 보내지 않고 서버 로그를 남기며 부른 쪽에 실패를 알린다.
기본 문구로 대신 보내지 않는다(운영 정책 NTF-25, NOTIFY-19 2026-10-13 재영). 이미 만든 운영 알림은 템플릿을 고쳐도 바뀌지 않는다.
