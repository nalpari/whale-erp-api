---
type: API
title: Notices and FAQ management
description: 공지사항 · FAQ — 글 종류마다 경로 · 메뉴를 나눈 플랫폼 관리 /platform-notices · /platform-faqs CRUD(메뉴 권한 + 플랫폼 관리자, 게시에는 노출 대상이 필요하고, 동시 수정은 읽은 updatedAt 을 조건으로 건 UPDATE 로 막으며, 지우기는 지움 표시뿐이다)와, 노출 대상 · 게시 기간으로 거른 비로그인 홈 /public-notices · /public-faqs · 고객지원 /support-notices · /support-faqs 조회.
tags: [community, notice, faq, admin, public, support]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-21T03:00:00Z }
sources:
  - id: posts-service
    resource: ../../src/posts/posts.service.ts
    title: PostsService (list · get · create · update · remove — 글 종류를 인자로)
    last_modified: 2026-10-20T07:40:00Z
  - id: posts-controller
    resource: ../../src/posts/posts.controller.ts
    title: /platform-notices (MN000219) · /platform-faqs (MN000220)
    last_modified: 2026-10-21T03:00:00Z
  - id: post-fields-dto
    resource: ../../src/posts/dto/post-fields.dto.ts
    title: 등록 · 수정 공통 칸
    last_modified: 2026-10-19T08:43:06Z
  - id: create-post-dto
    resource: ../../src/posts/dto/create-post.dto.ts
    title: 등록 요청 — 공통 칸 그대로(글 종류는 경로)
    last_modified: 2026-10-20T07:40:00Z
  - id: update-post-dto
    resource: ../../src/posts/dto/update-post.dto.ts
    title: 수정 요청 — 읽은 updatedAt
    last_modified: 2026-10-19T08:43:06Z
  - id: updated-at
    resource: ../../src/common/updated-at.ts
    title: IsUpdatedAt · sameMillisecond (문의 처리와 같이 씀)
    last_modified: 2026-10-15T08:46:31Z
  - id: route-id
    resource: ../../src/common/route-id.ts
    title: parseRouteId — 범위 밖 ID 는 묻기 전에 404
    last_modified: 2026-10-14T00:46:03Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: isPlatformRole — 가드의 platformOnly 가 쓰는 플랫폼 계정 판정
    last_modified: 2026-10-20T04:17:59Z
  - id: admin-names
    resource: ../../src/common/admin-names.ts
    title: adminNames — 관리자 ID → 이름(문의사항 · 도입문의와 같이 씀)
    last_modified: 2026-10-14T02:04:13Z
  - id: published-posts-service
    resource: ../../src/posts/published-posts.service.ts
    title: PublishedPostsService (노출 판정 · 정렬 SQL, 역할 → 노출 대상)
    last_modified: 2026-10-20T07:40:00Z
  - id: public-posts-controller
    resource: ../../src/posts/public-posts.controller.ts
    title: /public-notices · /public-faqs (비로그인 홈, WHALEERP-292)
    last_modified: 2026-10-20T07:40:00Z
  - id: support-posts-controller
    resource: ../../src/posts/support-posts.controller.ts
    title: /support-notices · /support-faqs (고객지원, WHALEERP-280 · 596)
    last_modified: 2026-10-21T03:00:00Z
  - id: post-response-dto
    resource: ../../src/posts/dto/post.response.dto.ts
    title: PostAttachmentDto — 상세의 첨부 목록(관리자 · 공개 · 고객지원 같이 씀)
    last_modified: 2026-10-19T08:43:06Z
  - id: post-attachments-migration
    resource: ../../prisma/migrations/20261019171114_team3_post_attachments_file_type/migration.sql
    title: post_attachments.file_type · 자리 1~5 CHECK · 지우지 않은 첨부의 자리 고유
    last_modified: 2026-10-19T08:43:06Z
  - id: menu-permission-guard
    resource: ../../src/auth/menu-permission.guard.ts
    title: "@MenuPermission 가드 — 경로마다 그 메뉴의 권한(관리는 platformOnly)"
    last_modified: 2026-10-21T03:00:00Z
  - id: community-menu-urls
    resource: ../../prisma/migrations/20261020161147_team3_community_menu_single_level_urls/migration.sql
    title: 커뮤니티 메뉴 넷의 url 을 한 단계로(/platform-notices · /platform-faqs · /platform-inquiries · /platform-leads)
    last_modified: 2026-10-20T07:40:00Z
