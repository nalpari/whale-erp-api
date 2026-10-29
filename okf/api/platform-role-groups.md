---
type: API
title: Platform role groups
description: 관리자 웹 「플랫폼 권한 관리」(MN000214) — the fixed roles and 플랫폼 관리자 추가 권한, their names, per-menu CRUD with the caller's own ceiling, revocation from BP · 가맹 마스터 cascading into every BA · FA group, and deletion that moves linked admins to a replacement.
tags: [admin, permission, menu, role]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-29T04:44:34Z }
sources:
  - id: platform-role-groups-controller
    resource: ../../src/platform-role-groups/platform-role-groups.controller.ts
    title: /platform-role-groups routes and the menu permission per action (menu found by the path)
    last_modified: 2026-10-21T01:46:17Z
  - id: platform-role-groups-service
    resource: ../../src/platform-role-groups/platform-role-groups.service.ts
    title: PlatformRoleGroupsService (list · detail · create · update · deletionCandidates · remove)
    last_modified: 2026-10-29T04:44:34Z
  - id: platform-role-group-menus-service
    resource: ../../src/platform-role-groups/platform-role-group-menus.service.ts
    title: PlatformRoleGroupMenusService (tree · save · preview, revocation cascade)
    last_modified: 2026-10-29T04:44:34Z
  - id: role-menu-rules
    resource: ../../src/platform-role-groups/role-menu-rules.ts
    title: Pure menu rules — visible menus, group normalisation, cell block reasons, cascade
    last_modified: 2026-10-21T01:46:17Z
  - id: platform-role-group-format
    resource: ../../src/platform-role-groups/platform-role-group-format.ts
    title: Role types, controller path and menu URL, code numbering, list order, lock reasons, cascade child types
    last_modified: 2026-10-29T04:44:34Z
  - id: platform-role-group-access
    resource: ../../src/platform-role-groups/platform-role-group-access.ts
    title: Target lookup, flags, and the caller's own 권한 관리 rights (callerRoleMenuRights, by PLATFORM_ROLE_MENU_URL)
    last_modified: 2026-10-21T01:46:17Z
  - id: platform-role-group-dto
    resource: ../../src/platform-role-groups/dto/platform-role-group.response.dto.ts
    title: Response shapes — tree cells, blocked reasons, preview counts
    last_modified: 2026-10-15T09:38:26Z
  - id: platform-role-groups-e2e
    resource: ../../test/platform-role-groups.e2e-spec.ts
    title: Real-DB proof — next-request permission change, BA cascade, concurrent save, delete move
    last_modified: 2026-10-15T09:38:26Z
---

# What it covers

The 관리자 웹 menu MN000214 「플랫폼 권한 관리」 (`/platform-role-groups` — the seed's `/platform/system/roles` until `20261019144438_team1_menu_single_level_urls`; front
`system.md` 「플랫폼 권한 관리」, S-JDCOAG · S-EFQREM). It manages the platform BP's
role groups of type `PM` · `PA` · `BM` · `FM`: the fixed roles seeded by 1팀's initial
data — PM000001 · BM000001 · FM000001 (`is_master`) — and 플랫폼 관리자 추가 권한 (`PA`,
not master).
BA · FA groups belong to customer BPs and are made in BP 환경설정; they never appear
here — except as the target of a revocation cascade (below).[^platform-role-groups-service]

| Route | Menu permission | Answer |
|---|---|---|
| `GET /platform-role-groups` | 조회 | `{ items, total }` — fixed roles in PM · PA · BM · FM order, then additional roles by code; no paging |
| `POST /platform-role-groups` | 등록 | `{ name, description? }` → 201 `{ roleGroupId, roleCode }` |
| `GET /platform-role-groups/:id` | 조회 | summary + `isEditable`/`editBlockedReason`, `isDeletable`/`deleteBlockedReason` |
| `PUT /platform-role-groups/:id` | 수정 | `{ name, description?, updatedAt }` → 204. A whole replace: leaving `description` out **clears** it (NULL) — send the current text to keep it |
| `GET /platform-role-groups/:id/menus` | 조회 | tree by active service, every cell `{ value, editable, blockedReason }`, `isSavable`, `updatedAt` |
| `PUT /platform-role-groups/:id/menus` | 수정 | `{ menus: [{ menuId, read, create, update, delete }], updatedAt }` → 200 `{ updatedAt }` |
| `POST /platform-role-groups/:id/menus/preview` | 조회 | `{ menus }` → `{ revokedCells, affectedRoleGroupCount, affectedAdminCount }`, writes nothing |
| `GET /platform-role-groups/:id/deletion-candidates` | 조회 | `{ admins, candidates }` |
| `DELETE /platform-role-groups/:id` | 삭제 | `{ replacementRoleGroupId?, updatedAt }` → 204 |

