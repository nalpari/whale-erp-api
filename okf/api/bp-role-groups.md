---
type: API
title: BP role groups
description: 관리자 웹 「BP 권한 그룹 관리」(MN000013) — BA · FA groups scoped by the caller's role, codes numbered per type, names unique per (BP, 관리계정), per-menu CRUD capped by the fixed role ∩ the caller's own rights, and deletion that moves linked admins.
tags: [admin, permission, menu, role]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-30T05:58:47Z }
sources:
  - id: bp-role-groups-controller
    resource: ../../src/bp-role-groups/bp-role-groups.controller.ts
    title: /bp-role-groups routes and the MN000013 permission per action
    last_modified: 2026-10-30T02:27:29Z
  - id: bp-role-group-access
    resource: ../../src/bp-role-groups/bp-role-group-access.ts
    title: Caller scope, visible groups, writable type, cell block reasons, ceiling intersection
    last_modified: 2026-10-29T05:17:36Z
  - id: bp-role-groups-service
    resource: ../../src/bp-role-groups/bp-role-groups.service.ts
    title: BpRoleGroupsService (list · detail · create · update · deletionCandidates · remove)
    last_modified: 2026-10-30T05:58:47Z
  - id: bp-role-group-menus-service
    resource: ../../src/bp-role-groups/bp-role-group-menus.service.ts
    title: BpRoleGroupMenusService (tree · save · preview · franchise-master view)
    last_modified: 2026-10-29T05:17:36Z
  - id: bp-role-group-dto
    resource: ../../src/bp-role-groups/dto/bp-role-group.response.dto.ts
    title: Response shapes extending the platform DTOs (roleTypeCode narrowed)
    last_modified: 2026-10-30T01:57:17Z
  - id: bp-role-groups-e2e
    resource: ../../test/bp-role-groups.e2e-spec.ts
    title: Real-DB proof — five roles' scope, FA names per 가맹 마스터, ceiling 400, delete move
    last_modified: 2026-10-21T09:00:00Z
---

# What it covers

`/bp-role-groups` manages a customer BP's BP 관리자 (BA) and 가맹 관리자 (FA) groups, in the same
shape as [Platform role groups](/api/platform-role-groups.md): list · detail · create · rename ·
delete with a replacement, the menu popup's tree · save · preview, plus a read-only view of
FM000001. The request is the 2026-10-20 「BP 권한 그룹 API 요청서」(제영). No table changed.

# Two checks, and who does which

Every route carries `@MenuPermission(MN000013, action)` (no `platformOnly` — platform users read here),
then the service reads the caller (`MenuPermissionsService.caller`) and applies the
role scope. **Button visibility is the screen's job**: 관리자 웹's `usePagePermission()` already
holds the caller's MN000013 rights from login-info, and the api answers only the role part —
`creatableRoleTypeCode` on the list, `isEditable` · `isDeletable` on the detail, `isSavable` and
`READ_ONLY` on the tree. The screen ANDs them (`can.update && detail.isEditable`). That is why
this module does not read the caller's MN000013 row the way the platform one reads MN000214
(`callerRoleMenuRights`), and why the request's `canCreate` does not exist.

The seeded FM000001 has MN000013 read · create · update but no delete, so a 가맹 마스터's delete
is a 403 at the menu check; the screen hides the button with `can.delete`. The data is kept.

| Caller | Sees | Writes | Creates |
|---|---|---|---|
| PM · PA | the `X-Bp-Code-Id` BP's BA + FA (required, 400 without) | nothing | — |
| BM | own BP's BA + FA | that BP's BA | BA |
| BA | own BP's BA + FA | nothing | — |
| FM | FA whose 관리계정 is the caller | those FA | FA (관리계정 = caller) |
| FA | FA of its linked 가맹 마스터 (none linked → 403) | nothing | — |

