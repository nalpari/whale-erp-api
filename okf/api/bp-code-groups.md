---
type: API
title: BP code groups
description: 관리자 웹 「BP 공통코드 관리」(MN000014) — groups are read-only; a 플랫폼고정 group shows the platform originals, an applied 플랫폼제공 group shows the BP's own rows, where the BP edits name · status · order and adds BP전용 codes; platform users read a picked BP only.
tags: [admin, codes, bp]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-22T01:11:43Z }
sources:
  - id: bp-code-groups-controller
    resource: ../../src/bp-code-groups/bp-code-groups.controller.ts
    title: /bp-code-groups routes — menu by the path (MN000014), target BP from X-Bp-Code-Id, POST create · PUT update
    last_modified: 2026-10-22T00:24:54Z
  - id: bp-code-groups-service
    resource: ../../src/bp-code-groups/bp-code-groups.service.ts
    title: Which groups and rows a BP sees, BP전용 creation, edits and the platform-stopped rule
    last_modified: 2026-10-22T01:11:43Z
  - id: bp-code-groups-e2e
    resource: ../../test/bp-code-groups.e2e-spec.ts
    title: Real-DB proof — visibility, other-BP 403, platform read-only, overlap 409, concurrent create
    last_modified: 2026-10-22T00:24:54Z
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
| `GET /bp-code-groups?groupCode=&groupName=&page=&pageSize=` | read | groups the BP sees, `{ items, total }` |
| `GET /bp-code-groups/{groupCode}/items` | read | that group's items for the BP, `{ items, total }` |
| `POST /bp-code-groups/{groupCode}/items` | create | `{ items }` — new BP전용 codes, 204 |
| `PUT /bp-code-groups/{groupCode}/items` | update | `{ items }` — edits to the BP's rows, 204 |

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
  주세요」 — the platform BP's codes are 플랫폼 공통코드 관리's. A create or update is 403
  「플랫폼 사용자는 BP 공통코드를 조회만 할 수 있습니다」 even though PM000001 holds the
  rights — the policy (F-QPDEWN) is stricter than the seeded row.[^bp-code-groups-service]

# Which groups and rows a BP sees

Groups are made by the platform and never added, edited or deleted here. The list holds
**플랫폼고정 groups and the 플랫폼제공 groups already applied to BPs** (`is_bp_applied`), 사용중지
ones included (shown read-only), ordered by `sort_order` then `group_code`. An unapplied
플랫폼제공 group is invisible and its items route is 404 — the BP has no rows for it.
`groupCode` and `groupName` search by case-insensitive containment with LIKE wildcards taken
literally (`containsText`).

Items follow the group's owner, the same split `CodesService` uses for login-info:

- **플랫폼고정** — the platform originals (`BP000000`), never copied, the same for every BP.
- **플랫폼제공** — the BP's own rows: those copied when the group was applied plus its BP전용
  additions. Codes the platform added after the application are not there and do not appear;
  the BP sees only its edited values, never the platform's next to them (CONFIG-7).

Both include 사용중지 rows. Each item carries its `manageOwnerCode` (the group's owner for a
platform code, `BP_ONLY` for a BP addition) and `isPlatformInactive` — whether the platform
original of that code is 사용중지 (always false for BP전용). **The screen disables only switching
such a code on**, i.e. when `isPlatformInactive` and the row is 사용중지: a row that is still 사용
(the platform stopped the original after the copy) may be switched off or saved as is. The
mockup says 「플랫폼이 사용 중지한 코드는 토글이 비활성」; disabling the toggle on `isPlatformInactive`
alone would leave such a row impossible to switch off — tell front when the screen is built.

# Writing

Only an **active 플랫폼제공** group is writable: a 플랫폼고정 group is 409 「플랫폼고정 그룹은 조회만
할 수 있습니다」, a 사용중지 group 409 「사용 중지된 그룹은 상세 코드를 추가하거나 고칠 수
없습니다」. Codes and owners never change after creation, and there is no delete — an unused
code is switched off.

- **Create** writes rows with `bp_code` = the BP and `manage_owner_code = BP_ONLY`. A code may
  not repeat in the request, nor match — deleted rows included — the BP's rows in the group
  (409 「이 그룹에 이미 있는 상세 코드입니다」) or the group's platform originals (409 「플랫폼이
  등록한 상세 코드와 겹칩니다」). The second holds even for a platform code the BP never
  received: otherwise a re-application would skip that code for this BP because the key
  (group, code, BP) is taken, and the BP's own meaning would silently stand in for the
  platform's. Check and insert share a transaction; a code inserted in between by another
  admin of the same BP is caught by `createManyAndReturn` + `skipDuplicates` and answered 409
  naming only the codes that lost (proved concurrently in the e2e).[^bp-code-groups-e2e]
- **Update** touches only the BP's undeleted rows of the group (anything else 404 — including a
  platform code the BP never received) and only name, status and order. **A code the platform
  stopped cannot be switched back on**: 사용중지 → 사용 is 409 「플랫폼이 사용 중지한 코드는 다시
  사용으로 바꿀 수 없습니다」. A row that is still 사용 is left alone even if the original was
  stopped later — the screen sends the whole panel, and stopping an original does not reach
  rows a BP already has (the platform's application never overwrites), so refusing would block
  every save of that panel. That row is written by an `UPDATE … WHERE status = 'ACTIVE'`: if
  another admin of the same BP switched it off after this request read it, the update matches
  nothing and the save is the same 409 instead of switching it back on.
- A code repeated within one body is 409 「한 요청에 같은 상세 코드가 두 번 있습니다」 before the
  database is touched, on create as on update — a different message from a code that already
  exists, so the screen can tell its own duplicate row from a taken code.

Both are all-or-nothing in one transaction. Nothing is written to a history table yet, as on the
platform screen.

# Known edges

- A platform admin creating the same code in the platform original at the same moment as a BP
  creates its BP전용 code is not serialised: the keys differ by BP, so both rows can exist. The
  platform's create checks every BP's rows first, so this needs the two inserts to cross
  within one round trip.
- Signup does not yet copy applied 플랫폼제공 groups to a new BP (the ERD says it should); such a
  BP sees the group with no items and can add BP전용 codes to it.

[^bp-code-groups-controller]: /bp-code-groups routes — menu by the path (MN000014), target BP from X-Bp-Code-Id, POST create · PUT update
[^bp-code-groups-service]: Which groups and rows a BP sees, BP전용 creation, edits and the platform-stopped rule
[^bp-code-groups-e2e]: Real-DB proof — visibility, other-BP 403, platform read-only, overlap 409, concurrent create
