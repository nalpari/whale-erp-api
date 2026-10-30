---
type: Service
title: Whale ERP API
description: NestJS 11 HTTP service over PostgreSQL via Prisma; every route needs a bearer token.
tags: [nestjs, api, typescript]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-30T10:00:00Z }
sources:
  - id: package-json
    resource: ../../package.json
    title: package.json (scripts, dependency set)
    last_modified: 2026-10-15T00:19:16Z
  - id: main-ts
    resource: ../../src/main.ts
    title: Application entrypoint
    last_modified: 2026-10-13T05:12:04Z
  - id: app-module
    resource: ../../src/app.module.ts
    title: Root module (ConfigModule registration; BulkExportsModule before StaffMembersModule so /staff-members/bulk-exports is not taken by /staff-members/:id)
    last_modified: 2026-10-29T02:54:57Z
  - id: code-groups-controller
    resource: ../../src/code-groups/code-groups.controller.ts
    title: 플랫폼 공통코드 관리 routes (/code-groups) — menu guard by the path (`/code-groups`, MN000216 today) + platformOnly, POST create · PUT update · DELETE items
    last_modified: 2026-10-30T06:27:06Z
  - id: code-groups-service
    resource: ../../src/code-groups/code-groups.service.ts
    title: 플랫폼 공통코드 관리 rules (create, update, BP application)
    last_modified: 2026-10-30T06:27:06Z
  - id: leads-service
    resource: ../../src/leads/leads.service.ts
    title: 도입문의 접수 · 파기 (POST /leads, lead-purge)
    last_modified: 2026-10-29T05:17:36Z
---

# Status