---

# What it covers

Plane WHALEERP-272 (공지사항 · FAQ 등록 · 수정 · 삭제), 273 의 **저장** 쪽(노출 대상
행), 332 의 공지사항 · FAQ 목록, 그리고 사용자 쪽 조회 — 비로그인 홈(292)과 고객지원(280),
즉 273 의 노출 판정. 공지사항 첨부(`post_attachments`, 2026-10-19 — 아래 「Attachments」)도 여기다.

**글 종류마다 경로가 따로다**(2026-10-20). 관리자 웹은 로그인 때 받은 메뉴 url 로 메뉴를 그리고 화면 권한을
그 경로로 판정한다 — 해시 · 탭 · 쿼리는 보지 않아 화면 하나 = 메뉴 하나 = 경로 하나여야 한다(고객지원 #596 과 같은
이유). 그래서 한 경로가 `contentType` 으로 두 종류를 주던 `/posts` · `/support-posts` · `/public-posts` 를 나눴다:

| | 공지사항 | FAQ |
|---|---|---|
| 커뮤니티 관리(플랫폼) | `/platform-notices` (MN000219) | `/platform-faqs` (MN000220) |
| 고객지원(관리자 웹) | `/support-notices` (MN000035) | `/support-faqs` (MN000043) |
| 비로그인 홈 | `/public-notices` | `/public-faqs` |

메뉴 url 도 같은 이름이다(`20261020161147_team3_community_menu_single_level_urls`, 1팀의 `/platform-admins` 처럼
화면 주소 = API 자원 이름). 글 종류는 경로가 정하므로 등록 본문 · 목록 쿼리에 `contentType` 이 없고, 다른 종류의 글
ID 를 물으면(공지사항 경로로 FAQ ID) 없는 글처럼 404 다. FAQ 는 첨부가 없어 등록 · 수정이 JSON 만 받고 내려받기
경로가 없다. 고객지원 · 비로그인 FAQ 는 펼쳐 읽어 상세 이동이 없으므로 목록만 있다.

# Who may call