Every route carries `@MenuPermission(action, { platformOnly: true })`
([admin authentication](/api/admin-auth.md)) — the guard finds the menu by the controller
path, `/platform-role-groups`, MN000214's URL: the menu right for that action, then an
active PM or PA **of the platform BP**. Anything else is 403 with the shared 「접근 권한이
없습니다…」. A BA group carrying an MN000214 row, or a `PM` account wrongly attached to a
customer BP, still gets 403. Until 2026-10-20 the handlers ran
`MenuPermissionsService.assert` (removed 2026-10-21) and `AdminScopeService.isPlatformAdmin` themselves and
passed the returned caller down; now the controller passes only `user.id`, and the two
services read the caller (role type, role group — for self-link, fixed-role and ceiling
checks) with `MenuPermissionsService.caller`, which answers 「사용할 수 없는 계정」 403 if
the account stopped after the guard.[^platform-role-groups-controller]

**403 now comes before 400 and 404.** The guard runs ahead of the validation pipe and
the id check, so a caller without the right gets 403 for a malformed body or an
out-of-range id where it used to get 400 or 404. Callers with the right see no
change.

Each list item carries `isMenuRegistered` (any non-deleted row with 조회 on, whatever
the service — a row under a 사용중지 menu or service counts, a deleted menu's row does
not), `createdBy` / `updatedBy` as
`{ name, loginId }` or null for seeded rows, and `adminCount` (non-deleted linked admins,
미사용 included — the delete dialog uses it).

# Status codes chosen

- **본인이 연결된 권한 → 403** 「본인이 연결된 권한이라 고칠 수 없습니다.」, for name edit,
  menu save and delete alike. It matches 플랫폼 관리자 관리's self protection, which is
  403 too. So a PM cannot touch PM000001 at all, while a PA with MN000214 수정 may edit
  PM000001's name and description.
- **Fixed role refusals → 409**: deleting any fixed role, saving PM000001's menus. The
  request is well-formed; the resource's state forbids it.
- **Rule violations in the body → 400**: hidden or unknown menu, the same menu twice,
  등록 · 수정 · 삭제 without 조회, a 플랫폼 menu for BM · FM, a cell outside the caller's own
  range, a missing or ineligible replacement.
- **Concurrency → 409** 「다른 관리자가 먼저 수정했습니다…」, duplicate name → 409
  「같은 이름의 권한이 있습니다.」.

Both blocked-reason fields are API-only enums in `GET /enums`:
`PlatformRoleMenuBlockReason` (`PM_FIXED` · `READ_ONLY` · `SELF_LINKED` ·
`PLATFORM_MENU_FOR_BP` · `OUT_OF_SCOPE`, in judging order) and
`PlatformRoleGroupLockReason` (`FIXED_ROLE` · `NO_PERMISSION` · `SELF_LINKED`). [BP role groups](/api/bp-role-groups.md) shares this enum and its labels; there `NO_PERMISSION` also covers a role that cannot write.

`NO_PERMISSION` and `READ_ONLY` come from the **caller's own rights on this screen's menu**,
and since 2026-10-21 that menu is found the way the guard finds it — by URL, not code:
`callerRoleMenuRights` (detail, edit, delete) and the menu tree's `canUpdate` look for the
caller's row on the active, undeleted menu whose `url` is `PLATFORM_ROLE_MENU_URL`
(`/platform-role-groups`, MN000214 today).[^platform-role-group-access] The constant is
derived from `PLATFORM_ROLE_GROUPS_PATH`, which is also the controller's `@Controller`
path, so the screen's "can I edit" and the guard's "may you edit" cannot drift apart by a
renamed path. Two traps: the `ACTIVE` filter is required — URLs are unique only among
active menus, so an inactive menu may hold the same address and its row must not count —
and if the guard's menu is switched off, both sides agree that nobody may edit (the guard
403s anyway). The URL itself can no longer be moved from 플랫폼 메뉴 관리 (an API-bound
address, [platform menus](/api/platform-menus.md)).

