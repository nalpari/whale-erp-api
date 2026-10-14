---
type: API
title: Inquiry and lead handling
description: 커뮤니티 관리의 문의사항 · 도입문의 처리 — 플랫폼 관리자가 처리중으로 바꾸고 답변 · 내부 메모를 저장한다. 동시 저장은 읽은 updatedAt 을 조건으로 건 UPDATE 로 막고, 문의 첫 답변만 등록자에게 운영 알림과 메일을 보낸다.
tags: [community, inquiry, lead, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-14T00:30:51Z }
sources:
  - id: inquiries-service
    resource: ../../src/inquiries/inquiries.service.ts
    title: InquiriesService (startProcessing · reply · saveInternalMemo)
    last_modified: 2026-10-14T00:30:51Z
  - id: inquiries-controller
    resource: ../../src/inquiries/inquiries.controller.ts
    title: /inquiries (platform admin only)
    last_modified: 2026-10-14T00:12:16Z
  - id: leads-admin-service
    resource: ../../src/leads/leads-admin.service.ts
    title: LeadsAdminService (startProcessing · reply · saveInternalMemo)
    last_modified: 2026-10-14T00:12:16Z
  - id: leads-admin-controller
    resource: ../../src/leads/leads-admin.controller.ts
    title: /leads 관리자 경로 (platform admin only)
    last_modified: 2026-10-14T00:12:16Z
  - id: admin-web-url
    resource: ../../src/common/admin-web-url.ts
    title: ADMIN_WEB_URL — 메일 버튼 주소
    last_modified: 2026-10-14T00:12:16Z
  - id: updated-at
    resource: ../../src/common/updated-at.ts
    title: IsUpdatedAt · sameMillisecond (공지 · FAQ 와 같이 씀)
    last_modified: 2026-10-14T00:30:51Z
  - id: route-id
    resource: ../../src/common/route-id.ts
    title: parseRouteId — 범위 밖 ID 는 묻기 전에 404
    last_modified: 2026-10-14T00:12:16Z
  - id: save-internal-memo-dto
    resource: ../../src/common/save-internal-memo.dto.ts
    title: 내부 메모 요청 — 키 필수, null · 공백은 지움
    last_modified: 2026-10-14T00:30:51Z
---

# What it covers

