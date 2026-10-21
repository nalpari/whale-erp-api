---
type: API
title: Platform menus
description: 관리자 웹 「플랫폼 메뉴 관리」(MN000215) — service tabs from 공통코드 SERVICE, the per-service menu tree, detail, create (global code numbering plus a PM000001 row), editing name · URL · status, and moving a menu with its subtree inside one service.
tags: [admin, menu, permission]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-21T01:46:17Z }
sources:
  - id: platform-menus-controller
    resource: ../../src/platform-menus/platform-menus.controller.ts
    title: /platform-menus routes and the menu permission per action (menu found by the path)
    last_modified: 2026-10-21T01:46:17Z
  - id: platform-menus-service
    resource: ../../src/platform-menus/platform-menus.service.ts
    title: PlatformMenusService (services · tree · detail · create · update · move)
    last_modified: 2026-10-21T01:46:17Z
  - id: api-menu-urls
    resource: ../../src/platform-menus/api-menu-urls.service.ts
    title: API 권한 주소 — 경로 방식 @MenuPermission 컨트롤러의 경로 첫 단계(DiscoveryService)
    last_modified: 2026-10-21T01:46:17Z
  - id: menus-url-unique-migration
    resource: ../../prisma/migrations/20261021112158_team1_menus_active_url_unique/migration.sql
    title: 사용 중 메뉴 url 부분 유니크 인덱스(menus_url_active_key)
    last_modified: 2026-10-21T01:46:17Z
  - id: platform-menu-rules
    resource: ../../src/platform-menus/platform-menu-rules.ts
    title: Pure rules — code numbering, URL overlap, hidden menus, move plan
    last_modified: 2026-10-19T01:09:23Z
  - id: platform-menu-format
    resource: ../../src/platform-menus/platform-menu-format.ts
    title: Menu code · URL pattern · messages
    last_modified: 2026-10-21T01:46:17Z
  - id: platform-menu-dto
    resource: ../../src/platform-menus/dto/save-platform-menu.dto.ts
    title: Input rules — name 20, URL pattern, move body
    last_modified: 2026-10-19T00:51:03Z
  - id: platform-menus-e2e
    resource: ../../test/platform-menus.e2e-spec.ts
    title: Real-DB proof — numbering, PM row, URL overlap, fixed API URLs, optimistic edit, concurrent create, move renumbering without a version bump
    last_modified: 2026-10-21T01:46:17Z
---

# What it covers

The 관리자 웹 menu MN000215 「플랫폼 메뉴 관리」 (`/platform-menus` — the seed's `/platform/system/menus` until `20261019144438_team1_menu_single_level_urls`; front
`system.md` 「플랫폼 메뉴 관리」, S-GXMZOU · F-CWWQUR · SYSTEM-7). It edits the `menus`
table that 관리자 웹's `login-info` draws and that [플랫폼 권한 관리](/api/platform-role-groups.md)'s
menu popup reads.[^platform-menus-service]

| Route | Menu permission | Answer |
|---|---|---|
| `GET /platform-menus/services` | 조회 | `{ items, total }` — every 공통코드 SERVICE value of BP000000, 사용중지 included, with `menuCount` · `activeMenuCount` · `inactiveMenuCount` |
| `GET /platform-menus?serviceCode=` | 조회 | `{ service, items, total }` — the service's undeleted menus, nested `children` in sibling order; no paging, no search |
| `GET /platform-menus/:id` | 조회 | detail with `parent`, `path` (names from the root), `isGroup`, `isHidden`, actors and `updatedAt` |
| `POST /platform-menus` | 등록 | `{ serviceCode, parentMenuId?, name, url?, status? }` → 201 `{ menuId, menuCode }` |
| `PUT /platform-menus/:id` | 수정 | `{ name, url?, status, updatedAt }` → 204 |
| `POST /platform-menus/:id/move` | 수정 | `{ parentMenuId: number \| null, index }` → 204 |