# Creating: only PA additional roles

The body takes no type, and the API never creates a fixed role. The policy names four
fixed roles (PM · PA · BM · FM), but 1팀's initial data seeds only PM000001 · BM000001 ·
FM000001, and **no PA000001 is seeded** — so the first PA role created here gets
`PA000001` as an ordinary additional role (`is_master = false`), deletable like any
other. Nothing in the code looks for a role by the code `PA000001`; "fixed" always means
`is_master`, so if a PA fixed role is ever seeded, the delete and replacement rules
apply to it without a code change — **but not under the code `PA000001`**: `role_code`
is unique across all rows, deleted ones included, so once any PA role exists in a
database, a seed inserting `PA000001` fails there. Such a seed has to take the next free
code, or run before the first PA role is created. The code is `PA` + 6 digits, one past the highest `PA` code **including deleted
groups** (a deleted number is never reused), taken under
`pg_advisory_xact_lock(hashtext('role_groups:role_code:PA'))`. Past 999999 is 409. A BP
side screen should lock `role_groups:role_code:BA` (or `FA`) the same way.

Names are trimmed, 1–20 characters, no NUL; descriptions 100, empty → NULL. Uniqueness
follows the partial unique index (`bp_code_id`, `manager_admin_account_id`, `name`)
NULLS NOT DISTINCT over undeleted rows — for platform groups that is "all PM · PA · BM ·
FM" — checked first for a clean 409. A P2002 from a race becomes the same 409 only after
asking again whether the name is now taken: `role_groups` has a second unique key
(`role_code`), and a code clash written past the advisory lock is not a name problem, so
it is rethrown as a 500 instead of telling the user to pick another name forever. A
missing platform BP row is a 500 naming the 1팀 initial-data migration.

# Menu cells

**Visible menus only.** The tree and the save use the same set: menus not deleted, in
use, of a service active in the platform BP's `SERVICE` codes, and with every ancestor
visible. A hidden menu sent in the body is **400, not ignored** — the front only has the
tree, so a hidden id means a bug or a forged request; silently dropping it would hide
that. Rows of hidden menus are **preserved**: they are never in the diff, so turning a
menu or service back on shows the old setting (PM000001's seed already has rows under
the inactive MN000204). If `SERVICE` is missing or has no active value — it is a
플랫폼고정 group, so that is broken data — the tree, save and preview answer 500 naming
it, rather than an empty tree and a 400 on every line.

**The body is a list, not a diff.** Each line is a whole row; the server overlays the
lines on the current rows and computes the changed cells itself. Menus left out keep
their values.

**Group menus are normalised.** A menu with visible children takes 조회 = "any visible
child has 조회", 등록 · 수정 · 삭제 = false, computed bottom-up. Whatever the client sends
for a group line is ignored. This matches 1팀's seed; the popup's "turn on the group to
apply to its children" is the front's job.

**등록 · 수정 · 삭제 need 조회** on every non-group line, or 400.

**Turning everything off keeps the row** with four `false` flags rather than setting
`is_deleted`; the guard reads the flags, so both behave the same, and
re-enabling needs no special path. Rows are written with `upsert` because a row with
`is_deleted = true` is invisible to the read (`grantsOf`) yet still holds the
(group, menu) primary key, so a plain create would collide with it.

**PM000001 is shown as all allowed and read-only**: the tree returns every leaf cell
true and groups 조회 only, blocked `PM_FIXED`, regardless of the stored rows. Saving it
is 409.

**BM000001 · FM000001 may not hold 플랫폼 menus** (`service_code = 'PLATFORM'`): turning
one on is 400, and the tree blocks those cells with `PLATFORM_MENU_FOR_BP` — but only while
they are off. A cell that is already on (a row put there by hand or before this rule) stays
editable so it can be turned off, which the save accepts; tree and save judge the same way.

## The caller's own ceiling

