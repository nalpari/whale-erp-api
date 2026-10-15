---
type: API
title: Inquiry and lead handling
description: 커뮤니티 관리의 문의사항 · 도입문의 목록 · 상세와 처리 — 목록은 답변 대기(접수 · 처리중) · 답변 완료로 거르고, 플랫폼 관리자가 처리중으로 바꾸고 답변 · 내부 메모를 저장하며, 상담하지 않은 도입문의는 지운다. 동시 저장은 읽은 updatedAt 을 조건으로 건 UPDATE 로 막고, 문의 첫 답변만 등록자에게 운영 알림과 메일을 보낸다.
tags: [community, inquiry, lead, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-15T01:00:00Z }
sources:
  - id: inquiries-service
    resource: ../../src/inquiries/inquiries.service.ts
    title: InquiriesService (list · get · attachmentDownloadUrl · startProcessing · reply · saveInternalMemo)
    last_modified: 2026-10-14T08:14:22Z
  - id: inquiries-controller
    resource: ../../src/inquiries/inquiries.controller.ts
    title: /inquiries (platform admin only)
    last_modified: 2026-10-14T08:14:22Z
  - id: leads-admin-service
    resource: ../../src/leads/leads-admin.service.ts
    title: LeadsAdminService (list · get · startProcessing · reply · saveInternalMemo · remove)
    last_modified: 2026-10-15T01:00:00Z
  - id: leads-admin-controller
    resource: ../../src/leads/leads-admin.controller.ts
    title: /leads 관리자 경로 (platform admin only)
    last_modified: 2026-10-15T01:00:00Z
  - id: admin-web-url
    resource: ../../src/common/admin-web-url.ts
    title: ADMIN_WEB_URL — 메일 버튼 주소(플랫폼 관리자 · BP 회원가입 메일과 같은 규칙 하나)
    last_modified: 2026-10-14T01:20:18Z
  - id: updated-at
    resource: ../../src/common/updated-at.ts
    title: IsUpdatedAt · sameMillisecond (공지 · FAQ 와 같이 씀)
    last_modified: 2026-10-14T00:30:51Z
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
이고, 고객지원의 문의 등록 · 조회(#281)는 여기 없다. 모두 `@UserTypes('admin')` 이고, 플랫폼 관리자(PM · PA)가 아니면 403 이다 —
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

**도입문의 지우기는 상담 완료일로 가르고, 흔적을 DB 에 남기지 않는다.** 운영 정책 CNT-11 은 상담하지 않은 도입문의를
자동으로 지우지 않고 운영자가 직접 처리하게 했다(WHALEERP-590). 「상담하지 않음」은 상태가 아니라 상담 완료일이 없는
것이다 — 답변하면 그날로 채워지므로 접수 · 처리중이 여기 들고, 상담을 마친 건은 1년 뒤 파기 배치가 지운다. 개인정보
파기라 `is_deleted` 없이 행을 지우고, 누가 언제 지웠는지는 서버 로그(`lead deleted lead= admin=`)에만 남는다.
`consulted_date IS NULL` 을 DELETE 의 조건에 넣어, 상세를 연 사이 다른 운영자가 답변해 상담 완료일이 생겼으면 지우지
않고 409 다. 없는 건과 파기 기한이 지난 건은 조회처럼 404 다. 답변 · 처리중 · 메모가 지워진 건을 만나면 409 가
아니라 404 다.

**지워도 운영 알림에는 문의자 이름 · 업종이 남는다.** 처리중 전환 · 답변 때 보낸 `NTF_LEAD_ANSWERED` 의 본문은
`#{도입문의자}`(예 「김도윤 · 카페」)를 채운 글이고, `notifications` 는 도입문의를 외래키 없이(`related_type = 'LEAD'`)
가리켜 지우기와 파기 배치 어느 쪽도 손대지 않는다. 처리하지 않고 지운 건(접수 상태)은 알림이 없으니 남는 것도 없다.
알림의 링크는 이제 404 상세로 간다. 알림까지 지울지는 정해지지 않았다(2026-10-15, 재영 님께 물음).

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
사업자 관리자이므로 알림 · 메일 버튼은 고객지원 쪽 상세 `/support/inquiries/{id}` 로 간다(플랫폼 쪽
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

**도입문의 답변은 아직 문의자에게 메일로 가지 않는다.** 문의자용 답변 메일 템플릿과 발송은 후속 일감
WHALEERP-588 이다(2026-10-14 재영). `EMAIL_LEAD_ANSWERED` 는 운영자에게 「처리 상태 변경」을 알리는 메일이라 이것을
쓰지 않는다.

**상담 완료일은 비어 있을 때만 채운다.** 1년 뒤 파기(`lead-purge`, 운영 정책 CNT-11)의 기준이라 답변을 고칠 때
오늘로 다시 쓰면 파기가 밀린다. 「처음 답변완료가 될 때」가 아니라 「비어 있을 때」로 가르므로, 예전에 상담
완료일 없이 답변완료가 된 행도 다음 답변 저장 때 파기 대상에 든다. 날짜는 한국 날짜다(`kstToday`).

**`/leads` 에 컨트롤러가 둘이다.** 접수(`LeadsController`)는 `@Public()` 과 IP 한도가 붙은 공개
경로라, 관리자 경로는 `LeadsAdminController` 로 나눠 그것을 물려받지 않게 했다. 둘을 합치면
누구나 답변을 쓸 수 있게 된다.

# Verification

단위 테스트 `src/inquiries/*.spec.ts` · `src/leads/leads-admin.*.spec.ts`, e2e
`test/inquiries.e2e-spec.ts`(목록 · 상세의 거르기 · 이름 · 401 · 403 · 404 포함). e2e 의 「같은 updatedAt 으로 동시에 답변」은 실제 PostgreSQL 에서만
증명된다 — PGlite 소켓 서버는 연결을 하나만 받아 두 번째 동시 연결을 끊는다(공지 · FAQ 의 동시 수정
e2e 도 같다). 순서대로 보내면 두 번째가 409 인 것은 PGlite 에서도 확인된다. 알림은 응답 뒤에 만들어지므로 e2e 는
생길 때까지 기다려 센다.
