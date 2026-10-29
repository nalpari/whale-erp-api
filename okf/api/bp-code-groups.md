---
type: API
title: BP code groups
description: 관리자 웹 「BP 공통코드 관리」(MN000014) — groups are read-only and only in-use 플랫폼제공 groups are visible (플랫폼고정 is hidden, 404); every such group (applied or not) shows the BP's own rows, where the BP edits name · status · order, adds BP전용 codes and deletes its rows; platform users read a picked BP only.
tags: [admin, codes, bp]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-29T04:44:34Z }
sources:
  - id: bp-code-groups-controller
    resource: ../../src/bp-code-groups/bp-code-groups.controller.ts
    title: /bp-code-groups routes — menu by the path (MN000014), target BP from X-Bp-Code-Id, POST create · PUT update · DELETE
    last_modified: 2026-10-27T02:13:42Z
  - id: bp-code-groups-service
    resource: ../../src/bp-code-groups/bp-code-groups.service.ts
    title: Which groups and rows a BP sees, BP전용 creation, edits and deletion
    last_modified: 2026-10-29T04:44:34Z
  - id: bp-code-groups-e2e
    resource: ../../test/bp-code-groups.e2e-spec.ts
    title: Real-DB proof — visibility (플랫폼고정 hidden), other-BP 403, platform read-only, overlap 409, concurrent create · delete · restore
    last_modified: 2026-10-27T05:08:14Z
---

# What it covers

`/bp-code-groups` is the BP side of 공통코드, the counterpart of 플랫폼 공통코드 관리
(`/code-groups`, [Whale ERP API](/api/whale-erp-api.md)). The rules come from whale-erp-new-front's
「BP 환경설정」 area (`okf/config.md` 공통코드 lines — S-FHVSAV · F-QPDEWN · PL-VOCZCE · CONFIG-7 —
and the mockup `docs/mockup/config/codes.html`); that repository is not a source here, so the
reference stays in the text. No table changed — the rows are the same
`code_groups` · `code_items` the platform screen writes.

| Route | Right | What |
|---|---|---|
| `GET /bp-code-groups?groupCode=&groupName=&manageOwnerCodes=&page=&pageSize=` | read | groups the BP sees, `{ items, total }`. `manageOwnerCodes` (repeat · comma parsing inherited from the platform DTO; the front BP screen does not send it, 2026-10-27) takes only `PLATFORM_PROVIDED` — `PLATFORM_FIXED` or `BP_ONLY` is 400, so a hidden group cannot be asked for by condition. The service still filters within the visible groups for any other caller |
| `GET /bp-code-groups/{groupCode}/items` | read | that group's items for the BP, `{ items, total }` |
| `POST /bp-code-groups/{groupCode}/items` | create | `{ items }` — new BP전용 codes, 204 |
| `PUT /bp-code-groups/{groupCode}/items` | update | `{ items }` — edits to the BP's rows, 204 |
| `DELETE /bp-code-groups/{groupCode}/items` | delete | `{ itemCodes }` — logical delete of the BP's own rows (BP전용 or copied 플랫폼제공), 204 |

**Creating and updating are separate routes**, as on the platform screen (2026-10-22, 사용자
요청): a panel save with both new and edited rows calls twice, and the two are separate
transactions. The bodies reuse the platform DTOs (`CreateCodeItemsDto` · `UpdateCodeItemsDto`,
1–500 rows of `CodeItemInputDto`), and the path's group code goes through the same
`groupCodeOf` (trim, upper-case, malformed → 404 without a query).[^bp-code-groups-controller]

# Who calls it

The guard finds the menu by the controller path — `menus.url` `/bp-code-groups`, MN000014 — so
`/bp-code-groups` joined the API permission addresses that 플랫폼 메뉴 관리 cannot move
([Platform menus](/api/platform-menus.md)). MN000014 is a `WHALE_ERP` menu, so the guard also
fixes the target BP from `X-Bp-Code-Id` ([Admin authentication](/api/admin-auth.md)) and the
handlers read it with `@TargetBp()`. The seeded rights: PM000001 and BM000001 have all four,
FM000001 read only.

- **BP · 가맹 accounts** see their own BP; another BP in the header is the guard's 403.
- **Platform users (PM · PA)** pick a BP with the header and **read only**. Without the header
  the guard leaves the platform BP, which this screen refuses with 400 「공통코드를 볼 BP 를 골라
  주세요」 — the platform BP's codes are 플랫폼 공통코드 관리's. A create, update or delete is 403
  「플랫폼 사용자는 BP 공통코드를 조회만 할 수 있습니다.」 even though PM000001 holds the
  rights — the policy (F-QPDEWN) is stricter than the seeded row. That 403 comes first: before
  the missing-header 400 and before any group 404 (e2e).[^bp-code-groups-service]

