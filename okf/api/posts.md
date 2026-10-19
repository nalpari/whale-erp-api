---
type: API
title: Notices and FAQ management
description: 공지사항 · FAQ — 플랫폼 관리자만 쓰는 /posts CRUD(게시에는 노출 대상이 필요하고, 동시 수정은 읽은 updatedAt 을 조건으로 건 UPDATE 로 막으며, 지우기는 지움 표시뿐이다)와, 노출 대상 · 게시 기간으로 거른 비로그인 홈 /public-posts · 고객지원 /support-posts 조회.
tags: [community, notice, faq, admin, public, support]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-19T07:29:00Z }
sources:
  - id: posts-service
    resource: ../../src/posts/posts.service.ts
    title: PostsService (list · get · create · update · remove)
    last_modified: 2026-10-14T02:04:13Z
  - id: posts-controller
    resource: ../../src/posts/posts.controller.ts
    title: /posts (platform admin only)
    last_modified: 2026-10-14T05:00:00Z
  - id: post-fields-dto
    resource: ../../src/posts/dto/post-fields.dto.ts
    title: 등록 · 수정 공통 칸
    last_modified: 2026-10-13T05:12:04Z
  - id: create-post-dto
    resource: ../../src/posts/dto/create-post.dto.ts
    title: 등록 요청 — contentType
    last_modified: 2026-10-13T00:58:41Z
  - id: update-post-dto
    resource: ../../src/posts/dto/update-post.dto.ts
    title: 수정 요청 — 읽은 updatedAt
    last_modified: 2026-10-14T00:12:16Z
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
    title: isPlatformAdmin
    last_modified: 2026-10-19T07:29:00Z
  - id: admin-names
    resource: ../../src/common/admin-names.ts
    title: adminNames — 관리자 ID → 이름(문의사항 · 도입문의와 같이 씀)
    last_modified: 2026-10-14T02:04:13Z
  - id: published-posts-service
    resource: ../../src/posts/published-posts.service.ts
    title: PublishedPostsService (노출 판정 · 정렬 SQL, 역할 → 노출 대상)
    last_modified: 2026-10-15T01:59:07Z
  - id: public-posts-controller
    resource: ../../src/posts/public-posts.controller.ts
    title: /public-posts (비로그인 홈, WHALEERP-292)
    last_modified: 2026-10-15T01:59:07Z
  - id: support-posts-controller
    resource: ../../src/posts/support-posts.controller.ts
    title: /support-posts (고객지원, WHALEERP-280)
    last_modified: 2026-10-15T08:42:00Z
  - id: menu-permissions-service
    resource: ../../src/menu-permissions/menu-permissions.service.ts
    title: MenuPermissionsService.assert — 고객지원 글 종류별 메뉴 조회 권한
    last_modified: 2026-10-15T08:42:00Z
---

# What it covers

Plane WHALEERP-272 (공지사항 · FAQ 등록 · 수정 · 삭제), 273 의 **저장** 쪽(노출 대상
행), 332 의 공지사항 · FAQ 목록, 그리고 사용자 쪽 조회 — 비로그인 홈(292)과 고객지원(280),
즉 273 의 노출 판정. 첨부(`post_attachments`)는 아직 없다.

`/posts` 하나가 공지사항과 FAQ 를 함께 다룬다. 목록은 `contentType` 이 필수라 화면마다
따로 부른다.

# Who may call

`/posts`(운영자 관리)는 관리자 토큰이고, 지우지 않은 사용 중 계정이며, 권한 유형이 PM · PA 일 때만이다
(`AdminScopeService.isPlatformAdmin`, 2026-10-14 부터 플랫폼 BP 소속까지 본다). 관리자 토큰은
BP · 가맹 관리자도 받고, 가드는 관리자 세션만 보고 계정 상태는 보지 않으므로 토큰 종류만으로는
부족하다. `/posts` 는 아직 메뉴 권한(`role_group_menus`)을 보지 않고 PM · PA 판정만 한다 — 고객지원
`/support-posts` 는 메뉴 권한을 본다(아래 「Reading side」). 사용자 쪽 조회(`/public-posts` · `/support-posts`)는 아래 「Reading side」를 본다.

관리자 토큰은 관리자 웹 로그인([Admin authentication](/api/admin-auth.md))이 낸다.

# Rules that are not obvious

- **게시하려면 노출 대상이 하나 이상** 있어야 한다. 임시저장 · 비공개는 없어도 된다.
  1차 대상은 비회원 · 회원 · BP · 점포 넷이고, 「전체」는 네 개를 모두 보낸다.
  부가서비스(`ADDON`)는 400 이다.
- **유형은 저장된 글의 것으로 판단한다.** 수정 요청에는 `contentType` 이 없다. FAQ 는
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

