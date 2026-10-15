---
type: API
title: Notification templates
description: 알림 템플릿 관리 — 플랫폼 운영자가 운영 알림 · 앱 푸시 · 메일 · 알림톡 문구를 보고 · 고치고 · 등록하고 · 끄고 · 기본 문구로 되돌리는 /notification-templates.
tags: [notifications, templates, admin, platform]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-15T06:30:00Z }
sources:
  - id: lead-reply-mail-template
    resource: ../../prisma/migrations/20261015140832_team3_lead_reply_mail_template/migration.sql
    title: 41번째 기본 템플릿 EMAIL_LEAD_REPLY — default_* 를 같은 INSERT 에서 채움
    last_modified: 2026-10-15T06:30:00Z
  - id: service
    resource: ../../src/notification-templates/notification-templates.service.ts
    title: 목록 · 상세 · 등록 · 수정 · 되돌리기 · 사용 여부
    last_modified: 2026-10-13T07:30:00Z
  - id: validate
    resource: ../../src/notification-templates/validate-template.ts
    title: 저장 검사(validateTemplate)
    last_modified: 2026-10-13T07:30:00Z
  - id: controller
    resource: ../../src/notification-templates/notification-templates.controller.ts
    title: /notification-templates (플랫폼 관리자만)
    last_modified: 2026-10-14T05:00:00Z
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
- **기본 문구**는 기본 템플릿 41건(처음 넣은 40건과 뒤에 더한 `EMAIL_LEAD_REPLY`)의 `default_title` · `default_body` · `default_variables` 다(NOTIFY-17). 목록 · 상세의
  `hasDefault` 가 되돌리기 단추를 보일지 정한다. 채널이 바뀌어 기본 문구가 지금 채널 규칙에 맞지 않으면 400 으로 되돌리지
  않는다(NOTIFY-18).
- **템플릿 코드**는 고칠 수 있다. 형식(`^[A-Z][A-Z0-9_]*$`)과 고유만 보고 겹치면 409. 채널을 바꿔도 코드가 저절로 바뀌지
  않는다. 발송 코드가 이 값으로 부르므로 화면이 「발송 코드도 함께 바꿔야 합니다」 확인을 받는다.

# 저장 검사 (`validateTemplate`)

등록 · 수정 모두 400 과 고칠 문장 목록(`message` 배열)을 준다. 발송 때의 `renderTemplate` 과 같은 규칙을 저장 쪽에서 먼저
막아, 운영자가 고친 템플릿 때문에 발송이 멈추지 않게 한다.

- 채널별: 운영 알림 · 앱 푸시 · 메일은 제목 · 본문 필수, 알림톡은 제목 없이 본문 · 카카오 템플릿 코드 필수(NTF-22 · 23).
  수신 설정 묶음은 앱 푸시만. 앱 푸시는 제목 40자 · 본문 100자(NOTIFY-4).
- 변수 목록: 이름 필수 · 겹치지 않음 · `#` · 중괄호 · 공백 없음, 표시 이름 필수, 50개까지. 「버튼 링크」(`isButtonLink`)는
  메일 · 알림톡 변수에만(NOTIFY-20).
- 제목 · 본문의 `#{…}` 가 모두 목록 안에 있는지, 닫히지 않은 `#{` 가 없는지 — 「본문 2번째 줄: …」처럼 위치를 알려 준다.
  필수 변수(버튼 링크 제외)는 제목 · 본문 어딘가에 있어야 한다.
- NUL 은 받지 않는다.

# 발송 쪽 규칙

템플릿이 없거나 · 사용 안 함이거나 · 읽다 실패하면 채널과 상관없이 보내지 않고 서버 로그를 남기며 부른 쪽에 실패를 알린다.
기본 문구로 대신 보내지 않는다(운영 정책 NTF-25, NOTIFY-19 2026-10-13 재영). 이미 만든 운영 알림은 템플릿을 고쳐도 바뀌지 않는다.