# Which groups and rows a BP sees

Groups are made by the platform and never added, edited or deleted here. The list holds
**every undeleted, in-use (사용) 플랫폼제공 group**, ordered by `sort_order` then `group_code`.
A 플랫폼고정 or 사용중지 group is simply not there: it leaves `items` and `total`, and its items,
create, update and delete routes are 404 「공통코드 그룹을 찾을 수 없습니다.」 like a deleted group.

How it got here: until 2026-10-22 only 플랫폼제공 groups marked applied were listed and 사용중지
groups were listed read-only; 2026-10-22 (1팀 요청, A안) listed every in-use 플랫폼고정 and
플랫폼제공 group, 플랫폼고정 read-only (writes 409 「플랫폼고정 그룹은 조회만 할 수 있습니다」);
2026-10-27 (사용자 결정) hid 플랫폼고정 — a BP cannot change those system codes, so the screen
has nothing to offer for them. **This is the screen's set only.** What business screens read —
login-info's 공통코드 ([Admin authentication](/api/admin-auth.md)) — still serves 플랫폼고정 groups
from the platform originals, and 플랫폼 공통코드 관리 (`/code-groups`) is unchanged. Neither the group's `is_bp_applied` flag nor whether this BP has
rows decides it: a 플랫폼제공 group the BP has no copy of yet shows an empty item list until
[BP에 적용] fills it, and the BP may already add BP전용 codes to it. `groupCode` and `groupName`
search by case-insensitive containment with LIKE wildcards taken literally (`containsText`) —
the same `ListCodeGroupsDto` as 플랫폼 공통코드 관리's list.

Items are **the BP's own rows** — the same rows `CodesService` serves login-info for a
플랫폼제공 group, so the screen and the business screens' choices agree: those copied at signup (every 플랫폼제공 group, applied or
  not — [BP signup](/api/admin-signup.md)) or by [BP에 적용], plus its BP전용 additions. Codes
  the platform added after the copy are not there and do not appear until the group is applied
  again;
  the BP sees only its edited values, never the platform's next to them (CONFIG-7).

사용중지 rows are included. Each item carries its `manageOwnerCode` (`PLATFORM_PROVIDED` for a
copied platform code, `BP_ONLY` for a BP addition or restore) and `isPlatformInactive` — whether the platform
original of that code is 사용중지 (always false for BP전용). It is information only: the BP sets
the status of its 플랫폼제공 rows freely, platform-stopped or not (2026-10-22 결정 — the mockup's
「플랫폼이 사용 중지한 코드는 토글이 비활성」 no longer holds).

# Writing

Every visible group is writable — they are all 플랫폼제공; a 플랫폼고정 or 사용중지 group is not
visible (404). Codes never change after creation; an owner changes only when a deleted
copied 플랫폼제공 row is registered again and comes back as BP전용 (below). The BP's rows of the group — BP전용 and copied 플랫폼제공 alike — can be deleted
(2026-10-22, 사용자 요청).

- **Create** writes rows with `bp_code` = the BP and `manage_owner_code = BP_ONLY`. A code may
  not repeat in the request, nor match a **live** row — the BP's own or the group's platform
  original. Deleted rows do not count (2026-10-22 결정): a code matching **this BP's deleted row**
  brings that row back — `is_deleted` cleared, the request's name · status · order written, and
  its owner set to `BP_ONLY` (2026-10-22, 사용자 요청: a deleted copied 플랫폼제공 code the BP
  registers again is the BP's own code now, even while the original lives; a later [BP에 적용]
  skips the key, so it stays BP전용) — and a deleted platform original is simply ignored. This
  applies to any deleted row of the BP, BP전용 included, so a restore can leave a BP전용 row next
  to a live platform original with the same code (see Known edges). The 409 message says which live row, checked
  in this order, each listing every such code in request order (`: A, B` — the screen reads the
  codes after the colon): a live platform original 「플랫폼이 등록한 상세 코드와 겹칩니다」, a live row
  of this BP 「이 그룹에 이미 있는 상세 코드입니다」. Nothing is restored when any code is refused.
  A restore is conditioned on the row still being deleted, so two admins bringing back the same
  code at once give one 204 and one 409 「이미 있는」. A live original
  blocks even when the BP never received that code: otherwise a re-application would skip it for
  this BP because the key (group, code, BP) is taken, and the BP's own meaning would silently
  stand in for the platform's. Check and insert share a transaction; a code inserted in between
  by another admin of the same BP is caught by `createManyAndReturn` + `skipDuplicates` and
  answered 409 naming only the codes that lost (unit-tested with mocks). The e2e sends the same
  code twice at once and proves only that one row is made and the other gets 409 — on the
  throwaway PGlite it cannot tell which of the two paths answered.[^bp-code-groups-e2e]