# Reading side — /public-posts and /support-posts

비로그인 홈은 `GET /public-posts` · `GET /public-posts/:postId`(`@Public()`, 요청 횟수 제한(throttle)을 걸지 않는다),
관리자 웹 고객지원은 `GET /support-posts` · `GET /support-posts/:postId`(관리자 토큰)다. 둘은 같은
`PublishedPostsService` 를 쓰고 「누가 어떤 노출 대상에 드는가」만 다르다. 목록은 `contentType` 이 필수이고
`noticeType` · `faqCategoryCode` · `keyword`(제목 또는 본문, 대소문자 무시) · `page` · `pageSize` 로 거른다.
응답은 목록과 상세가 같은 모양이고 FAQ 목록을 펼쳐 읽도록 본문을 싣는다. 노출 대상 · 게시 상태 · 수정자는
싣지 않는다.

- **노출 대상** — 비로그인은 비회원(`GUEST`)이다. 로그인한 관리자는 누구나 회원(`MEMBER`)이고, BP 마스터 ·
  BP 관리자는 `BP`, 가맹 마스터 · 가맹 관리자는 `STORE` 에도 든다(front `docs/mockup/support/notice-edit.html` 의 「BP — 사업자
  관리자, 점포 — 점포 단위 관리자」). 플랫폼 관리자는 회원으로만 본다. 사용 중이 아닌 관리자 계정은 403(「사용할 수 없는 계정입니다…」,
  `ACCOUNT_UNAVAILABLE_MESSAGE`) — 가드는 계정 상태를 보지 않는다.
- **메뉴 권한 — 고객지원만, 글 종류마다** (재영 결정 2026-10-15, #280 완료 조건). 한 경로가 두 종류를 주므로 공지사항은
  MN000035, FAQ 는 MN000043 의 조회 권한으로 판정하고 없으면 403(`ACCESS_DENIED_MESSAGE`). 고정 `@MenuPermission` 하나로는
  안 돼 컨트롤러가 `MenuPermissionsService.assert` 를 부른다 — 목록은 `contentType` 으로 묻기 전에, 상세는 글을 읽어
  종류를 안 뒤에. 그래서 권한 없는 종류의 글이라도 보이지 않는 글이면 403 이 아니라 404 다. 권한이 있으면 무엇이
  보이는지는 노출 대상이 정한다. 문의하기(MN000036, #281)는 API 가 생기면 같은 기준을 쓴다.
- **보이는 글** — 게시 상태, 지우지 않음, 노출 대상이 하나라도 겹침, 게시 기간 안. 기간은 한국 날짜이고 종료일
  당일까지 보인다. FAQ 는 기간 칸이 늘 비어 있어 기간 조건이 걸리지 않는다.
- **안 보이는 글의 상세는 어느 이유인지 밝히지 않는다** — 비공개 · 임시저장 · 지움 · 기간 밖 · 대상 밖이 모두
  같은 404 다. 숫자가 아니거나 integer 범위 밖인 id 는 묻기 전에 404 다.
- **정렬** — 상단 고정 먼저, 그다음 게시일 내림차순, 마지막에 `post_id` 내림차순. 게시일은 게시 시작일(한국
  0시), 없으면 등록 일시다(#273 · #280, 2026-10-12 재영 승인). 응답의 `postedDate` 도 같은 기준의 한국 날짜다.

**판정과 정렬은 SQL 한 곳에 있다.** 「시작일, 없으면 등록 일시」는 Prisma `orderBy` 로 쓸 수 없어 목록은
`$queryRaw` 로 id 를 고른 뒤 `findMany` 로 칸을 읽고 순서를 되맞춘다. 목록 · 개수 · 상세가 같은 `visible()`
조각을 쓰므로 `total` 과 쪽, 목록과 상세가 서로 다른 글을 세지 않는다 — 조건을 고칠 때 이 함수를 고친다.
칸을 다시 읽는 `findMany` 는 지움 표시만 다시 본다. 그 사이 비공개로 바뀐 글이 한 번 나가거나 지워진 글이 빠져
`total` 과 한 개 어긋날 수 있는데, 목록과 count 가 다른 스냅샷을 읽는 것과 같은 허용이다.
이 SQL 이 실제로 거르는지는 `test/published-posts.e2e-spec.ts` 만 증명한다.

검색어는 `LIKE` 가 아니라 `strpos` 라 `%` · `_` 가 글자 그대로 찾아진다. 인덱스를 쓰지 않으므로 글이 많아져
느려지면 `pg_trgm` 을 본다.

노출 대상은 타입으로 하나 이상이다(`Audiences`) — 비면 `IN ()` 이 SQL 오류로 500 이 된다.
