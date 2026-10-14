---
type: API
title: Notices and FAQ management
description: 커뮤니티 관리의 공지사항 · FAQ — 플랫폼 관리자만 쓰는 /posts CRUD, 게시에는 노출 대상이 필요하고, 동시 수정은 읽은 updatedAt 을 조건으로 건 UPDATE 로 막으며, 지우기는 지움 표시뿐이다.
tags: [community, notice, faq, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-14T02:04:13Z }
sources:
  - id: posts-service
    resource: ../../src/posts/posts.service.ts
    title: PostsService (list · get · create · update · remove)
    last_modified: 2026-10-14T02:04:13Z
  - id: posts-controller
    resource: ../../src/posts/posts.controller.ts
    title: /posts (platform admin only)
    last_modified: 2026-10-14T00:12:16Z
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
    last_modified: 2026-10-14T00:46:03Z
  - id: route-id
    resource: ../../src/common/route-id.ts
    title: parseRouteId — 범위 밖 ID 는 묻기 전에 404
    last_modified: 2026-10-14T00:46:03Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: isPlatformAdmin
    last_modified: 2026-10-13T03:44:30Z
---

# What it covers

Plane WHALEERP-272 (공지사항 · FAQ 등록 · 수정 · 삭제), 273 의 **저장** 쪽(노출 대상
행), 332 의 공지사항 · FAQ 목록. 사용자 쪽 조회(고객지원 · 비로그인 홈, 273 의 노출
판정, 280)는 여기 없다 — 다른 경로로 만든다. 첨부(`post_attachments`)도 없다: 파일
저장소가 아직 정해지지 않았다.

`/posts` 하나가 공지사항과 FAQ 를 함께 다룬다. 목록은 `contentType` 이 필수라 화면마다
따로 부른다.

# Who may call

관리자 토큰이고, 지우지 않은 사용 중 계정이며, 권한 유형이 PM · PA 일 때만이다
(`AdminScopeService.isPlatformAdmin`). 관리자 토큰은 BP · 가맹 관리자도 받고 가드는
DB 를 보지 않으므로 토큰 종류만으로는 부족하다. 메뉴 권한(`role_group_menus`)은 권한
관리가 생기면 더한다.

관리자 웹 로그인은 1팀이 만들 예정이라, 그 전까지는 이 경로를 부를 토큰이 없다.

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
