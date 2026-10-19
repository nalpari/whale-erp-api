---
type: API
title: Inquiry and lead handling
description: 고객지원 문의하기(본인 문의 등록 · 목록 · 상세, 첨부, 5분 중복 409)와 커뮤니티 관리의 문의사항 · 도입문의 목록 · 상세와 처리 — 목록은 답변 대기(접수 · 처리중) · 답변 완료로 거르고, 플랫폼 관리자가 처리중으로 바꾸고 답변 · 내부 메모를 저장하며, 상담하지 않은 도입문의는 지운다. 동시 저장은 읽은 updatedAt 을 조건으로 건 UPDATE 로 막고, 문의 첫 답변만 등록자에게 운영 알림과 메일을 보낸다. 도입문의는 접수 때 운영자 알림과 문의자 접수 확인 메일, 첫 답변 때 문의자 답변 메일을 보내고, 운영자가 그 메일을 1분에 한 번 다시 보낼 수 있다.
tags: [community, inquiry, lead, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-19T01:52:57Z }
sources:
  - id: lead-reply-mail-result
    resource: ../../prisma/migrations/20261019102805_team3_lead_reply_mail_result/migration.sql
    title: 도입문의 마지막 답변 메일 결과 · 시각 (#597)
    last_modified: 2026-10-19T01:52:57Z
  - id: support-inquiries-service
    resource: ../../src/inquiries/support-inquiries.service.ts
    title: SupportInquiriesService (create · list · get · attachmentDownloadUrl) — 고객지원 문의하기 (#281)
    last_modified: 2026-10-19T01:25:03Z
  - id: support-inquiries-controller
    resource: ../../src/inquiries/support-inquiries.controller.ts
    title: /support-inquiries (문의하기 MN000036 메뉴 권한)
    last_modified: 2026-10-16T05:42:37Z
  - id: lead-reply-without-name
    resource: ../../prisma/migrations/20261015164811_team3_lead_reply_without_name/migration.sql
    title: EMAIL_LEAD_REPLY 에서 문의자이름을 뺌 (CNT-11 v134)
    last_modified: 2026-10-16T01:20:15Z
  - id: lead-created-at-index
    resource: ../../prisma/migrations/20261015164900_team3_lead_created_at_index/migration.sql
    title: leads (created_at) 조회 인덱스 — 접수 확인 메일 시간당 상한
    last_modified: 2026-10-15T08:14:00Z
  - id: lead-confirmation-fixed-wording
    resource: ../../prisma/migrations/20261015155556_team3_lead_confirmation_fixed_wording/migration.sql
    title: EMAIL_LEAD_CONFIRMATION 고정 문구 · 변수 없음 (api #50 리뷰)
    last_modified: 2026-10-15T07:00:00Z
  - id: inquiries-service
    resource: ../../src/inquiries/inquiries.service.ts
    title: InquiriesService (list · get · attachmentDownloadUrl · startProcessing · reply · saveInternalMemo)
    last_modified: 2026-10-15T06:10:00Z
  - id: inquiries-controller
    resource: ../../src/inquiries/inquiries.controller.ts
    title: /inquiries (platform admin only)
    last_modified: 2026-10-14T08:14:22Z
  - id: leads-admin-service
    resource: ../../src/leads/leads-admin.service.ts
    title: LeadsAdminService (list · get · startProcessing · reply · resendReplyMail · saveInternalMemo · remove)
    last_modified: 2026-10-19T01:52:57Z
  - id: lead-notifications
    resource: ../../src/leads/lead-notifications.ts
    title: deleteLeadNotifications · notifyLeadOperators · leadContact — 도입문의 운영 알림 만들기와 지우기
    last_modified: 2026-10-15T06:30:00Z
  - id: leads-service
    resource: ../../src/leads/leads.service.ts
    title: LeadsService.create — 접수 뒤 운영 알림 · 접수 확인 메일 (#296)
    last_modified: 2026-10-15T08:37:00Z
  - id: lead-reply-mail-migration
    resource: ../../prisma/migrations/20261015140832_team3_lead_reply_mail_template/migration.sql
    title: EMAIL_LEAD_REPLY 기본 템플릿 (#588)
    last_modified: 2026-10-15T05:20:00Z
  - id: leads-admin-controller
    resource: ../../src/leads/leads-admin.controller.ts
    title: /leads 관리자 경로 (platform admin only)
    last_modified: 2026-10-19T01:52:57Z
  - id: admin-web-url
    resource: ../../src/common/admin-web-url.ts
    title: ADMIN_WEB_URL — 메일 버튼 주소(플랫폼 관리자 · BP 회원가입 메일과 같은 규칙 하나)
    last_modified: 2026-10-14T08:07:15Z
  - id: updated-at
    resource: ../../src/common/updated-at.ts
    title: IsUpdatedAt · sameMillisecond (공지 · FAQ 와 같이 씀)
    last_modified: 2026-10-15T08:46:31Z
  - id: route-id
    resource: ../../src/common/route-id.ts
    title: parseRouteId — 범위 밖 ID 는 묻기 전에 404
    last_modified: 2026-10-14T00:12:16Z
  - id: answer-status
    resource: ../../src/common/answer-status.ts
    title: 답변 대기 · 답변 완료 → InquiryStatus (API enum InquiryAnswerStatus)
    last_modified: 2026-10-14T02:04:13Z
  - id: admin-names
    resource: ../../src/common/admin-names.ts
    title: adminNames — 관리자 ID → 이름(공지 · FAQ 와 같이 씀)
    last_modified: 2026-10-14T02:04:13Z
  - id: contains-text
    resource: ../../src/common/contains-text.ts
    title: containsText — 검색어의 % · _ · \ 를 글자 그대로
    last_modified: 2026-10-14T05:24:07Z
  - id: save-internal-memo-dto
    resource: ../../src/common/save-internal-memo.dto.ts
    title: 내부 메모 요청 — 키 필수, null · 공백은 지움
    last_modified: 2026-10-14T00:46:03Z
---

# What it covers

Plane WHALEERP-274 · 332 · 590 — 관리자 웹 커뮤니티 관리에서 문의사항 · 도입문의를 보고 처리하는
경로. 공지사항 · FAQ 목록(#332 의 나머지)은 [Notices and FAQ management](/api/posts.md) 의 `GET /posts`
다. 고객지원의 문의 등록 · 조회(#281)는 아래 「Support side」의 `/support-inquiries` 다. 아래 표의 경로는 모두 `@UserTypes('admin')` 이고, 플랫폼 관리자(PM · PA)가 아니면 403 이다 —
가드는 계정 상태를 보지 않아 `AdminScopeService.isPlatformAdmin` 이 다시 본다.

| 메서드 · 경로 | 하는 일 |
|---|---|
| `GET /inquiries` | 목록. 접수 최신순, `answerStatus` · `title` · `sender`(보낸 곳) · `page` · `pageSize` |
| `GET /inquiries/:inquiryId` | 상세. 보낸 곳 · 답변 이력 · 첨부파일 정보 · 처리 이력 · 내부 메모 |
| `GET /inquiries/:inquiryId/attachments/:inquiryAttachmentId/download-url` | 첨부 내려받기 주소 `{ url }`. 300초 서명 주소, 원래 파일 이름으로 저장 |
| `GET /leads` | 목록. 접수 최신순, `answerStatus` · `page` · `pageSize` |
| `GET /leads/:leadId` | 상세. 운영 정책 CNT-12 의 문의자 정보 · 동의 일시 · 답변 · 처리 이력 · 내부 메모 |
| `POST /inquiries/:inquiryId/processing` | 접수 → 처리중. 바꾼 관리자 · 시각(`processing_started_by` · `_at`)을 남긴다 |
| `POST /inquiries/:inquiryId/replies` | 답변 행을 더하고 답변 완료. 고칠 때도 같은 경로 |
| `PUT /inquiries/:inquiryId/internal-memo` | 내부 메모 |
| `POST /leads/:leadId/processing` | 접수 → 처리중 |
| `PUT /leads/:leadId/reply` | 답변을 덮어쓰고 답변 완료, 첫 답변 날 상담 완료일 |
| `PUT /leads/:leadId/internal-memo` | 내부 메모 |
| `DELETE /leads/:leadId` | 상담하지 않은(상담 완료일 없는) 도입문의를 행째 지운다. 204, 상담을 마쳤으면 409 |

지우기를 뺀 쓰기 응답은 모두 `{ inquiryId | leadId, status, updatedAt }` — 화면은 상세나 이 응답의 `updatedAt` 을
다음 저장에 보낸다.

# Traps

**「답변 대기」는 상태 둘이다.** 목록의 `answerStatus` 는 API 전용 enum `InquiryAnswerStatus`(`WAITING` ·
`ANSWERED`, `GET /enums` 에 한글)이고, `WAITING` 은 접수와 처리중을 합친 것이다(2026-10-12 재영 승인). 각 줄의
`status` 는 세 값 그대로라 화면이 처리중을 따로 보일 수 있다.

**보낸 곳 검색은 1팀 표에서 ID 를 먼저 찾는다.** `inquiries` 의 `bp_code_id` · `store_id` · `created_by` 는 팀 경계라
Prisma 관계가 없다. `sender` 가 오면 BP 상호(`trade_name`) · 점포 이름 · 관리자 이름에 들어 있는 ID 를 각각 찾아 셋 중
하나에 맞는 문의를 준다. 지운 BP · 점포 · 계정도 찾고 이름도 보인다 — 문의는 보낸 그때의 기록이다. 이름 하나에 맞는
ID 가 아주 많아지면 `IN` 목록이 커진다; 그때는 SQL 조인으로 바꾼다.

**검색어는 글자 그대로 찾는다.** Prisma 의 `contains` 는 LIKE 와일드카드를 이스케이프하지 않아, `sender=_` 하나로 모든
BP · 점포 · 관리자가 맞았다(공용 DB 에서 BP 9 곳 중 9 곳, 실제로 `_` 가 든 것은 1 곳). 제목 · 보낸 곳은
`containsText` 로 `%` · `_` · `\` 를 막아 넘긴다. 다른 모듈의 `contains`(플랫폼 관리자 검색 등)는 아직 그대로다.

**파기 기한이 지난 도입문의는 목록 · 상세에 나오지 않는다.** 파기 배치(`lead-purge`)와 같은 기준 — 상담 완료일이 한국
날짜로 1년 전보다 앞서면 — 으로 조회에서도 거른다(`notExpired`). 배치가 하루 실패해도 이름 · 전화번호 · 이메일이 보이지
않게 하려는 것이다(api #34 리뷰). 상세는 404 다. 기준을 바꾸면 배치와 조회를 같이 바꾼다.

**읽기는 쿼리를 동시에 보내지 않는다.** 이름 조회 셋과 문의 상세의 답변 · 첨부파일은 차례로 읽는다(`include` 로 두
관계를 함께 읽으면 Prisma 가 쿼리를 동시에 보낸다). e2e 를 도는 PGlite 소켓 서버가 연결을 하나만 받아 동시 연결을
끊기 때문이고, 실제 PostgreSQL 에서는 작은 IN 조회 몇 번의 차이다.

**첨부파일은 상세가 정보만 주고, 파일은 따로 받는다.** 상세는 파일 이름 · 종류 · 크기뿐이다. 받을 때는
`download-url` 을 불러 [첨부파일 저장소](/api/storage.md)의 300초 서명 주소를 받는다 — 상세에 주소를 실으면 화면을 열어 둔
5분 뒤에 누르는 링크가 죽어 있다. 첨부는 문의 ID 와 첨부 ID 를 함께 조건으로 찾아, 다른 문의의 첨부 ID 를 붙여도 404 다.
저장소 설정(`AWS_S3_*`)이 없는 환경이면 DB 에 묻기 전에 503 이다.
목업 상세의 「운영 점포 수 · 요금 · 이전 문의」는 주지 않는다 — 요건(#332)에 없다. 목업의 도입문의 목록은 「담당자」
검색 · 「사업자」 · 「운영 형태」 칸을 그리지만, 요건에 없고 `leads` 에 그런 칸도 없어 이름 · 전화번호 · 업종 · 관심
서비스를 준다.

**도입문의 지우기는 상담 완료일과 답변 여부로 가르고, 흔적을 DB 에 남기지 않는다.** 운영 정책 CNT-11 은 상담하지 않은
도입문의를 자동으로 지우지 않고 운영자가 직접 처리하게 했다(WHALEERP-590). 「상담하지 않음」은 상담 완료일이 없고
답변완료도 아닌 것이다 — 답변하면 그날로 상담 완료일이 채워지므로 보통은 접수 · 처리중이 여기 들고, 상담 완료일 없이
답변완료가 된 옛 행(`reply` 주석)도 답변한 건이라 지우지 않는다(api #41 리뷰). 상담을 마친 건은 1년 뒤 파기 배치가
지운다. 개인정보 파기라 `is_deleted` 없이 행을 지우고, 누가 언제 지웠는지는 서버 로그(`lead deleted lead= admin=`)에만
남는다. 두 조건을 DELETE 에 넣어, 상세를 연 사이 다른 운영자가 답변했으면 지우지 않고 409 다. 없는 건과 파기 기한이
지난 건은 조회처럼 404 다. 답변 · 처리중 · 메모가 지워진 건을 만나면 409 가 아니라 404 다.

**지우기도 파기 배치도 그 도입문의의 운영 알림을 함께 지운다.** 처리중 전환 · 답변 때 보낸 `NTF_LEAD_ANSWERED` 의
본문은 `#{도입문의자}`(예 「김도윤 · 카페」)를 채운 글이라, 남기면 파기가 아니다(2026-10-15 재영). 알림은 도입문의를
외래키 없이(`related_type = 'LEAD'`) 가리키므로 `deleteLeadNotifications` 가 같은 트랜잭션에서 발송 → 받는 사람 →
알림 순으로 지운다(외래키가 RESTRICT). 배치는 `DELETE … RETURNING` 으로 지운 ID 를 받아 같은 일을 한다.

**알림을 만드는 사이 지워질 수 있다.** 처리 상태 알림은 커밋 뒤 뒤에서 도입문의를 읽고 알림을 만든다. 그 사이 지우기가
커밋되면 지운 뒤에 이름이 든 알림이 생긴다. 그래서 알림을 만든 뒤 도입문의를 `FOR SHARE` 로 다시 읽고 — 지우는 중이면
그 트랜잭션이 끝나기를 기다린다 — 없으면 방금 만든 알림을 지운다. 지우기의 알림 DELETE 가 새 알림보다 먼저 돌았어도 이
확인이 늦게 끝나므로 남지 않는다. 남는 알림이 없으니 「404 상세로 가는 알림 링크」도 생기지 않는다.

**그 정리가 실패하면 「CLEANUP FAILED」로 남는다.** 방금 만든 알림을 지우다 실패하면(DB 순단 등) 지운 문의자
이름이 든 알림이 남고, 다시 치울 장치가 없다 — 1년 파기도 이미 지운 도입문의의 알림은 찾지 못한다. 그래서
`notifyLeadOperators` 는 그 오류를 `CLEANUP FAILED, 알림을 손으로 지워야 한다` 로 바꿔 던지고, 호출부의
`… notification FAILED lead=…` 로그에 그대로 실린다. 이 줄은 사람이 지워야 한다는 신호다.

**처리중은 상태로, 답변 · 메모는 `updatedAt` 으로 겨룬다.** 처리중 전환은 `status = 'RECEIVED'`
를 조건에 건 UPDATE 라 본문이 없고, 둘이 동시에 눌러도 하나만 바뀐다. 답변과 메모는 읽은
`updatedAt` 을 조건에 건다 — 그사이 다른 운영자가 무엇이든 저장했으면 409 다(공지 · FAQ 와 같은
방식, 같은 ms 안이면 같은 값). 처리중을 거치지 않고 바로 답변해도 되고, 그러면 처리 시작 두 칸은
NULL 로 남는다(CHECK 가 둘을 함께 채우거나 함께 비우게 한다).

**처리중 전환도 `updatedAt` 을 바꾼다.** `@updatedAt` 칸이라 Prisma 가 모든 UPDATE 에서 새로 쓴다. 그래서
운영자 A 가 답변을 쓰는 사이 B 가 처리중을 누르면 A 의 저장은 409 다. 화면은 처리중 · 답변 · 메모 응답의
`updatedAt` 을 받을 때마다 갈아 끼워야 하고, 409 면 다시 읽는다. 여섯 경로 모두 응답 상태를 UPDATE 와 같은
트랜잭션 안에서(행 잠금을 쥔 채) 읽는다 — 커밋 뒤에 따로 읽으면 그사이 남이 저장한 `updatedAt` 을 돌려줘, 다음
저장이 409 없이 남의 저장을 덮는다.

**내부 메모는 키를 빼먹을 수 없다.** `internalMemo` 가 없으면 400 이고, `null` · 빈 문자열 · 공백만 보내면
지운다. 빠진 키를 「지움」으로 읽으면 칸을 빼먹은 요청이 메모를 지운다.

**알림은 첫 답변 때 한 번뿐이다.** 문의 답변을 고치면 `inquiry_replies` 에 새 행이 더해져 이전
답변 · 고친 시각 · 고친 운영자가 남지만, 상태는 답변 완료 그대로이고 다시 알리지 않는다(운영 정책
CNT-17). 「첫 답변」은 저장 전 상태가 답변 완료가 아니었는지로 가른다. 운영 알림의 `eventKey` 도
문의 ID 라 같은 문의로 두 번 만들어지지 않는다.

**운영 알림과 메일은 따로 보내고, 응답은 둘을 기다리지 않는다.** `notify(NTF_INQUIRY_ANSWERED)` 는 메일을
붙이지 않으므로(NTF-03, [Operations notifications](/api/notifications-api.md))
`MailService.send(EMAIL_INQUIRY_ANSWERED)` 를 따로 부른다. 둘은 서로의 실패에 묶이지 않는다 — 알림의 받는 사람
조회가 DB 오류여도 메일은 간다. 둘 다 커밋 뒤에 프로세스 안에서 뒤로 미뤄 보내고 응답은 기다리지 않는다: SMTP
(연결 · 소켓 각 30초)를 기다리면 관리자 웹이나 로드밸런서가 먼저 끊어, 운영자는 실패로 알고 다시 저장해 엉뚱한
409 를 받는다. 대가로 보내는 중에 서버가 내려가면 그 알림 · 메일은 사라진다. 무엇이 실패해도 답변 저장은
성공이다. 알림 실패는 `reasonOf`(Prisma 오류는 코드, 그 밖은 메시지)로, 메일 실패는 오류 이름 · 코드만 로그에
남긴다 — SMTP 오류 메시지에는 받는 주소가 섞인다(SMTP 단계 결과는 `MailService` 가 주소를 가려 로그와
`mail_send_logs` 에 남기고, 그 전 단계의 템플릿 · 주소 · 변수 오류는 이 한 줄뿐이다). 받는 사람은 문의를 등록한
사업자 관리자이므로 알림 · 메일 버튼은 고객지원 쪽 상세 `/support-inquiries/{id}` 로 간다(플랫폼 쪽
`/platform/community/...` 가 아니다).

**메일은 설정이 둘 다 있어야 나간다.** `MAIL_*` 가 비면 `OPTIONAL_MAIL_SERVICE` 가 null 이고,
`ADMIN_WEB_URL` 이 비면 버튼 링크(필수 변수)를 만들 수 없다. 어느 쪽이든 api 는 뜨고 그 메일만
warn 로그로 건너뛰고, 운영(`APP_ENV=prod`)이면 기동 때 error 로그를 한 번 남긴다(운영 메일 설정이 들어온 뒤 필수로
할지 다시 정한다, 2026-10-14 재영). `ADMIN_WEB_URL` 의 규칙은 `src/common/admin-web-url.ts` 하나이고 플랫폼 관리자 ·
BP 회원가입 메일과 같이 쓴다 — http(s) 가 아니면 기동 때 던지고, 운영은 https 만, 끝의 `/` 는 뗀다. 경로가 붙은
주소(하위 경로 배포)도 받고 링크는 그 뒤에 화면 경로를 이어 붙인다(`adminWebLink`). 등록자가 사용 중이 아니면 알림 ·
메일 모두 받는 사람이 없고, 이메일만 없으면 메일만 건너뛴다. 메일의 `sentBy`(대신 보낸 관리자)는 비운다 — 관리자가
화면에서 대신 보낸 것이 아니라 답변이 남긴 시스템 알림이다.

**도입문의 처리 상태가 바뀌면 플랫폼 운영자에게 알린다.** 처리중 전환과 답변완료(처음 답변완료가 될 때) 때
`NTF_LEAD_ANSWERED`(「도입문의 처리 상태 변경」, 변수 `처리상태` · `도입문의자` = 「이름 · 업종」)를
`platformOperators` 에게 보낸다(운영 정책 NTF-01 · 04, 2026-10-14 재영). 사건 키는 `{도입문의 ID}:{상태}` 라 같은
상태로 두 번 알리지 않고, 링크는 플랫폼 쪽 상세 `/platform/community/leads/{id}` 다. 문의 답변 알림처럼 커밋 뒤
응답을 기다리게 하지 않고 보내며 실패해도 처리는 성공이다. 업종은 기타면 직접 입력한 값, 아니면 공통코드
`INDUSTRY` 이름이다(사용 중지된 코드도 이름은 쓴다).

**도입문의 첫 답변은 문의자 이메일로 간다(WHALEERP-588).** 처음 답변완료가 될 때만 `EMAIL_LEAD_REPLY`(「도입문의
답변 메일」, 변수 `답변` 하나)를 접수 때 적은 이메일로 보낸다 — 답변을 고쳐도 다시 보내지 않는다. 답변
본문만 싣고 내부 메모는 넣지 않는다. 문의자 이름도 싣지 않는다 — 접수 확인 메일과 같은 이유로, 비로그인 입력값이
확인되지 않은 주소로 가는 회사 명의 메일에 실린다(재영 결정 2026-10-15, 운영 정책 CNT-11 v134,
`20261015164811_team3_lead_reply_without_name`). 그 마이그레이션이 적용되기 전에는 템플릿이 필수 변수 `문의자이름` 을
요구해 답변 메일만 막히고, 적용한 뒤에는 거꾸로 옛 코드(공용 DB 를 보는 다른 브랜치 · 로컬 서버)가 넘기는
`문의자이름` 이 「없는 변수」라 막힌다. 그래서 머지 직후 바로 deploy 한다. 답변 메일은 첫 답변 때 한 번만 가므로 그
사이에 막힌 메일은 저절로 다시 나가지 않는다 — 결과 칸이 생기기 전이라 상세의 결과는 비어 있지만, 답변완료라 운영자가 상세에서 다시 보낼 수 있다(아래 #597). 비로그인 문의자라 버튼 링크 변수가 없어 `ADMIN_WEB_URL` 없이도 나간다. 운영
알림과 따로, 응답을 기다리지 않고 보내며 실패해도 답변 저장은 그대로다(NTF-03 · 08). `MAIL_*` 가 비면 warn 로그로
건너뛴다. `EMAIL_LEAD_ANSWERED` 는 운영자에게 「처리 상태 변경」을 알리는 메일(사용 안 함)이라 쓰지 않는다.

**답변 메일의 마지막 결과는 도입문의 행에 있고, 운영자가 다시 보낸다(WHALEERP-597, 2026-10-19 재영).**
`leads.reply_mail_result`(`ReplyMailResult` 성공 · 실패) · `reply_mail_attempted_at` 이 마지막 메일의 결과 · 시각이고, 상세
(`GET /leads/:id`)가 `replyMailResult` · `replyMailAttemptedAt` 으로 준다. 보낸 적 없으면 둘 다 null 이고, 시각만 있고 결과가
null 이면 결과를 모른다(보내는 중이거나 결과를 남기지 못함) — 보내려고 시각을 잡을 때 결과를 비우기 때문이다. 그러지 않으면
보내는 동안(또는 결과 기록이 실패하면 계속) 「새 시각 + 지난 결과」가 보여, 이번에 실패했는데 「방금 성공」으로 읽힌다. `mail_send_logs` 에서
읽지 않는 이유: 그 테이블엔 어느 도입문의의 메일인지 가리키는 칸이 없어 같은 이메일로 접수된 다른 도입문의 메일과 섞이고,
1팀 테이블이라 칸을 더하려면 1팀 합의가 필요했다. 첫 답변 때 `MAIL_*` 가 없어 못 보낸 것도 실패로 남긴다 — 설정을 고친 뒤
운영자가 보고 다시 보내라는 뜻이다.

`POST /leads/:id/reply-mail/resend`(플랫폼 관리자, 200)는 저장된 **지금** 답변을 보낸다 — 고친 뒤 보내면 고친 답변이
간다. 보낸 운영자는 메일 이력의 `sent_by` 에 남는다. 답변완료가 아니면 409, 같은 도입문의에 1분 안에 다시 누르면 409
(「방금 답변 메일을 보냈습니다. 1분 뒤 다시 보내 주세요」), 파기 기한이 지났으면 상세처럼 404. `MAIL_*` 가 없으면 시각을
잡기 전에 503 이다 — 눌러도 계속 실패하고 1분 잠금만 걸리므로, 재설정 링크 발급(WHALEERP-172)과 같이 막는다. SMTP 가
실패하면 200 에 `replyMailResult: FAILED` 를 준다 — 응답이 결과를 기다린다. 네 가지가 함정이다.

- **1분 간격은 시각을 잡는 UPDATE 하나의 조건이다.** `reply_mail_attempted_at` 이 비었거나 1분 이상 지났을 때만
  `now()` 로 바꾸고(`RETURNING`), 잡히지 않으면 보내지 않는다. 그래서 동시에 눌러도 하나만 나간다. 시각은 DB 시계다
  (`date_trunc('milliseconds', now())` — JS `Date` 와 같은 정밀도라 아래 비교가 맞는다).
- **첫 답변 메일은 시각이 비어 있을 때만 잡는다.** 첫 메일은 답변 커밋 뒤에 비동기로 시각을 잡으므로, 그 사이에 다시
  보내기가 먼저 잡을 수 있다. 첫 답변은 한 번뿐이라 이때 시각은 비어 있어야 하고, 비어 있지 않으면 보내지 않는다 — 두 통이
  나가지 않고, 첫 메일이 다시 보내기의 시각을 덮어 그 결과를 지우지도 않는다. 첫 메일이 잡은 뒤로는 1분 안의 다시 보내기가 막힌다.
- **결과는 잡은 시각이 그대로일 때만 쓴다.** SMTP 가 1분 넘게 걸리는 사이 다시 보냈으면 늦게 끝난 앞 발송이 뒤 발송의
  결과를 덮지 않는다. 못 썼으면(뒤 발송 · 그사이 삭제) `lead reply mail result SUPERSEDED` 로, 기록이 실패하면 `NOT RECORDED`
  로 남기고 응답은 보낸 결과 그대로다 — 메일은 이미 나갔으니 500 이면 운영자가 다시 눌러 두 통이 된다.
- **결과 · 시각은 SQL 로 써서 `updated_at` 을 건드리지 않는다.** `@updatedAt` 은 Prisma 로 쓸 때만 바뀌므로, Prisma 로
  쓰면 메일 결과가 운영자가 읽어 둔 `updatedAt` 을 낡게 만들어 다음 답변 · 메모 저장이 409 가 된다. e2e 가 답변 응답의
  `updatedAt` 과 메일 결과가 남은 뒤의 값을 비교해 이것을 본다. e2e 는 메일을 늘 실패하는 대역으로 바꿔 보낸 횟수도 센다.

**접수되면 운영자에게 알리고 문의자에게 접수 확인 메일을 보낸다(#296).** `POST /leads` 가 커밋된 뒤
`NTF_LEAD_RECEIVED`(「도입문의 접수」, 변수 `도입문의자`)를 `platformOperators` 에게, `EMAIL_LEAD_CONFIRMATION` 을
문의자가 적은 이메일로 보낸다. 확인 메일은 변수 없는 고정 문구다 — 비로그인 접수라 받는 주소가 확인되지 않아,
입력값을 실으면 남의 주소로 회사 명의 피싱 문구를 보낼 수 있다(재영 결정 2026-10-15, api #50 리뷰,
`20261015155556_team3_lead_confirmation_fixed_wording`). 그리고 서비스 전체에서 시간당 50건까지만 보낸다 — IP 한도(시간당 5건)는 IP 를 바꾸면
그만이라, 넘치면 Gmail 한도가 차 가입 메일까지 막힌다. 넘으면 접수와 알림은 그대로 두고 메일만 건너뛰며
`lead confirmation mail SKIPPED hourly limit` 로 남긴다. 건수는 최근 1시간에 들어온 도입문의 행(방금 넣은 것 포함)이고
50을 넘으면 건너뛴다. 1시간 기준은 DB 의 `now() - interval '1 hour'` 다(api #50 리뷰). 그래서 `leads.created_at` 도 DB 가
채운다 — Prisma 의 `@default(now())` 는 DB 가 아니라 앱 프로세스가 `new Date` 로 채우므로, 그대로 두면 앱 시계로 찍고
DB 시계로 세게 된다. `schema.prisma` 의 그 칸은 `@default(dbgenerated("now()"))` 이고(`_model.py` 의
`DB_CLOCK`. Prisma 는 `dbgenerated` 를 DB 기본값과 늘 다르게 봐 `migrate diff` 에 값은 안 바뀌는 `SET DEFAULT now()` 가 한 줄 남는다 — 의도된 차이다), 같은 번호 · 이메일 10분 재접수 확인도 `now() - interval '10 minutes'` 로 센다. 개인정보 동의 일시는
여전히 앱 시계다 — 세는 데 쓰지 않는다. 접수마다 세므로 `leads_created_at_idx`(`20261015164900_team3_lead_created_at_index`)가
받친다. 메일 이력(`mail_send_logs`)은 SMTP 응답 뒤에야 생겨 보내는 중인 메일을 못 세므로 쓰지 않는다
(api #50 재리뷰). 도입문의 행은 메일보다 먼저 커밋되므로, 동시에 몰려도 51번째 이후로 커밋된 접수는 언제 세도 51 이상을
봐 잠금 없이 50건을 넘지 않고 서버가 여럿이어도 맞다. 운영자가 그 1시간 안에 도입문의를 지우면(#590) 그만큼 다시
보낼 수 있다. 사건 키는 도입문의 ID, 링크는 처리 상태 알림과 같은 플랫폼 쪽 상세다. 둘은
서로의 실패에 묶이지 않고 응답은 둘을 기다리지 않는다 — 공개 경로라 SMTP 가 멈추면 방문자가 다시 제출해 429 를
받는다. 운영 알림의 「도입문의자」는 「이름 · 업종」이다 — 운영자만 본다.
운영 알림을 만드는 일(도입문의 읽기 → 알림 → 지워졌는지 다시 보기)은 처리 상태 알림과 같은 `notifyLeadOperators`
하나다.

**메일 발송 이력은 도입문의와 함께 지워지지 않는다.** 접수 확인 · 답변 메일은 1팀 `mail_send_logs` 에 받는 주소와
채운 본문(답변 메일은 이름 · 답변)을 남기고, 이력은 1년 보존이라 지우기(#590) · 1년 파기가 건드리지 않는다. 운영 알림과
달리 이 둘은 남는다 — 파기 범위에 메일 이력을 넣을지는 아직 정하지 않았다.

**상담 완료일은 비어 있을 때만 채운다.** 1년 뒤 파기(`lead-purge`, 운영 정책 CNT-11)의 기준이라 답변을 고칠 때
오늘로 다시 쓰면 파기가 밀린다. 「처음 답변완료가 될 때」가 아니라 「비어 있을 때」로 가르므로, 예전에 상담
완료일 없이 답변완료가 된 행도 다음 답변 저장 때 파기 대상에 든다. 날짜는 한국 날짜다(`kstToday`).

**`/leads` 에 컨트롤러가 둘이다.** 접수(`LeadsController`)는 `@Public()` 과 IP 한도가 붙은 공개
경로라, 관리자 경로는 `LeadsAdminController` 로 나눠 그것을 물려받지 않게 했다. 둘을 합치면
누구나 답변을 쓸 수 있게 된다.

# Support side — /support-inquiries (#281)

관리자 웹 고객지원의 문의하기. 문의를 올린 사업자 관리자가 쓴다.

| 메서드 · 경로 | 하는 일 |
|---|---|
| `POST /support-inquiries` | 등록. multipart — `inquiryCategoryCode` · `title` · `body` 와 첨부 `files`(선택). 201 `{ inquiryId }` |
| `GET /support-inquiries` | 내 문의 목록. 등록 최신순, `status`(세 값) · `title` · `page` · `pageSize`. 줄마다 처음 답변 시각 `repliedAt` |
| `GET /support-inquiries/:inquiryId` | 내 문의 상세. 본문 · 처리중 시각 · 답변 · 첨부 정보 |
| `GET /support-inquiries/:inquiryId/attachments/:inquiryAttachmentId/download-url` | 첨부 내려받기 주소(300초) |

**메뉴 권한은 경로마다 `@MenuPermission` 으로 본다.** 문의하기(MN000036)의 등록 권한이 없으면 등록이, 조회
권한이 없으면 나머지 셋이 403 이다(재영 결정 2026-10-15). 공지 · FAQ 는 한 경로가 두 메뉴를 주어 컨트롤러가
`MenuPermissionsService.assert` 를 부르지만, 여기는 메뉴가 하나라 데코레이터로 충분하다. 가드가 사용 중인 계정인지도
본다. 가드가 먼저 돌므로 권한이 없으면 어떤 ID 든 404 가 아니라 403 이다.

**보이는 것은 본인이 등록한 문의뿐이다.** 같은 BP 의 다른 관리자가 넣은 문의도 보이지 않는다(2026-10-13 재영).
남의 문의 상세와 첨부는 없는 문의처럼 404 다 — 403 이면 그 ID 의 문의가 있다는 것이 드러난다.

**답변은 마지막 하나만 보인다(CNT-17).** `reply` 는 `{ body, repliedAt, editedAt }` — 내용은 마지막 답변 행,
`repliedAt` 은 처음 답변한 시각, `editedAt` 은 답변 행이 둘 이상일 때 마지막 행의 시각(「수정됨」)이다. 이전 답변 ·
답변한 운영자 · 내부 메모 · 처리한 운영자는 싣지 않는다.

**대상 BP · 점포는 등록한 관리자로 정한다.** BP 는 소속 BP, 점포는 점포 단위 관리자(가맹 마스터 · 가맹 관리자 — 공지
노출 대상 `STORE` 와 같은 기준)일 때 관리하는 점포다. 관리 점포가 하나가 아니면(0개 또는 여럿) 비워 BP 단위 문의로
둔다 — 요청에 점포를 받지 않고, 문의하기 화면(#284)에 점포 선택도 없다(2026-10-19 재영 결정).

**같은 문의를 5분 안에 다시 올리면 409 다(2026-10-12 재영 승인).** 같은 관리자 · 같은 제목 · 같은 내용이 기준이고,
등록 건수 자체에는 제한이 없다. 거듭 누른 제출은 거의 동시에 오므로 관리자 단위 advisory lock
(`inquiries:created_by:{id}`)을 쥔 뒤 확인한다. `created_at` 은 Prisma 가 앱 시계로 채우므로 5분도 앱 시계로 센다
(도입문의는 DB 시계 — 그쪽은 `created_at` 을 DB 가 채운다). 안내 문구는 아직 정하지 않았다(Manyfast 질문).

**첨부는 등록할 때만, 내용으로 검사한다(CNT-18).** JPG · PNG · PDF, 5개까지, 파일당 10MB 이고 어기면 400 —
`AttachmentsInterceptor` · `assertUpload` 로 근로계약 날인본 · 점포 이미지와 같은 문구다. 문의 행이 생긴 뒤 키
(`inquiries/{id}/…`)가 정해지므로 트랜잭션 안에서 한꺼번에 올리고(60초), 무엇이든 실패하면 올린 파일을 지운다.
업로드 실패는 모든 업로드가 끝난 뒤에 판정한다(`Promise.allSettled`) — 하나가 먼저 실패했다고 바로 지우면, 그 뒤에
끝난 업로드가 아무도 모르는 파일로 남는다(없는 키 삭제도 S3 는 성공으로 답한다). 트랜잭션 시간 초과(P2028 — 같은
관리자의 앞 등록이 첨부를 올리는 동안 잠금을 기다리다 넘김, 느린 업로드)는 근로계약 날인본처럼 503 「잠시 뒤 다시」다.
시간 초과는 콜백을 멈추지 않아 그때 올리던 파일은 정리 뒤에 끝날 수 있다 — 업로드 기한(25초)이 트랜잭션 기한보다
짧아 드물다. 정리 실패는 `문의 첨부 정리 실패 admin= …` 경고로 키와 원래 원인을 남긴다. 파일 이름에 NUL 문자가
있으면 400 이다(그대로 두면 업로드 뒤 DB 가 거부해 500). 첨부가 있는데 저장소 설정이 없으면 입력 검사 뒤에 503 이고,
첨부가 없으면 저장소 없이도 등록된다. 썸네일은 만들지 않는다.

**등록하면 플랫폼 운영자에게 운영 알림만 간다(NTF-01 · 04).** `NTF_INQUIRY_RECEIVED` 를 `platformOperators` 에게,
`문의자` 는 「BP 이름 점포 이름」(점포가 없으면 BP 이름), 링크는 플랫폼 쪽 상세 `/platform/community/inquiries/{id}`,
사건 키는 문의 ID 다. 메일은 없고 문의자에게는 알리지 않는다(문의자는 첫 답변 때 알림 · 메일을 받는다). 커밋 뒤 응답을 기다리게 하지 않고 보내며, 실패해도
등록은 성공이다.

# Verification

단위 테스트 `src/inquiries/*.spec.ts` · `src/leads/leads-admin.*.spec.ts`, e2e
`test/support-inquiries.e2e-spec.ts`(메뉴 권한 403 · 조회만 있으면 등록 403 · 본인 문의만 · 가맹 관리자 점포 채우기 ·
5분 중복 409 · 입력 · 첨부 검사 400 · 답변 모양. 「동시에 두 번 올려도 하나만」은 실제 PostgreSQL 에서만 증명된다 —
PGlite 에서는 잠금을 빼도 통과하는 것을 확인했고, 세션 발급까지 동시에 하면 가드의 세션 조회가 `prepared statement
does not exist` 로 깨져 토큰을 먼저 낸다) ·
`test/inquiries.e2e-spec.ts`(목록 · 상세의 거르기 · 이름 · 401 · 403 · 404 포함). e2e 의 「같은 updatedAt 으로 동시에 답변」은 실제 PostgreSQL 에서만
증명된다 — PGlite 소켓 서버는 연결을 하나만 받아 두 번째 동시 연결을 끊는다(공지 · FAQ 의 동시 수정
e2e 도 같다). 순서대로 보내면 두 번째가 409 인 것은 PGlite 에서도 확인된다. 알림은 응답 뒤에 만들어지므로 e2e 는
생길 때까지 기다려 센다.