**The BP comes from the header, not a query** (2026-10-21, 탭 BP 경로 방식 2단계). MN000013 is a
`WHALE_ERP` menu, so `MenuPermissionGuard` sets the target BP from `X-Bp-Code-Id` and the
controller takes it with `@TargetBp()` — see [admin authentication](/api/admin-auth.md). A BP or
가맹 caller sending another BP gets 403 from the guard; a platform caller sending a missing,
deleted or the platform BP gets 404 from the guard, and sending none reaches the service with the
platform BP, which answers 400 「권한 그룹을 볼 BP 를 골라 주세요.」 — this screen has nothing to show
for the platform BP. The `bpCodeId` query the request first had is gone. A group outside the scope — another
가맹 마스터's FA, a fixed role, a platform role, a deleted group — is 404, so an id does not
reveal that it exists. The role check runs before the self-link check, so a caller who cannot
write sees `NO_PERMISSION` even on its own group; `SELF_LINKED` only appears for a writable
group the caller is linked to — and only for delete and menu save. Name and description of one's
own group are editable (재영 2026-10-30, as on [platform role groups](/api/platform-role-groups.md)),
so `editBlockedReason` is `NO_PERMISSION` or null. `NO_PERMISSION` keeps the platform label 「권한 관리 메뉴 권한
없음」 — one enum serves both screens' popups, and on this screen it also covers a role that cannot
write (a wider label was tried and dropped on 2026-10-21 so the platform screen stays as it was).

# Names and codes

The name is unique per (`bp_code_id`, `manager_admin_account_id`) among undeleted rows — the
partial unique index the 1팀 initial migration already has, `NULLS NOT DISTINCT`. BA rows have no
manager and FA rows carry their 가맹 마스터, so BA names, and each 가맹 마스터's FA names, are judged
separately; no new index was needed. The service asks first for a clean 409 and turns a unique
violation that turns out to be the name into the same 409.

Codes are the type + 6 digits, the next after the last code of that type including deleted ones,
under `pg_advisory_xact_lock(hashtext('role_groups:role_code:BA|FA'))` — the key rule the platform
module reserved for this screen.

# Menus

The tree holds only active WHALE_ERP menus (no per-BP service data exists yet); settings on
hidden menus survive a save. A cell's ceiling is **the fixed role ∩ the caller's own group**:
BM000001 for BA, FM000001 for FA, intersected with the caller's grants. Out of the ceiling is
`OUT_OF_SCOPE`, the same value the platform PA ceiling uses — there is no `OUT_OF_BASE_ROLE`.
BM000001 grants every WHALE_ERP leaf in full today, so for a BM the ceiling never bites; FM000001
does leave cells off.

Saving reuses the platform functions (`submittedCells`, `planAfter`, `assertAllowed`), so the
checks are the same: write without read, a hidden menu, a menu twice, or a changed cell outside
the ceiling is 400; a stale `updatedAt` is 409. BA · FA have no child groups, so preview's
`affectedRoleGroupCount` is always 0 and `affectedAdminCount` is this group's admins — 0 when
nothing is revoked, as on the platform side.

# Differences from the request

- `adminCount` keeps the platform meaning (undeleted admins, inactive included), not 「활성」.
- `menuCount` · `isMenuRegistered` count only rows with 조회 on under a 사용 (`ACTIVE`) menu, as
  on the platform side — the permission kept under a 사용중지 menu is not counted, so the list's
  「등록 N개」 matches the checked cells in the 메뉴설정 popup (2026-10-30 재영).
- No new partial unique index; the existing one already has this scope.
- No `canCreate`, no `OUT_OF_BASE_ROLE` (see above).
- An FA group of a deleted or inactive 가맹 마스터 stays visible to the BM read-only.

# Testing on PGlite

`test/bp-role-groups.e2e-spec.ts` passes on a PGlite socket server with the migrations applied,
run `--runInBand`. The concurrent-create case is skipped unless `E2E_REAL_POSTGRES=1`: PGlite has
one session, so the advisory lock does not queue and the losing insert sees the winner
uncommitted — the same reason `stores-db` skips its concurrency cases. Two suites sharing that
one session in parallel workers also interfere.