When a **PA caller** changes a **PA-type** group (every additional role),
each changed cell — turning on **and** turning off, as the mockup's `blockOf` — must be on
in the caller's own group for the same menu and action, or 400 「본인 권한 범위 밖 칸은
바꿀 수 없습니다」. Group lines are exempt: they follow their children, which carried the
check. A PM has no ceiling. BM000001 · FM000001 get none either (SYSTEM-6): any platform
user with MN000214 수정 sets them. No PA fixed role caps the additional roles
(2026-10-06). In the tree a blocked cell shows `OUT_OF_SCOPE`; a group cell is open if
any leaf below it is open. A 조회 cell that is on is also `OUT_OF_SCOPE` when any of the
line's 등록 · 수정 · 삭제 is on outside the caller's range: turning 조회 off turns those off
too, and the save would refuse that cell with 400 — so the tree does not offer it.

## Revoking from BP · 가맹 마스터 cascades

BM000001's and FM000001's settings are the ceiling of every BA and FA group, one for the
whole platform. So in the **same transaction** as the save, every cell turned off on
BM000001 (FM000001) is turned off in **every customer BP's undeleted BA (FA) group** for the
same menu and action; turning 조회 off turns the whole line off. If that leaves a group
menu in a BA (FA) group with no child 조회, its 조회 is turned off too — the fixed role may
still have the group on through another child, but the BA group should not keep an empty
group menu in its `login-info`. The cascade only turns things off, never on. Each touched
group gets `updated_by` moved. PA-type groups have **no** cascade. The child type comes
from `CASCADE_CHILD_TYPE` keyed by `BpMasterType` only: an unknown key would leave Prisma a
`roleTypeCode: undefined`, which it reads as "no condition" — every group of every BP — so
the type, not a runtime check, rules that out.

The preview runs the same calculation without writing, and the same checks: a change the
save would refuse is refused here too with the same status — PM000001 409, a 플랫폼 menu
for BM · FM or a cell outside a PA caller's range 400 — so the screen learns it before
saving. It counts:

- `revokedCells` — cells going from on to off, counting each action of each menu,
  group lines included;
- `affectedRoleGroupCount` — undeleted BA (FA) groups in any BP where the cascade would
  actually change a row;
- `affectedAdminCount` — undeleted admins (미사용 included) linked to those groups,
  **plus** those linked to the fixed role itself.

When nothing is revoked all three are 0 — the fixed role's own admins are not counted, so
the screen can warn on `affectedAdminCount` alone. For any other role both counts are 0.

# Saving and concurrency

Name edits and menu saves share `role_groups.updated_at`. The menu save starts by
`updateMany … WHERE updated_at` in the sent millisecond (`sameMillisecond`), which both
checks and row-locks; only then does it read the current rows and compute the diff, so
two saves cannot both apply against the same "before". The response returns the new
`updatedAt`; the screen must use it — or reload — for its next save, or it gets 409.