`/platform-notices` · `/platform-faqs`(커뮤니티 관리)는 관리자 토큰에 **그 메뉴의 그 동작 권한**(조회 · 등록 · 수정 ·
삭제)이 있고 **플랫폼 계정**(플랫폼 BP 소속 PM · PA)일 때만이다 — 핸들러마다 `@MenuPermission(동작,
{ platformOnly: true })` 가드로 본다 — 메뉴는 컨트롤러 경로(`/platform-notices` · `/platform-faqs`)로 찾는다(2026-10-21)(1팀 #84 와 같은 꼴, 플랫폼 관리자 관리와 같은 판정). 가드는 사용 중 계정인지도 보고,
권한 행이 BP 쪽 권한 그룹에 잘못 붙어도 고객 BP 관리자가 플랫폼 공지를 다루지 못하게 한다. 내려받기는 조회다.
가드는 인터셉터보다 먼저 돌아 권한이 없으면 multipart 첨부를 받기 전에 403 이고, ID 를 보기 전이라 범위 밖 ID 도 403 이다.
2026-10-20 전에는 메뉴 권한을 보지 않고 PM · PA 판정만 해, 권한 그룹에서 FAQ 메뉴를 막아도 FAQ 를 고칠 수 있었다.
경로를 메뉴마다 나눈 까닭이 이것이다 — 한 경로가 두 메뉴를 주면 가드가 글을 읽기 전에 메뉴를 정할 수 없다.
사용자 쪽 조회(`/public-*` · `/support-*`)는 아래 「Reading side」를 본다.

관리자 토큰은 관리자 웹 로그인([Admin authentication](/api/admin-auth.md))이 낸다.

# Rules that are not obvious

- **게시하려면 노출 대상이 하나 이상** 있어야 한다. 임시저장 · 비공개는 없어도 된다.
  1차 대상은 비회원 · 회원 · BP · 점포 넷이고, 「전체」는 네 개를 모두 보낸다.
  부가서비스(`ADDON`)는 400 이다.
- **유형은 경로가 정한다.** 등록 · 수정 요청에는 `contentType` 이 없다. FAQ 는
  공지사항 칸(유형 · 상단 고정 · 게시 기간)을 버린다 — FAQ 는 게시 기간을 쓰지 않는다.
  값은 버리지만 형식 검사는 받는다(FAQ 에 틀린 날짜를 보내면 400). FAQ 카테고리는 공통코드
  `FAQ_CATEGORY` 의 플랫폼 원본 중 사용 중인 상세코드여야 하고, 그룹도 사용 중이어야 한다.
  이 검사는 등록할 때, 게시로 저장할 때, 내용(제목 · 본문 · 카테고리)을 고칠 때만 한다 —
  카테고리를 사용 중지해도 그 FAQ 를 비공개 · 임시저장으로 내리거나 지울 수는 있다(2026-10-13 재영).
- **본문은 평문이다.** 서버는 정화하지 않고 그대로 저장 · 반환하고, 고객지원 · 비로그인 홈 ·
  관리자 화면은 본문을 HTML 로 그리지 않고 이스케이프해 보인다(2026-10-13 재영). 서식이
  필요해지면 그때 서버 정화를 넣는다 — 화면이 `innerHTML` 로 그리기 시작하면 바로 저장형 XSS 다.
  제목 200자, 본문 20,000자까지.
- **노출 대상 행은 지우고 다시 넣는다.** `post_audiences` 는 `todo_assignees` 와 같은 연결 표라
  `is_deleted` 없이 DELETE 한다(네이밍 규칙의 삭제 표시 예외, 2026-10-13 재영).
- **게시 상태는 자유롭게 바꾼다.** 전환 규칙을 정하지 않았으므로(2026-10-12) 수정
  요청의 `status` 로 어느 상태에서 어느 상태로든 간다. 별도 `publish` 같은 하위 경로는
  없다 — 화면의 임시저장 · 게시 버튼이 본문과 상태를 한 번에 저장하기 때문이다.
- **변경 이력은 `updated_by` · `updated_at` 뿐이다**(2026-10-12 재영 승인). 상단
  고정을 바꾸는 것도 이 수정으로 남는다.

# Concurrent edits

수정 요청은 읽을 때 받은 `updatedAt` 을 그대로(시간대 포함, 없으면 400) 보낸다. 서비스는
`UPDATE … WHERE post_id = ? AND is_deleted = false AND updated_at >= t AND updated_at < t + 1ms`
(받은 시각과 같은 밀리초 안)를 하고, 0 건이면 409 다. 같은 글을 둘이
동시에 고치면 PostgreSQL 이 뒤의 UPDATE 를 행 잠금 뒤 다시 평가하는데 그때는
`updated_at` 이 이미 바뀌어 0 건이 된다 — 그래서 별도 잠금이 없다. e2e 가 동시에 세 번
고쳐 200 하나와 409 둘이 나오는 것을 확인한다.

**같은 밀리초 안이면 같은 값으로 본다.** `updated_at` 은 `timestamptz(6)`(마이크로초)인데 응답
JSON 은 밀리초까지라, 등호로 비교하면 SQL 이 마이크로초로 쓴 행은 영영 409 가 된다. Prisma
`@updatedAt` 은 밀리초로 채우므로 지금은 어느 쪽이든 같지만, 되살리기나 마이그레이션처럼 SQL 이
`updated_at` 을 쓰는 경로가 생겨도 이 비교라면 고칠 수 있다.

# Deletion

지움 표시(`is_deleted`)만 하고 수정자를 남긴다. 이미 지운 글을 또 지우면 409, 없는
글은 404, 지운 글의 상세 · 수정은 404 다. 되살리기 API 는 아직 없다 — 행이 남아 있으니
화면이 생기면 `is_deleted = false` 로 돌리는 경로를 더한다.

# Attachments (WHALEERP-272 · 280 · 292)

공지사항만 첨부를 받는다 — FAQ 경로는 multipart 를 받지 않아 파일을 보내면 400 이고 글도 만들지 않는다(2026-10-14 재영). 종류 · 크기 · 개수는
문의 첨부와 같다: JPG · PNG · PDF(파일 내용으로 판정, `assertUpload`), 파일당 10MB, 공지 하나에 5개(운영 정책
CNT-18 v144, 2026-10-19 재영). 저장소는 `src/storage`([Storage](/api/storage.md)), 키는 `posts/{postId}/{UUID}.{확장자}`.

- **등록 · 수정이 multipart 를 받는다.** `POST /platform-notices` · `PUT /platform-notices/:postId` 는 JSON 그대로도 되고, 첨부가 있으면
  같은 칸을 multipart 텍스트 칸으로 보내고 파일은 `files` 칸이다. multipart 는 값이 모두 문자열이고 빈 배열 · null 을
  보낼 수 없어 DTO 가 맞춘다: 같은 이름을 되풀이한 칸은 배열(하나면 문자열 → 한 개짜리 배열), `isPinned` 는
  `'true'` · `'false'`, 빈 문자열인 선택 칸(유형 · 게시 기간 · FAQ 카테고리)은 null, `audiences` 를 빼면 빈 목록이다 —
  JSON 도 `audiences` 를 빼면 빈 목록이 됐다(전에는 400). 게시로 저장하면 서비스가 여전히 400 을 낸다.
- **수정은 더하고 뺀다.** 더할 파일은 `files`, 뺄 것은 `removeAttachmentIds`(그 공지의 지우지 않은 첨부 ID, 아니면
  400). 보내지 않으면 지금 첨부를 모두 남긴다 — 남김 목록이 아니라 뺄 목록인 까닭은 multipart 가 빈 목록을 보낼 수
  없어 「모두 빼기」를 남김 목록으로는 나타낼 수 없어서다. 남는 것 + 더한 것이 5개를 넘으면 400.
- **자리(`sort_order`)는 개수를 세는 칸이다.** 지우지 않은 첨부끼리 겹치지 않는 1~5 이고, 새 첨부는 남은 첨부가 쓰지
  않는 자리를 앞에서부터 쓴다. 화면 순서는 자리가 아니라 올린 순서(`post_attachment_id`)다. DB 도 막는다 — 자리
  1~5 CHECK 와 지우지 않은 첨부의 (`post_id`, `sort_order`) 부분 고유(문의 첨부와 같은 꼴에 지움 표시 조건). 개수와
  자리는 수정의 `updatedAt` 조건 UPDATE 로 글 행을 잠근 뒤 읽으므로 동시에 더해도 5개를 넘지 않는다.
- **뺀 첨부는 지움 표시하고 파일은 커밋 뒤 지운다.** 뺀 첨부를 되살리는 길이 없어서다. 파일 삭제가 실패해도 수정은
  성공이다(키를 warn 로그로 남긴다). **글을 지우면 첨부는 그대로 둔다** — 글은 되살릴 수 있게 보관하므로(#272).
- **올리기는 트랜잭션 안이고 실패하면 정리한다**(문의 첨부와 같다). 트랜잭션은 첨부가 있을 때만 60초, 올리기 하나라도
  실패하면 모두 끝난 뒤 503 「첨부파일을 저장하지 못했습니다」, 무엇이든 실패하면 올린 파일을 지운다. 시간 초과(P2028)는
  503. 첨부가 있는데 저장소 설정이 없으면 입력 검사 뒤 503 이고, 첨부가 없으면 저장소를 부르지 않는다. 썸네일은 만들지 않는다.
- **상세에 첨부 목록, 내려받기는 따로.** 관리자 상세(`GET /platform-notices|platform-faqs/:postId`), 비로그인 · 고객지원 공지사항 상세가
  `attachments: [{ postAttachmentId, fileName, fileType, sizeBytes }]` 를 올린 순서로 싣는다(목록에는 없다, FAQ 는 늘 빈 목록).
  내려받기 주소는 화면을 열어 둔 채 5분이 지나면 만료되므로 상세에 싣지 않고 첨부마다 받는다(#332 와 같다):
  `GET /platform-notices|public-notices|support-notices/:postId/attachments/:postAttachmentId/download-url` → `{ url }`(300초, 받으면 원래
  파일 이름). 관리자는 지우지 않은 글의 지우지 않은 첨부, 비로그인 · 고객지원은 **그 사람에게 보이는 공지사항**(상세와 같은
  `visible()` 판정 + `content_type = 'NOTICE'`)의 지우지 않은 첨부만 — 아니면 까닭을 밝히지 않는 404. 고객지원은 첨부가
  공지사항에만 있으므로 공지사항(MN000035) 조회 권한을 먼저 본다. 저장소 설정이 없으면 묻기 전에 503.
- **PGlite 로 증명하지 못한 것.** `post_attachments` 제약(CHECK · 부분 고유)은 마이그레이션을 적용한 PGlite 에 simple
  query 로 넣어 확인했다(6 · 0 → 23514, 지우지 않은 같은 자리 → 23505, 지운 행은 같은 자리 허용). e2e 로 두지 않은
  것은 PGlite 소켓 서버가 바인드(extended) 프로토콜의 DB 오류 뒤 연결을 끊어서다 — Prisma 는 모든 쿼리가 바인드다.

# Reading side — /public-* and /support-*

비로그인 홈은 `GET /public-notices` · `GET /public-notices/:postId` · `GET /public-faqs`(`@Public()`, 요청 횟수 제한
(throttle)을 걸지 않는다), 관리자 웹 고객지원은 `GET /support-notices` · `GET /support-notices/:postId` ·
`GET /support-faqs`(관리자 토큰)다. 넷은 같은 `PublishedPostsService` 를 쓰고 「누가 어떤 노출 대상에 드는가」와 글
종류만 다르다. 목록은 `noticeType` · `faqCategoryCode` · `keyword` · `page` · `pageSize` 로 거른다. `keyword` 는 대소문자를 가리지 않고,
공지사항은 제목만, FAQ 는 제목 또는 본문을 찾는다(#282 「제목 검색」, 2026-10-19). 같은 `list` 라 비로그인
`/public-notices` 의 검색도 제목만이다(한 기준으로 맞춤).
응답은 목록과 상세가 같은 모양이다(고객지원 상세만 `prev` · `next` 를 더 싣는다, 아래 「이전 · 다음」). FAQ 목록을
펼쳐 읽도록 본문을 싣고, 노출 대상 · 게시 상태 · 수정자는 싣지 않는다.

- **노출 대상** — 비로그인은 비회원(`GUEST`)이다. 로그인한 관리자는 누구나 회원(`MEMBER`)이고, BP 마스터 ·
  BP 관리자는 `BP`, 가맹 마스터 · 가맹 관리자는 `STORE` 에도 든다(front `docs/mockup/support/notice-edit.html` 의 「BP — 사업자
  관리자, 점포 — 점포 단위 관리자」). 플랫폼 관리자는 회원으로만 본다. 사용 중이 아닌 관리자 계정은 403(「사용할 수 없는 계정입니다…」,
  `ACCOUNT_UNAVAILABLE_MESSAGE`) — 메뉴 권한 가드가 먼저 보지만, 그 뒤 노출 대상을 읽을 때 다시 본다.
- **메뉴 권한 — 고객지원만, 경로마다** (#280 완료 조건, #596). 공지사항 경로는 MN000035, FAQ 경로는 MN000043 의
  조회 권한으로 `@MenuPermission` 가드가 판정하고 없으면 403(`ACCESS_DENIED_MESSAGE`). 글을 읽기 전에 본다 — 한
  경로(`/support-posts`)이던 2026-10-15 에는 상세가 글을 읽어 종류를 안 뒤에 `MenuPermissionsService.assert` 로 판정했고,
  #84 에서 1팀이 다른 화면을 가드로 옮길 때도 그래서 여기만 남겼지만, 경로를 나눠 그럴 필요가 없어졌다. 권한이 있으면
  무엇이 보이는지는 노출 대상이 정한다. 문의하기(MN000036, #281)도 같은 기준이다.
- **보이는 글** — 게시 상태, 지우지 않음, 노출 대상이 하나라도 겹침, 게시 기간 안. 기간은 한국 날짜이고 종료일
  당일까지 보인다. FAQ 는 기간 칸이 늘 비어 있어 기간 조건이 걸리지 않는다.
- **안 보이는 글의 상세는 어느 이유인지 밝히지 않는다** — 비공개 · 임시저장 · 지움 · 기간 밖 · 대상 밖 · FAQ 가
  모두 같은 404 다. 숫자가 아니거나 integer 범위 밖인 id 는 묻기 전에 404 다.
- **정렬** — 상단 고정 먼저, 그다음 게시일 내림차순, 마지막에 `post_id` 내림차순. 게시일은 게시 시작일(한국
  0시), 없으면 등록 일시다(#273 · #280, 2026-10-12 재영 승인). 응답의 `postedDate` 도 같은 기준의 한국 날짜다.
- **이전 · 다음 — 고객지원 공지사항 상세만** (#282, 2026-10-19). `GET /support-notices/:postId` 가
  `prev`(목록에서 바로 아래 글) · `next`(바로 위 글)를 `{ postId, title, postedDate }` 로, 끝이면 null 로 준다.
  그 관리자에게 보이는 공지사항을 위 정렬 그대로 늘어놓은 이웃이라 상단 고정 글끼리 · 고정과 일반 사이도 이어진다 —
  그래서 prev 는 대개 더 오래된 글이지만, 고정 글의 맨 아래에서는 그보다 새 일반 글일 수 있다. 권한을 확인한 뒤에만 읽는다.
  목록의 구분 · 검색어 필터는 걸지 않는다(상세 주소에는 목록 조건이 없다). 비로그인
  `/public-notices/:postId` 에는 없다(#293 요건에 없음). SQL 은 `lead` · `lag` 창 함수 한 번이고, 정렬 조각
  `LIST_ORDER` 를 목록과 같이 쓴다.

**판정과 정렬은 SQL 한 곳에 있다.** 「시작일, 없으면 등록 일시」는 Prisma `orderBy` 로 쓸 수 없어 목록은
`$queryRaw` 로 id 를 고른 뒤 `findMany` 로 칸을 읽고 순서를 되맞춘다. 목록 · 개수 · 상세 · 이웃이 같은 `visible()`
조각을 쓰므로 `total` 과 쪽, 목록과 상세가 서로 다른 글을 세지 않는다 — 조건을 고칠 때 이 함수를 고친다.
칸을 다시 읽는 `findMany` 는 지움 표시만 다시 본다. 그 사이 비공개로 바뀐 글이 한 번 나가거나 지워진 글이 빠져
`total` 과 한 개 어긋날 수 있는데, 목록과 count 가 다른 스냅샷을 읽는 것과 같은 허용이다.
이 SQL 이 실제로 거르는지는 `test/published-posts.e2e-spec.ts` 만 증명한다.

검색어는 `LIKE` 가 아니라 `strpos` 라 `%` · `_` 가 글자 그대로 찾아진다. 인덱스를 쓰지 않으므로 글이 많아져
느려지면 `pg_trgm` 을 본다.

노출 대상은 타입으로 하나 이상이다(`Audiences`) — 비면 `IN ()` 이 SQL 오류로 500 이 된다.