- **Update** touches only the BP's undeleted rows of the group (anything else 404 — including a
  platform code the BP never received) and only name, status and order. The status is the BP's
  to set: a code whose platform original is stopped can be switched on (2026-10-22 결정 — the
  earlier 409 「플랫폼이 사용 중지한 코드는 다시 사용으로 바꿀 수 없습니다」 is gone). Each row's
  write is itself conditioned on the row still being undeleted, so an edit racing another
  admin's delete is 409 「다른 관리자가 먼저 지운 상세 코드가 있습니다 — 다시 불러온 뒤 저장해 주세요:
  CODE」 rather than a 204 that wrote to a deleted row (unit-tested with mocks).
- A code repeated within one body is 409 「한 요청에 같은 상세 코드가 두 번 있습니다」, on create,
  update and delete alike — after the BP and group checks but before any item row is read, and with a
  different message from a code that already exists, so the screen can tell its own duplicate
  row from a taken code.

- **Delete** (`DELETE … { itemCodes }`, 1–500 codes, trimmed and upper-cased like create, the
  `DeleteCodeItemsDto` the platform screen also uses) sets `is_deleted` on the BP's own undeleted
  rows — BP전용 or copied 플랫폼제공; the platform original and other BPs are untouched. A code the
  BP does not have — another BP's, or one already deleted — is 404; a platform user is 403 like
  create and update. [BP에 적용] never revives a deleted row (it skips the key); registering the
  same code again does (above). The
  update is conditioned on the rows still being undeleted; if another admin deleted one in between,
  fewer rows change and the whole request is
  409 「다른 관리자가 먼저 지운 상세 코드가 있습니다 — 다시 불러온 뒤 삭제해 주세요.」 instead of a
  partial delete. Two admins deleting the same code at once give one 204 and a 404 or 409 (e2e).

All three are all-or-nothing in one transaction. Update and create write row by row — up to 500
updates, or restores on create — so both transactions get 30 seconds (`BULK_UPDATE_TX`, as on the
platform screen) instead of Prisma's 5, which a remote database can exceed and turn into an
unexplained 500.
Nothing is written to a history table yet, as on the platform screen.

# Known edges

- A platform admin creating the same code in the platform original at the same moment as a BP
  creates its BP전용 code is not serialised: the keys differ by BP, so both rows can exist. The
  platform's create checks every BP's rows first, so this needs the two check-then-insert
  windows to overlap.
- A BP that existed before a 플랫폼제공 group got codes — or was not in use when the group was
  applied — sees the group with no items. Signup copies every 플랫폼제공 group's originals (from
  2026-10-22), but nothing reaches BPs that already exist until [BP에 적용] is pressed. Such a
  BP can add BP전용 codes meanwhile; a later application brings it the platform codes and skips
  any code it already has. The same holds for login-info's 공통코드, which no longer falls back to
  the originals for an unapplied 플랫폼제공 group (2026-10-22 결정: kept as intended, no data
  migration — after this ships, press [BP에 적용] once on each 플랫폼제공 group in the shared
  database so existing BPs get their rows).
- A BP restoring its own deleted row is not stopped by a live platform original of the same code
  (2026-10-22, 사용자 결정 — a code the BP deleted and registers again is the BP's). The row comes
  back as BP전용 beside the original, and [BP에 적용] keeps skipping that key for this BP — the
  same state the platform's create otherwise refuses for a fresh BP전용 code.

[^bp-code-groups-controller]: /bp-code-groups routes — menu by the path (MN000014), target BP from X-Bp-Code-Id, POST create · PUT update · DELETE
[^bp-code-groups-service]: Which groups and rows a BP sees, BP전용 creation, edits and deletion
[^bp-code-groups-e2e]: Real-DB proof — visibility (플랫폼고정 hidden), other-BP 403, platform read-only, overlap 409, concurrent create · delete · restore