Plane WHALEERP-274 — 관리자 웹 커뮤니티 관리에서 문의사항 · 도입문의를 처리하는 쓰기
경로. 목록 · 상세 조회(#332 의 문의 · 도입문의 부분)와 고객지원의 문의 등록 · 조회(#281)는
여기 없다. 모두 `@UserTypes('admin')` 이고, 플랫폼 관리자(PM · PA)가 아니면 403 이다 —
가드는 계정 상태를 보지 않아 `AdminScopeService.isPlatformAdmin` 이 다시 본다.

| 메서드 · 경로 | 하는 일 |
|---|---|
| `POST /inquiries/:inquiryId/processing` | 접수 → 처리중. 바꾼 관리자 · 시각(`processing_started_by` · `_at`)을 남긴다 |
| `POST /inquiries/:inquiryId/replies` | 답변 행을 더하고 답변 완료. 고칠 때도 같은 경로 |
| `PUT /inquiries/:inquiryId/internal-memo` | 내부 메모 |
| `POST /leads/:leadId/processing` | 접수 → 처리중 |
| `PUT /leads/:leadId/reply` | 답변을 덮어쓰고 답변 완료, 첫 답변 날 상담 완료일 |
| `PUT /leads/:leadId/internal-memo` | 내부 메모 |

응답은 모두 `{ inquiryId | leadId, status, updatedAt }` — 화면은 이 `updatedAt` 을 다음
저장에 보낸다.

# Traps

**처리중은 상태로, 답변 · 메모는 `updatedAt` 으로 겨룬다.** 처리중 전환은 `status = 'RECEIVED'`
를 조건에 건 UPDATE 라 본문이 없고, 둘이 동시에 눌러도 하나만 바뀐다. 답변과 메모는 읽은
`updatedAt` 을 조건에 건다 — 그사이 다른 운영자가 무엇이든 저장했으면 409 다(공지 · FAQ 와 같은
방식, 같은 ms 안이면 같은 값). 처리중을 거치지 않고 바로 답변해도 되고, 그러면 처리 시작 두 칸은
NULL 로 남는다(CHECK 가 둘을 함께 채우거나 함께 비우게 한다).

**처리중 전환도 `updatedAt` 을 바꾼다.** `@updatedAt` 칸이라 Prisma 가 모든 UPDATE 에서 새로 쓴다. 그래서
운영자 A 가 답변을 쓰는 사이 B 가 처리중을 누르면 A 의 저장은 409 다. 화면은 처리중 · 답변 · 메모 응답의
`updatedAt` 을 받을 때마다 갈아 끼워야 하고, 409 면 다시 읽는다. 문의 답변의 응답 상태는 행 잠금을 쥔 트랜잭션
안에서 읽는다 — 알림 · 메일(최대 수십 초)을 기다린 뒤에 읽으면 그사이 남이 저장한 `updatedAt` 을 돌려줘, 다음
저장이 409 없이 남의 저장을 덮는다.

**내부 메모는 키를 빼먹을 수 없다.** `internalMemo` 가 없으면 400 이고, `null` · 빈 문자열 · 공백만 보내면
지운다. 빠진 키를 「지움」으로 읽으면 칸을 빼먹은 요청이 메모를 지운다.

**알림은 첫 답변 때 한 번뿐이다.** 문의 답변을 고치면 `inquiry_replies` 에 새 행이 더해져 이전
답변 · 고친 시각 · 고친 운영자가 남지만, 상태는 답변 완료 그대로이고 다시 알리지 않는다(운영 정책
CNT-17). 「첫 답변」은 저장 전 상태가 답변 완료가 아니었는지로 가른다. 운영 알림의 `eventKey` 도
문의 ID 라 같은 문의로 두 번 만들어지지 않는다.

**운영 알림과 메일은 따로 보낸다.** `notify(NTF_INQUIRY_ANSWERED)` 는 메일을 붙이지 않으므로
(NTF-03, [Operations notifications](/api/notifications-api.md)) `MailService.send(EMAIL_INQUIRY_ANSWERED)`
를 따로 부른다. 둘 다 커밋 뒤에 보내고, 받는 사람 조회의 DB 오류까지 포함해 무엇이 실패해도 답변 저장은 성공이다(실패는 Prisma 메시지 대신 오류 코드로 로그에 남는다) — 알림이 못 갔다고 운영자가
답변을 다시 쓰게 하지 않는다. 받는 사람은 문의를 등록한 사업자 관리자이므로 알림 · 메일 버튼은
고객지원 쪽 상세 `/support/inquiries/{id}` 로 간다(플랫폼 쪽 `/platform/community/...` 가 아니다).

**메일은 설정이 둘 다 있어야 나간다.** `MAIL_*` 가 비면 `OPTIONAL_MAIL_SERVICE` 가 null 이고,
`ADMIN_WEB_URL` 이 비면 버튼 링크(필수 변수)를 만들 수 없다. 어느 쪽이든 api 는 뜨고 그 메일만
warn 로그로 건너뛴다. `ADMIN_WEB_URL` 이 웹 주소가 아니면 기동 때 던진다. 등록자가 사용 중이 아니거나
이메일이 없으면 메일 · 알림 모두 받는 사람이 없다.

**도입문의 답변은 아직 문의자에게 메일로 가지 않는다.** Plane 은 「문의자가 적은 이메일로만
보낸다」인데 쓸 템플릿이 없다 — `EMAIL_LEAD_ANSWERED` 는 꺼져 있고 운영자에게 「처리 상태 변경」을
알리는 문구라 답변 본문 변수도 없다. 템플릿이 정해지면 `LeadsAdminService.reply` 의 저장 뒤에 더한다.

**상담 완료일은 처음 한 번만 쓴다.** 1년 뒤 파기(`lead-purge`)의 기준이라 답변을 고칠 때 오늘로
다시 쓰면 파기가 밀린다. 날짜는 한국 날짜다(`kstToday`).

**`/leads` 에 컨트롤러가 둘이다.** 접수(`LeadsController`)는 `@Public()` 과 IP 한도가 붙은 공개
경로라, 관리자 경로는 `LeadsAdminController` 로 나눠 그것을 물려받지 않게 했다. 둘을 합치면
누구나 답변을 쓸 수 있게 된다.

# Verification

단위 테스트 `src/inquiries/*.spec.ts` · `src/leads/leads-admin.*.spec.ts`, e2e
`test/inquiries.e2e-spec.ts`. e2e 의 「같은 updatedAt 으로 동시에 답변」은 실제 PostgreSQL 에서만
증명된다 — PGlite 소켓 서버는 연결을 하나만 받아 두 번째 동시 연결을 끊는다(공지 · FAQ 의 동시 수정
e2e 도 같다). 순서대로 보내면 두 번째가 409 인 것은 PGlite 에서도 확인된다.