Every route carries `@MenuPermission(action, { platformOnly: true })`, as
플랫폼 권한 관리 does ([admin authentication](/api/admin-auth.md)) — the guard finds the menu
by the controller path, `/platform-menus`, which is MN000215's URL: a BA group carrying an
MN000215 row, or a `PM` account on a customer BP, still gets 403. Being a guard (since
2026-10-20; the handlers called `MenuPermissionsService.assert` — removed 2026-10-21 — and
`AdminScopeService.isPlatformAdmin` before), it runs ahead of validation, so such a
caller gets 403 even for a malformed body, a malformed `serviceCode` or an out-of-range id — where it
used to get 400 or 404. The service never needs the caller's role, only the id it writes
as 등록자 · 수정자, so it takes `user.id` and reads nothing.[^platform-menus-controller]
There is **no delete** — a menu nobody uses is set to 사용중지 (F-CWWQUR) — and **no change
history**, by policy.

# Decisions taken on 2026-10-16

The specification left these open; the user decided them when this was built.

- **Codes are global**: `MN` + 6 digits, one past the highest code of any service,
  deleted rows included. The mockup counts the same way. Per-service ranges were
  rejected — WHALE_ERP would run into PLATFORM's range at MN000200, and two codes
  (MN000007 · 008) were physically deleted, so only "highest + 1" guarantees a deleted
  number never returns (PL-EIMSQF).
- **Turning off this screen's own menu is allowed.** Nothing stops `PUT` from setting
  MN000215, MN000214 or their parent MN000212 to `INACTIVE` — the URL fix below locks the
  URL, not the status. The guard looks only at the requested menu's own status, so the result differs per menu:
  - **MN000215 off** — from the next request everyone, the platform master included, gets
    403 here, and only a database `UPDATE` brings it back.
  - **MN000214 off** — 플랫폼 권한 관리 answers 403, but this screen still works and can turn
    it back on.
  - **MN000212 off** — both children drop out of 관리자 웹's menu, while their APIs keep
    passing (see the hidden-menu trap below); this screen can turn it back on.