`AppModule` wires `ConfigModule` (profile env), `ScheduleModule` (cron),
`PrismaModule` (database), `AuthModule` (JWT guard, 직원 근무 앱 login under `/auth/account` and 관리자 웹 login under
`/auth/admin` — see [Admin authentication](/api/admin-auth.md)), and
`EnumsModule` (`GET /enums`, the enum values and Korean labels
front and staff fetch — see [Naming conventions](/conventions/naming.md)).[^app-module]
`CodeGroupsModule` (`/code-groups` — 플랫폼 공통코드 관리 S-UQPNIH) lists, creates and updates
the 플랫폼고정 · 플랫폼제공 groups and their platform-original (`BP000000`) items, deletes items, and
copies a 플랫폼제공 group to every active customer BP (`POST /code-groups/{groupCode}/bp-application`).
**Items of a 플랫폼제공 group can be deleted; groups, and items of a 플랫폼고정 group, cannot** (2026-10-22,
사용자 요청 — both stay managed by 사용 상태). A 플랫폼고정 group's codes are values the system refers to —
`SERVICE` is what `menus.service_code` holds and 플랫폼 메뉴 관리 looks up (a missing one is a 500),
`ROLE_TYPE` · `ACCOUNT_STATUS` are what accounts carry — so deleting one is 409 「플랫폼고정 그룹의 상세 코드는
지울 수 없습니다 — 사용 상태로 관리해 주세요.」 (merge-blocker found in api #135 review). A delete sets
`is_deleted` on the 플랫폼제공 group's undeleted platform originals only, whether or not BPs use the code:
rows already copied to a BP are that BP's and stay, and the deleted code drops out of later [BP에 적용] and
signup copies. Creating
checks only **live** rows (2026-10-22 결정), and of those only the live original and any BP's live
**BP전용** row (2026-10-30 결정): either is 409 「이 그룹에 이미 있는 상세 코드입니다(A, B).」, every such code
listed in request order. A BP전용 row blocks because [BP에 적용] would skip that BP's key and the
platform's meaning would never reach it. A BP's live **플랫폼제공 copy** does not block: until 2026-10-30
it did, which meant a 플랫폼제공 original deleted after [BP에 적용] could never be registered again. A code
matching a deleted original brings that original back with the request's name · status · order
(`restoreDeletedItems`, shared with BP 공통코드 관리 — conditioned on it still being deleted, so a
concurrent restore is 409); the copies stay as they are, and re-applying skips them because the key is
taken. Deleted BP rows do not block. If only copies exist and no original row at all (not producible
except by hand-written SQL — copies are made from originals, which are never removed), a new original is
inserted; the key includes the BP, so it cannot collide with a copy. Delete is all-or-nothing: an unknown
or already deleted code is 404, a repeated one 409, and if another admin deleted one between the check
and the write the short `updateMany` count makes the whole request 409 「다른 관리자가 먼저 지운 상세
코드가 있습니다. 다시 불러온 뒤 삭제해 주세요.」.

**Updates check each row's `updatedAt`** (2026-10-30). The group and item lists carry `updatedAt`, and
every `PUT` row sends it back (`UpdateCodeGroupDto` · `UpdateCodeItemDto`, `IsUpdatedAt` — an offset is
required). Before writing, a row whose stored value is not in the same millisecond is 409 「다른 관리자가
먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요.」 (플랫폼 메뉴 관리's `CHANGED_MEANWHILE`) and
nothing in the request is written; each write is also conditioned on that millisecond (`sameMillisecond`),
so a change between check and write rolls the whole request back the same way. When that conditioned
write finds no row, the item is read again: deleted means 409 「다른 관리자가 먼저 지운 상세 코드가
있습니다(CODE). 다시 불러온 뒤 저장해 주세요.」, still there means the 수정 문구. Before this, a later save
silently overwrote the earlier one. Any write bumps `updatedAt` — [BP에 적용] flips the group's flag, so a
group list read before an application is stale after it. BP 공통코드 관리's item update shares
`assertItemsUnchanged` · `throwUnsaved` and behaves the same.

**Messages put the codes in parentheses at the end** (2026-10-30, as 플랫폼 메뉴 관리 did the same day):
「…입니다(A, B).」 instead of 「…입니다: A, B」 — `withCodes` in `code-groups.service.ts`, also used by
`assertNoRepeat`. The screen splits by the message's beginning (「이 그룹에 이미 있는 상세 코드입니다」,
「플랫폼이 등록한 상세 코드와 겹칩니다」) and reads the codes from the last parentheses, so those beginnings
must not change. A taken group code is 「이미 사용 중인 그룹 코드입니다(CODE).」, the screen's own wording.
Code format errors read 「영문 대문자로 시작해 영문·숫자·_로 입력해 주세요(최대 20자).」
(`CODE_FORMAT_MESSAGE`, group and item codes alike), and names 「그룹명은 50자까지입니다.」 ·
「코드명은 50자까지입니다.」. Create and update both run
under `BULK_UPDATE_TX` (30 seconds), since a restore also writes row by row.
The group list (`GET /code-groups`) also takes `groupCode` and `groupName`, matched by case-insensitive
containment with LIKE wildcards taken literally (`containsText`) — the same `ListCodeGroupsDto` that
[BP 공통코드 관리](/api/bp-code-groups.md) uses (2026-10-22). It also takes `manageOwnerCodes` (repeated or comma-separated, `PLATFORM_FIXED` · `PLATFORM_PROVIDED` only — `BP_ONLY` is 400, empty pieces are dropped); absent or empty means both, and the same condition feeds the list and its count (front 관리주체 filter, 2026-10-27).
The copy (`copyProvidedItems` · `providedOriginals` in `provided-code-copy.ts`) is shared
with signup, which gives a new BP every 플랫폼제공 group's originals whether applied or not
([BP signup](/api/admin-signup.md)). Each BP gets only the rows it does not have yet — rows a BP edited, deleted, or added as BP전용 are
never overwritten or revived. The target BPs are re-read on every application, so re-applying gives
existing BPs the items created since and a BP that became active in between every item; edits to
the original never reach rows a BP already has. Applying cannot be undone, so a group with no items,
or no active customer BP, is refused with 409 instead of being marked applied.[^code-groups-service]
It is judged by 관리자 웹 menu permission on `MN000216` (플랫폼 공통코드 관리), every route through
`@MenuPermission(action, { platformOnly: true })` ([admin authentication](/api/admin-auth.md) — the guard finds the menu by the controller path, `/code-groups`, MN000216's URL):
the two lists need read, creating (`POST /code-groups`, `POST /code-groups/{groupCode}/items`) needs create,
updating (`PUT` on the same two paths) needs update, deleting items (`DELETE /code-groups/{groupCode}/items`
`{ itemCodes }`) needs delete, and BP application needs update — it cannot be
undone, but it adds rows and flips the group's flag rather than deleting anything. `platformOnly` adds that the
caller is PM · PA **belonging to the platform BP**, because a menu grant comes from a role group, which alone
would let a BP admin or a PM · PA wrongly attached to a customer BP through. The session guard reads
`admin_sessions` and the account's forced password-change flag on every request — an admin who has not finished
the forced change gets 403 there, before any of this — but not the account's status; the menu guard does, so a
deleted, inactive or withdrawn admin gets `ACCOUNT_UNAVAILABLE_MESSAGE`, then a missing menu grant or a
non-platform account `ACCESS_DENIED_MESSAGE`.[^code-groups-controller]

**Creating and updating are separate routes** (2026-10-20, 1팀 결정). Each takes `{ items }` — one or more rows,
at most 200 groups or 500 items (`MAX_GROUP_ROWS` · `MAX_ITEM_ROWS` in `code-format.ts`); an empty array is 400 —
and answers 204 with no body, since there is no generated id to return. A group row is `CodeGroupInputDto` (code,
name, status); creating uses `CreateCodeGroupDto`, which adds `manageOwnerCode`, and updating uses
`UpdateCodeGroupDto`, which adds the order and `updatedAt`, so 관리 주체 cannot be sent on update. **Creating takes
no order** (2026-10-30): the api numbers new groups from the highest order among undeleted 플랫폼고정 · 플랫폼제공
groups plus one, in request order, reading that maximum under a transaction advisory lock so two concurrent
creates do not take the same numbers. The screen used to send the visible list's count or maximum plus one, which
collided with existing orders while a search was narrowing the list; a body that still sends `sortOrder` is 400
(unknown property). An item row is `CodeItemInputDto` on create and `UpdateCodeItemDto` (adds `updatedAt`) on
update. Earlier a single
panel save (`PUT` with `{ updates, creates }`) did both in one transaction, and the handler added a create check
when `creates` was non-empty because the guard cannot see the body; splitting the routes put the whole decision in
the guard, so the handler check went away together with the controller's `MenuPermissionsService` injection and
the module's `MenuPermissionsModule` import. The two rights are now independent: an admin with create but not update can add groups and codes —
before, the panel save needed update for anything and create on top for new rows. The consequence for the
screen: **a screen that both edits and adds rows now makes two calls, each its own transaction**,
so the old atomicity is gone — the second call can fail after the first has committed, and the screen has to say
which half was saved. Within one call it is still all or nothing: one missing row on update is a 404 and changes
nothing, one taken code on create is a 409 and creates nothing. A code repeated within one body is a 409 before
the database is touched, on update as on create — on update there is no telling which of the two rows was meant.
A caller without the right gets 403 from the guard before body validation, so a malformed body still answers 403
to them. Creating a code that another admin inserted between the check and the write is a 409, not a 500, and
names only the codes that collided: the insert (`createManyAndReturn` with `skipDuplicates`) returns the rows it
made, and the requested codes it did not return are exactly the ones skipped. Reading the table again afterwards
could not tell them apart, since this transaction's own rows are visible too.
`PlatformAdminsModule` (`/platform-admins` — 플랫폼 관리자 관리) is the first module judged by
관리자 웹 menu permission rather than a role check. It does not import `MailModule`: like the reset
link in `AuthModule` it builds its own sender, so the api still boots without `MAIL_*` or `ADMIN_WEB_URL`
— see [Platform admins](/api/platform-admins.md).
`PlatformRoleGroupsModule` (`/platform-role-groups` — 플랫폼 권한 관리 MN000214) manages the platform BP's
role groups and their per-menu CRUD, judged the same way (`@MenuPermission` with `platformOnly`); revoking
a cell from BP · 가맹 마스터 turns it off in every BA · FA group in the same transaction — see
[Platform role groups](/api/platform-role-groups.md).
`BpRoleGroupsModule` (`/bp-role-groups` — BP 권한 그룹 관리 MN000013) manages a customer BP's BA · FA groups,
judged by menu permission and then the caller's role scope (BM → BA, FM → its own FA, others read-only); it
reuses the platform module's menu functions — see [BP role groups](/api/bp-role-groups.md).
`BpCodeGroupsModule` (`/bp-code-groups` — BP 공통코드 관리 MN000014) is the BP side of 공통코드: groups read-only,
the BP's own rows of every 플랫폼제공 group (applied or not) edited and deleted and BP전용 codes added, platform
users reading a picked BP only; it reuses `groupCodeOf`, `assertNoRepeat`, `notCreated`, `takenInOrder` and
`restoreDeletedItems` from `CodeGroupsModule` — see
[BP code groups](/api/bp-code-groups.md).
`BpMastersModule` (`/bp-masters` — BP 마스터 계정 관리 MN000203) is the platform side of a customer BP and its
one BP 마스터: register (with 공통코드 copy and a mailed first password, sharing 플랫폼 관리자 관리's
`admin-password.ts`), edit, 미사용 cascading to every account of the BP, password reset and delete of an
unused 오등록. Like `PlatformAdminsModule` it builds its own mail sender — see
[BP masters](/api/bp-masters.md).
`PlatformMenusModule` (`/platform-menus` — 플랫폼 메뉴 관리 MN000215) edits the `menus` table that `login-info`
and the 권한 popup read, judged the same way; it numbers codes globally, gives each new menu a PM000001
row, refuses overlapping URLs among active menus, and moves a menu with its subtree — see
[Platform menus](/api/platform-menus.md).
`InquiriesModule` (`/inquiries/:id/processing` · `replies` · `internal-memo`, Plane #274) lets a platform
admin process 문의사항; the first answer notifies the author (ops notification + mail through
`ADMIN_WEB_URL` — empty means the mail is skipped; one reader for every mail, https only in production), and
도입문의 status changes notify platform operators (`NTF_LEAD_ANSWERED`), see
[Inquiry and lead handling](/api/inquiries.md).
`LeadsModule` (`POST /leads` — 홈 도입문의 S-SDMDKC, Plane #295) is `@Public()` — only that intake route: the
관리자 처리 routes under the same `/leads` (처리중 · 답변 · 내부 메모, Plane #274; 지우기, #590) live in a separate
`LeadsAdminController` that is admin-only and not rate-limited, see [Inquiry and lead handling](/api/inquiries.md).
The intake route takes two limits:
the same IP gets 5 per hour (`LeadsThrottlerGuard`, counted before validation, so a rejected form counts too;
its 429 says 「잠시 후 다시 시도해 주세요.」), and the same phone or email is refused with 429 for 10 minutes
(「이미 접수된 문의가 있습니다. 담당자가 영업일 기준 1~2일 안에 연락드립니다.」, CNT-14, 재영 2026-10-13), counted on the
database clock against a `created_at` the database fills ([Inquiry and lead handling](/api/inquiries.md)). The check and
the insert run under advisory locks on the phone key then the email key (`lead-intake:phone:…` ·
`lead-intake:email:…`, always in that order so two requests never wait on each other), so a double-clicked
submit stores one row while unrelated leads do not queue. The account axis of the auth throttler is skipped:
it counts by email for login, and the DB check already covers that. **The IP limit only means "per visitor"
if the caller's address reaches the API**: 관리자 웹 calls the API from its Next server, so it must forward
`X-Forwarded-For` and `TRUST_PROXY` must name that server — in production the API now refuses to boot with
`TRUST_PROXY` empty, because otherwise every visitor shares one bucket and the sixth lead in an hour is
refused. 업종 · 도입 예정 시기 must be active platform 공통코드 (`INDUSTRY` · `PLAN_PERIOD`); 도입 예정 시기 may be
omitted or `null`. The phone may be a landline or a 15xx · 16xx · 18xx 대표번호, and free-text fields reject NUL
(`src/common/no-nul.ts`). The nightly `lead-purge` job `DELETE`s rows whose 상담 완료일 is more than a year past
in Korea time (CNT-12), together with the 운영 알림 that name the lead (2026-10-15 재영). 상담 완료일 is set by the first reply (#274), so a lead is purged a year after it was
answered. **A lead never marked consulted is never deleted automatically — an operator handles it** (재영,
2026-10-13). After the commit it notifies platform operators (`NTF_LEAD_RECEIVED`) and mails the
submitter a fixed-wording receipt (`EMAIL_LEAD_CONFIRMATION`, no variables — the address is
unverified, so no submitted text goes out under the company's name), capped at 50 an hour service-wide (counted on the committed `leads` rows, not the mail log),
#296 — neither is awaited and neither can fail the intake, see [Inquiry and lead handling](/api/inquiries.md).[^leads-service]
`EnumsModule` is `@Public()` on purpose: the 비로그인 홈 renders choices from it
too.

**The DB enums' Korean labels live in the database**, as each enum type's
description: `COMMENT ON TYPE "use_status" IS '사용 · 사용중지'`, one label per
value in value order (재영, 2026-10-12, agreed with 1팀). This is the single source
for both teams; before it, 3팀's labels came from `_model.py` and 1팀's existed only
as SQL comments, so 1팀's enums were missing from `GET /enums`.
`pnpm enums:generate` (`scripts/build-enum-labels.mjs`) applies every migration in
`prisma/migrations/` to an empty PGlite — never the shared database, which can hold
migrations the repository lacks — and writes `src/enums/db-enums.generated.ts`. It
stops on an enum with no description or a label count that differs from the value
count. Two consequences:

- **A migration that creates an enum, or adds a value to one, writes
  `COMMENT ON TYPE` in the same file** — with the full label list, since the
  description is replaced, not appended. (`ALTER TYPE … ADD VALUE` cannot use the new
  value in its transaction, but a comment does not use it.) 3팀's
  `_build_physical.py` emits the line into `schema.sql` from `_model.py`; 1팀 writes it
  by hand.
- **Forgetting to regenerate fails `pnpm test`.** `db-enums.generated.spec.ts`
  compares the generated file with every `enum` in `schema.prisma` by DB name
  (`@@map`), values and order.

`ContractsModule` (`/contracts` — list, 근로계약서 초안 저장, 임시저장 이어 쓰기 · 삭제, `GET /contracts/store-options`
(the 근무지 lookup), and the nightly contract expiry job) and `StoresModule` (`/stores` — the 점포 정보 관리 menu) are in `AppModule` — see [Contracts API](/api/contracts-api.md),
[Store management](/api/stores.md) and
[Employment Contract Batch](/api/employment-contract-batch.md).
The generated `AppController` still answers `/` with `Hello World!` and can go
once something real replaces it — it only still answers because it carries
`@Public()`.

`AuthModule` registers a global guard, so **every route requires a bearer
token** unless marked `@Public()`: see [Authentication](/api/auth.md) before
adding a controller. The template's samples (items, stock movements,
staff/customer login) were removed on 2026-10-07; 직원 근무 앱's login
(`/auth/account`) and 관리자 웹's (`/auth/admin`) replace them. No module is the worked
example until the first real domain module lands.

Read CLAUDE.md for the Prisma 7 setup traps (config location, CHECK constraints,
id 범위 처리), and [Team 3 physical schema](/domain/team3-physical-schema.md)
before writing a migration.

# Runtime

The entrypoint creates the Nest application from `AppModule` and listens on
`process.env.PORT`, falling back to `8000`.[^main-ts] Outside production it serves
Swagger at `/docs`; the document is built by `src/openapi/document.ts`, the one
function `pnpm openapi:export` also calls, so the committed `openapi/openapi.json`
matches what the server shows.

# Configuration profiles

`ConfigModule` loads `.env.<APP_ENV>` and defaults to `.env.local` when
`APP_ENV` is unset.[^app-module] `APP_ENV` must come from the real
environment, not from the env file: the value selecting which file to read
cannot itself live in that file.

`NODE_ENV` is kept to the values Node and its libraries expect
(`development` / `production`); `APP_ENV` carries the `local` / `dev` /
`prod` profile separately, so setting a profile never silently changes
library behaviour keyed on `NODE_ENV`.

Value files are gitignored; `.env.example` is the committed key list.

# Build and run

Commands are defined as npm scripts and run through **pnpm**.[^package-json]

| Command | Effect |
|---------|--------|
| `pnpm start:dev` | Watch-mode development server. |
| `pnpm build` | Compiles to `dist/`; `nest-cli.json` sets `deleteOutDir: true`. |
| `pnpm start:prod` | Runs `node dist/main`. |
| `pnpm lint` | ESLint over `src`, `apps`, `libs`, `test`, `scripts` — **writes fixes** (`--fix`). |
| `pnpm openapi:export` | Builds, then writes `openapi/openapi.json` without opening a port or touching the database (needs `JWT_SECRET`). Run it after changing any DTO or route — front and staff generate types from the committed file. |

A `pnpm-workspace.yaml` exists solely to allow the `unrs-resolver` build
script; pnpm 11+ blocks build scripts unless listed under `allowBuilds`.

Testing is covered separately in [testing conventions](/conventions/testing.md);
compiler and lint settings in [TypeScript and lint conventions](/conventions/typescript.md).

[^package-json]: package.json (scripts, dependency set)
[^app-module]: Root module (ConfigModule registration)
[^main-ts]: Application entrypoint
[^code-groups-service]: 플랫폼 공통코드 관리 rules (create, update, BP application)
[^code-groups-controller]: 플랫폼 공통코드 관리 routes (/code-groups) — menu guard by the path (`/code-groups`, MN000216 today) + platformOnly, POST create · PUT update · DELETE items
[^leads-service]: 도입문의 접수 · 파기 (POST /leads, lead-purge)
