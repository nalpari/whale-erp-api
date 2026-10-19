---
type: API
title: Platform menus
description: 관리자 웹 「플랫폼 메뉴 관리」(MN000215) — service tabs from 공통코드 SERVICE, the per-service menu tree, detail, create (global code numbering plus a PM000001 row), editing name · URL · status, and moving a menu with its subtree inside one service.
tags: [admin, menu, permission]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-19T01:09:23Z }
sources:
  - id: platform-menus-controller
    resource: ../../src/platform-menus/platform-menus.controller.ts
    title: /platform-menus routes and the MN000215 permission per action
    last_modified: 2026-10-19T01:09:23Z
  - id: platform-menus-service
    resource: ../../src/platform-menus/platform-menus.service.ts
    title: PlatformMenusService (services · tree · detail · create · update · move)
    last_modified: 2026-10-19T01:09:23Z
  - id: platform-menu-rules
    resource: ../../src/platform-menus/platform-menu-rules.ts
    title: Pure rules — code numbering, URL overlap, hidden menus, move plan
    last_modified: 2026-10-19T01:09:23Z
  - id: platform-menu-format
    resource: ../../src/platform-menus/platform-menu-format.ts
    title: Menu code · URL pattern · messages
    last_modified: 2026-10-19T00:51:03Z
  - id: platform-menu-dto
    resource: ../../src/platform-menus/dto/save-platform-menu.dto.ts
    title: Input rules — name 20, URL pattern, move body
    last_modified: 2026-10-19T00:51:03Z
  - id: platform-menus-e2e
    resource: ../../test/platform-menus.e2e-spec.ts
    title: Real-DB proof — numbering, PM row, URL overlap, optimistic edit, concurrent create, move renumbering without a version bump
    last_modified: 2026-10-19T01:09:23Z
---

# What it covers

The 관리자 웹 menu MN000215 「플랫폼 메뉴 관리」 (`/platform/system/menus`, front
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

Every route runs `MenuPermissionsService.assert(user, 'MN000215', action)` and then
`AdminScopeService.isPlatformAdmin`, as 플랫폼 권한 관리 does: a BA group carrying an MN000215
row, or a `PM` account on a customer BP, still gets 403. There is **no delete** — a menu
nobody uses is set to 사용중지 (F-CWWQUR) — and **no change history**, by policy.

# Decisions taken on 2026-10-16

The specification left these open; the user decided them when this was built.

- **Codes are global**: `MN` + 6 digits, one past the highest code of any service,
  deleted rows included. The mockup counts the same way. Per-service ranges were
  rejected — WHALE_ERP would run into PLATFORM's range at MN000200, and two codes
  (MN000007 · 008) were physically deleted, so only "highest + 1" guarantees a deleted
  number never returns (PL-EIMSQF).
- **Turning off this screen's own menu is allowed.** Nothing stops `PUT` from setting
  MN000215, MN000214 or their parent MN000212 to `INACTIVE`. `assert` and the guard look
  only at the requested menu's own status, so the result differs per menu:
  - **MN000215 off** — from the next request everyone, the platform master included, gets
    403 here, and only a database `UPDATE` brings it back.
  - **MN000214 off** — 플랫폼 권한 관리 answers 403, but this screen still works and can turn
    it back on.
  - **MN000212 off** — both children drop out of 관리자 웹's menu, while their APIs keep
    passing (see the hidden-menu trap below); this screen can turn it back on.
- **URL**: one segment only — `/` then lowercase · digit · `-` (`^/[a-z0-9-]+$`, ≤ 200), so
  `/staff-content`, not `/staff/content` (user decision 2026-10-19, create and edit alike; the
  seed's multi-segment URLs stay, but saving such a menu needs a one-segment URL first);
  blank becomes NULL. Among **active** menus of **any** service, two URLs may not be equal
  or one a path under the other (`/stores` vs `/stores/x`) → 409 naming the other menu's
  code. 관리자 웹 decides menu permission by URL prefix, so an overlap would let the upper
  menu's 조회 open the lower screen — the same rule 3팀's menu migrations check in their
  `DO` blocks. Inactive menus are not compared, so the old 1팀 seed overlaps among
  사용중지 menus stay legal, and turning such a menu back on is where the 409 bites.
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
  사용중지. `assert` looks only at the menu's own status, so a leaf under a 사용중지 parent still
  passes the API while 관리자 웹 no longer shows it.
- **e2e cleanup** (any PostgreSQL): menus are re-collected by `created_by` of the suite's
  admins, so a request that was expected to fail but created a menu after a regression is
  removed too — otherwise `created_by` blocks deleting the admins and the rest of the
  cleanup stops. Seed menus' `updated_by` is cleared before the admins go. Deleting
  leaf-first throws, naming the menus left, when a round finds nothing to delete, instead
  of looping forever. The app is closed in `finally`, or jest never exits.

[^platform-menus-service]: PlatformMenusService (services · tree · detail · create · update · move)