Permission changes reach linked admins **from the next request**, no re-login: the
guard reads `role_group_menus` every time (the e2e
turns MN000213 조회 off and the member's `GET /platform-admins` becomes 403 at once).

# Deleting

Only additional roles: a fixed role **or any non-PA row** (say a non-master BM put in by
hand) → 409, so admins are never moved into a role of another type; the detail's
`deleteBlockedReason` uses the same rule. Self-linked → 403. Inside one transaction the target
and replacement rows are locked `FOR UPDATE` (ordered by id), which serialises two
deletes or a delete and a menu save — and, since registration and edit lock the group
`FOR SHARE`, a 플랫폼 관리자 registration or edit too (see Traps). Then `updatedAt` is compared, the replacement validated (undeleted, platform
BP, `PA`, not master — a PA fixed role, if one is ever seeded, would widen the users'
rights, not itself) even when no admin is linked, and if linked admins exist and no
replacement was given → 400. The linked admins are read inside the lock with `FOR NO KEY
UPDATE` on their own rows (미사용 included), and move
in one `updateMany` **by those ids**, each getting an `admin_change_histories` 「사용자 권한」
row (`name code` before and after, as 플랫폼 관리자 관리 writes it) — the moved set and the
history set are the same; the group's menu rows and the group get `is_deleted`.

`deletion-candidates` lists the same admins and the other undeleted additional PA roles,
and refuses (409) a role that cannot be deleted.

A name edit or menu save that finds no row at the sent `updatedAt` looks again: if the
group was deleted meanwhile the answer is 404, not 409 — reloading would not help.

# History

**Not recorded yet.** The policy asks for a role-group change history (변경 전후 ·
변경자 · 일시, not shown on screen — S-JDCOAG), but 1팀's ERD has no table for it, so
this module writes none: no table is invented ahead of the ERD. The only trace of a
change is `role_groups.updated_by` / `updated_at`, plus the 「사용자 권한」 rows in
`admin_change_histories` when a delete moves admins. When 1팀's ERD gains the table,
creation, name and description edits, menu saves (including cascaded BA · FA rows) and
deletion are the points to record.

# Traps and open work

- **A new menu needs a PM000001 row.** The tree shows PM000001 as all-allowed, but the
  guard reads real rows; a menu created without a PM000001 row is invisible
  to the platform master despite what this screen shows. [플랫폼 메뉴 관리](/api/platform-menus.md)
  inserts that row when it creates a menu; a menu put in by migration still needs its own.
- **The guard ignores an inactive parent menu or service.** It checks only
  the menu's own row and status, so a leaf under a 사용중지 parent still passes. This
  screen hides such menus, but an existing row keeps working on the API side.
- **Delete and 플랫폼 관리자 registration · edit wait for each other.** Registration, and an
  edit that changes the role group, lock the group `FOR SHARE` inside their transaction
  before checking it ([platform admins](/api/platform-admins.md)); delete holds it `FOR UPDATE`.
  A delete that locked first makes the other side re-read after its commit and answer 400; a
  registration that locked first makes the delete wait and then read that admin too — moved
  with the others when a replacement was chosen, 400 「연결 사용자가 있어 대체 권한을 골라야
  합니다」 when none was. That second half holds only because the delete reads the linked admins
  **after** taking the lock — keep that order. Until 2026-10-27 they read the group without a
  lock, and one that read before the delete committed attached an admin to the deleted group
  (the foreign key passes: the row stays), leaving an account that got 403 on every menu. BP
  관리자 관리 does the same (`lockRoleGroup`, #160). "No admin joins meanwhile" holds as long as
  every path writing `role_group_id` locks the group `FOR SHARE` — a new one must too.
- **An edit leaving the group is waited for, not overwritten.** The edit locks only the group
  it moves to. So the delete reads the linked admins with `SELECT … FOR NO KEY UPDATE` on
  `admin_accounts`: an uncommitted edit moving one away holds that row, the delete waits, and
  PostgreSQL re-checks `role_group_id` after the commit and leaves the admin out. Until
  2026-10-27 that read took no lock, and the `updateMany` (whose `where` names ids, not the
  group) moved the admin to the replacement anyway — the group chosen in the edit was lost
  with no error, and the history claimed a 「사용자 권한」 change from the deleted group.
  **Not `FOR UPDATE`:** an edit by an admin of that group writes `updated_by` ·
  `changed_by` to them, and the foreign key check takes `FOR KEY SHARE` on that row.
  `FOR UPDATE` conflicts with it, so an edit holding the moved admin's row while waiting for
  its editor's row, against a delete holding the editor's row while waiting for the moved
  admin's, deadlocks (40P01 → 500). `FOR NO KEY UPDATE` lets the key share through and still
  waits for the edit's `UPDATE` — the same reason as 플랫폼 관리자's
  `assertAnotherActiveMaster` (found by the PR #165 adversarial review, in a lock added the
  same day).
- The BP-side 권한 그룹 screen (BA · FA, capped by BM000001 · FM000001) is
  [BP role groups](/api/bp-role-groups.md); this module enforces the cap by cascading
  revocations.

# Shared with BP role groups

[BP role groups](/api/bp-role-groups.md) imports this module's menu functions rather than copying
them: `loadCatalog` (with a service filter — BP uses WHALE_ERP only), `menuTreeServices` (the tree
builder, given a value and a cell-block callback), and `submittedCells` · `planAfter` ·
`assertAllowed` · `idsOf`. A change to those changes both screens.

[^platform-role-groups-service]: PlatformRoleGroupsService
[^platform-role-groups-controller]: /platform-role-groups routes and the menu permission per action (menu found by the path)
[^platform-role-group-access]: Target lookup, flags, and the caller's own 권한 관리 rights (callerRoleMenuRights, by PLATFORM_ROLE_MENU_URL)