- **URL**: the DTO takes `/` followed by lowercase · digit · `-` segments (`^(/[a-z0-9-]+)+$`,
  ≤ 200); blank becomes NULL. A **new** URL must be one segment (`^/[a-z0-9-]+$`, so
  `/staff-content`, not `/staff/content` — user decision 2026-10-19): the service checks it on
  create and on an edit that changes the URL (400). An edit that keeps the menu's current URL
  passes even when it has several segments — the 1팀 seed URLs are the real screen paths, so
  their menus must stay editable until those URLs and routes move to one segment. Among **active** menus of **any** service, two URLs may not be equal
  or one a path under the other (`/stores` vs `/stores/x`) → 409 naming the other menu's
  code. 관리자 웹 decides menu permission by URL prefix, so an overlap would let the upper
  menu's 조회 open the lower screen — the same rule 3팀's menu migrations check in their
  `DO` blocks. Inactive menus are not compared, so the old 1팀 seed overlaps among
  사용중지 menus stay legal, and turning such a menu back on is where the 409 bites
  (the e2e turns an inactive copy of another menu's URL on and gets 409).
- **The URL is also the API permission key** (2026-10-21). `@MenuPermission` finds the menu
  by the first segment of the controller path, so the active menu at `/stores` is the one
  whose rights open `/stores/**`. Two active menus with one URL would let either menu's
  right open that API, and a renamed URL moves the API to another menu's right — or to
  nobody's, if no active menu has the path. The overlap 409 above is what keeps one URL
  to one active menu; the message stays 「같거나 겹치는 URL 을 쓰는 사용 중 메뉴가
  있습니다(MNxxxxxx)」. Behind it, since `20261021112158_team1_menus_active_url_unique`, the
  partial unique index `menus_url_active_key` (`url` among undeleted `ACTIVE` menus with a
  URL) stops a migration or hand-written SQL from inserting the same URL twice. It cannot
  express prefix overlaps (`/a` vs `/a/b`) — those are still the service's alone — and,
  being a partial index, it is SQL-only: `schema.prisma` does not show it and `db:pull`
  drops it.[^menus-url-unique-migration] The migration first stops with the duplicate
  URLs named if any exist, then checks that the index was created.
- **URLs bound to an API path are fixed** (2026-10-21, 사용자 결정). The review of the
  path-based guard found that 메뉴 관리's 수정 right had become the right to grant rights:
  moving 공지사항's URL to `/platform-admins` would open 플랫폼 관리자 to 공지사항 rights
  (escalation), and changing MN000215's URL would make `/platform-menus` 403 for everyone,
  recoverable only in the database (lock-out). So the service, inside the same lock as the
  overlap check, answers 409 when
  - a menu whose current URL is an API permission address gets a different URL or none —
    「API 권한에 쓰이는 메뉴 주소라 바꿀 수 없습니다: /x」;
  - any other menu would take such an address, on create or edit and **whatever its
    status** (an inactive holder could be switched on after the owner is switched off) —
    「다른 메뉴가 API 권한 주소를 가져갈 수 없습니다: /x」.

  Name and status (사용 · 사용중지) stay editable — the 2026-10-16 decision above still
  holds, so switching MN000215 off still locks the screen. The API permission addresses
  are not a list anyone maintains: `ApiMenuUrlsService` walks the app's controllers once
  (`DiscoveryService`, on first use) and takes `'/' + first path segment` of every
  controller whose class or any method carries a path-form `@MenuPermission` (no
  `menuCode` key), with the guard's own `menuUrlOf`.[^api-menu-urls] Today that is
  `/stores`, `/staff-members`, `/todos`, `/support-notices`, `/support-faqs`,
  `/support-inquiries`, `/platform-admins`, `/platform-role-groups`, `/platform-menus`,
  `/code-groups`, `/platform-notices`, `/platform-faqs`, `/platform-inquiries` and
  `/platform-leads`. **To move one, change the controller path and the menu URL together
  in a migration** — there is no screen path for it by design.
- **A new menu gets a PM000001 row** with all four cells, in the same transaction. The
  guard reads stored rows, so without it the platform master would get 403 on the menu
  that 플랫폼 권한 관리 draws as "all allowed". If PM000001 is missing the create is a 500
  naming the 1팀 initial-data migration rather than a menu nobody can open. No other group
  gets a row — 「권한은 권한 관리에서 따로 준다」.
- **Up to 3 levels**, as the policy and `menus_depth_range` say, although 3팀's #594
  migration removed the only two 3-level menus.
- **Service tabs are all of SERVICE**, inactive and empty ones too, so the first menu of a
  new service can be made here.
- **노출 메뉴명** is trimmed, 1–20 characters, no NUL. Siblings may share a name.

# Creating

The menu goes **to the end** of the chosen parent (or of the service's top level), status
`ACTIVE` unless sent. The parent must be undeleted, of the same service, and at most level
2 (→ 400); it may be 사용중지 — the policy allows building under a hidden parent, and the
detail's `isHidden` is what tells the screen to say "사용자에게는 보이지 않는다". The
service must exist in SERVICE (any status) or it is 400.

# Editing

`PUT` replaces name, URL and status as a whole: leaving `url` out clears it. It writes only
while `updated_at` is in the sent millisecond; a miss is 409, or 404 if the menu was
deleted meanwhile. Setting a menu `INACTIVE` hides it and, through the ancestor rule, its
whole subtree from `login-info` and the 권한 popup — the children keep their own status, so
turning the parent back on restores them. Existing role rows are kept.

Service, parent, code and order are read-only here; parent and order change only by moving.

# Moving

`index` is the 0-based slot among the new siblings (beyond the end means last). The plan
(`planMove`) takes the service's undeleted menus and:

- refuses with 400 a parent outside the service (or missing) — 「같은 서비스 안에서만 옮길 수
  있습니다」, the menu itself or one of its descendants — 「…자기 자신이나 하위 메뉴 아래로…」,
  and a place where the subtree would pass level 3 — 「메뉴는 최대 3단계까지만 둘 수 있습니다」;
- renumbers the old and the new siblings 1..n, moves the subtree along and recomputes
  every `depth` in it (`login-info` returns `depth` as stored);
- writes only rows whose parent, order or depth changed. Moving under a 사용중지 parent is
  allowed, like creating there.

There is no version check on a move: each one is saved at once, as in the mockup, and it is
planned from the current rows inside the lock.

**A move does not change any menu's version.** Every row it rewrites gets its own
`updated_at` written back unchanged (an explicit value overrides Prisma's `@updatedAt`), and
`updated_by` is left alone. Otherwise renumbering would bump siblings that only slid one
slot, and an open detail of any of them would fail its next save with 「다른 관리자가 먼저
수정했습니다」 though nobody edited it. So a menu's 수정자 · 수정일시 mean the last change of
name, URL or status — not of position. The service no longer takes the caller for a move.

# Concurrency

Create, edit and move all take `pg_advisory_xact_lock(hashtext('menus:write'))` first.
Renumbering, code numbering and the URL overlap check are each "read, decide, write", and a
single lock on a screen a few admins use rarely is the simplest thing that is correct. Reads
take no lock. The e2e fires parallel creates under one parent (distinct codes, order 1..n)
and parallel creates with one URL (exactly one 201) — that is the only proof of the lock.

Waiting for the lock counts against the interactive transaction's time, so the writes get
`maxWait` 5 s · `timeout` 15 s instead of Prisma's 2 s · 5 s (as 점포 등록 and 권한 관리 do), and a
write that still runs out (P2028) is a logged **503** 「메뉴 저장이 몰렸습니다」 rather than a 500 —
a queue, not a fault, so the screen should simply retry.

That test needs real parallel connections. The PGlite socket server multiplexes every
connection onto one backend, so concurrent queries break its wire protocol (`bind message
supplies 2 parameters…`, a 500); run it on PGlite with `E2E_SINGLE_BACKEND=1`, which skips
just that test, and on a real PostgreSQL without it.

A detail whose service code is missing from 공통코드 SERVICE is a 500 naming the code —
`tree` answers 404 for the same code, and a detail that filled the service name with the
code and marked everything hidden would look normal while the data is broken.

# Traps

- **A leaf that becomes a group keeps its role rows.** Creating or moving a menu under a
  former leaf turns it into a group menu; its rows (and URL) are not touched. 플랫폼 권한 관리
  normalises a group's cells the next time that role group's menus are saved — 조회 only if
  some visible child has 조회, otherwise all off. PM000001 cannot be saved there, so its
  four-cell row on such a menu stays as it is.
- **Hidden is computed, not stored.** `isHidden` = the service, the menu or any ancestor is
  사용중지. The menu-permission guard looks only at the menu's own status, so a leaf under a 사용중지 parent still
  passes the API while 관리자 웹 no longer shows it.
- **e2e cleanup** (any PostgreSQL): menus are re-collected by `created_by` of the suite's
  admins, so a request that was expected to fail but created a menu after a regression is
  removed too — otherwise `created_by` blocks deleting the admins and the rest of the
  cleanup stops. Seed menus' `updated_by` is cleared before the admins go. Deleting
  leaf-first throws, naming the menus left, when a round finds nothing to delete, instead
  of looping forever. The app is closed in `finally`, or jest never exits.

[^platform-menus-service]: PlatformMenusService (services · tree · detail · create · update · move)
[^platform-menus-controller]: /platform-menus routes and the menu permission per action (menu found by the path)
[^api-menu-urls]: API 권한 주소 — 경로 방식 @MenuPermission 컨트롤러의 경로 첫 단계(DiscoveryService)
[^menus-url-unique-migration]: 사용 중 메뉴 url 부분 유니크 인덱스(menus_url_active_key)
