---
type: API
title: Staff retirement
description: How a 관리자 retires a 직원 레코드 — the date is stored now, the record turns RETIRED the day after by a midnight batch that also clears schedules, personal TO-DO assignments and unsigned contracts; contracts are never shortened.
tags: [staff, retirement, batch, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-20T04:17:59Z }
sources:
  - id: retirement-service
    resource: ../../src/staff-members/retirement.service.ts
    title: RetirementService (preview · retire · changeDate · cancel · retireDue)
    last_modified: 2026-10-08T06:44:05Z
  - id: retirement-controller
    resource: ../../src/staff-members/retirement.controller.ts
    title: /staff-members/:id/retirement (직원 정보 관리 수정 권한)
    last_modified: 2026-10-15T08:46:16Z
  - id: retirement-scheduler
    resource: ../../src/staff-members/retirement.scheduler.ts
    title: Midnight KST batch (staff-retire)
    last_modified: 2026-10-08T05:19:12Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: Which stores an 관리자 manages
    last_modified: 2026-10-20T04:17:59Z
  - id: kst-date
    resource: ../../src/staff-members/kst-date.ts
    title: KST "today" and date-only helpers
    last_modified: 2026-10-13T00:58:41Z
---

# What it is

직원 퇴직 처리 (WHALEERP-583 · 584). Four 관리자 웹 routes, all behind
`@MenuPermission('MN000005', 'update')` — 직원 정보 관리 수정 권한 (WHALEERP-586):[^retirement-controller]

| Route | What it does |
|---|---|
| `GET /staff-members/:id/retirement-preview?retiredDate=` | what the retirement will clear — schedules, personal TO-DOs, unsigned contracts |
| `POST /staff-members/:id/retirement` `{retiredDate}` | 퇴직 처리: store the date (204) |
| `PUT /staff-members/:id/retirement` `{retiredDate}` | 퇴직일 변경 (204) |
| `DELETE /staff-members/:id/retirement` | 퇴직 취소 (204) |

# Contracts are contracts; retirement is separate

Decided 2026-10-07 (협의), detailed 2026-10-08 (노영주). The first version of the
spec shortened every running contract to the retirement date; that was dropped.
**Retirement never changes a contract's end date.** A contract states what was
agreed; when someone leaves early is a different fact, and the end date of an
agreement is evidence that should not be rewritten.[^retirement-service]

What is recorded instead: for each 체결 완료 contract that spans the retirement
date, a `staff_member_retirement_logs` row with `contract_id` and that
contract's end date at the time (`previous_contract_end_date`, now a reference
value; the column comments say so since
`20261008000600_team3_password_reset_links_email_find`). No
spanning contract → one row with the contract columns empty. All rows of one
action share `processed_at`, which is how they are read back as one action.

The cost of this choice lives elsewhere: anything that reads contracts — payroll
drafts, the renewal-due batch, contract duplicate checks — has to look at
retirement too. Two follow-ups are recorded on the Plane items: 198 (no work
schedule after the retirement date) and 130 (no contract starting after the
retirement date for someone about to retire).

# The date now, the status the day after

`POST` stores `retired_date` and leaves `employment_status = EMPLOYED`.
"Employed with a retirement date" **is** 퇴직 예정 — there is no third status.
The person works through the retirement date; at **00:00 KST the next day** the
batch makes it RETIRED.[^retirement-scheduler]

The batch (`retireDue`, job `staff-retire`, under `BatchLockService`) takes every
record with `employment_status = EMPLOYED AND retired_date < today` and, **in a
transaction of its own per record**:

1. flips EMPLOYED → RETIRED with a conditional update (the date is part of the
   condition) — if nothing changed, someone already did it, and nothing else
   runs;
2. soft-deletes work schedules starting from 00:00 KST of the next day, and
   writes a `work_schedule_histories` `DELETED` row for each (with the
   schedule's times in `before_value`) so a confirmed shift does not vanish
   from the schedule's history without a reason. `changed_by` there is NOT NULL
   and points at an 관리자, so the batch uses the 관리자 who processed this
   retirement — the latest `RETIRE` log's `processed_by` — since the deletion is
   the consequence of that action (노영주, 2026-10-08); a past date processed on
   the spot uses the requesting 관리자;
3. deletes the record's open personal TO-DO assignments (`INDIVIDUAL`, not
   `DONE`, not deleted) and writes a `todo_status_histories` row naming the
   unassigned staff member (same status before and after — the unassignment is
   the event); finished assignments stay as history;
4. closes 임시저장 · 발송 대기 · 서명 대기 · 수정 요청 contracts as 종료 with a status history row. 임시저장 is closed too (2026-10-12 재영): left open, it could be resumed and sent to someone who has left.
   Signed contracts are left alone;
5. makes the record's `SENT` invitations `EXPIRED` — a 가입 초대 already out cannot be used to sign up and sign after the 퇴직 (CTR-25, 2026-10-19 재영).

Batch rows use actor `SYSTEM` and no `changed_by`.

**One record failing does not stop the others** (PR #8 team review). The job's
transaction — the one holding the advisory lock — is used only to list the
records; each one is then finalised in its own transaction. Putting them all in
the job's transaction meant one failure rolled back the whole night, and a record
that kept failing blocked everyone's retirement every night after; a long night
also ran into the job's 60-second timeout. The lock is held until the loop ends,
so overlapping runs are still excluded — this batch deliberately breaks
`BatchLockService`'s "write only through `tx`" rule, and the conditional flip in
step 1 is what makes that safe.

A record that fails is left as it was — not half-finalised — and logged with its
`staffMemberId`; the next run tries it again. The known way to fail is a
`retired_date` written outside this API (SQL, migration, another module): there is
no `RETIRE` log, so step 2 has no 관리자 for `changed_by`. Filling a stand-in or
skipping the schedules would leave someone retired with live shifts, so the
record is reported instead.

**`<`, not `= today − 1`.** An equality would leave anyone whose day the batch
missed (a failed run, a restart at midnight) employed forever; `<` catches up on
the next run, and the conditional flip makes a second run a no-op.

A date **in the past** (allowed up to 3 months back) is finalised on the spot by
the same code, with actor `ADMIN` and the 관리자 as `changed_by` — waiting for
midnight would show someone who already left as employed. Today's date is not
in the past: they still work today.

# Change and cancel only touch the date

Because nothing is cleared until the day after, `PUT` and `DELETE` have nothing
to undo: they rewrite or clear `retired_date` and log `CANCEL` (and `RETIRE` for
a change). Both are accepted only while 퇴직 예정 and **before** the retirement
date (`retired_date > today`); on the day itself or later it is 409 — the batch
may already be running. A second `POST` on someone already 퇴직 예정 is 409 too;
the change route is the way to move the date.

A record that has not joined yet is accepted once it has received a 근로계약서 — 재직 starts with
the contract, not with 가입 (WHALEERP-125 「재직과 매장 정보」, CTR-25, 2026-10-19 재영). One with
임시저장 contracts only is not counted as 재직 and is 409 「임시저장 근로계약만 있는 직원은 퇴직 처리
대신 임시저장을 지워 주세요」.

Other refusals: RETIRED is 409; changing to the same
date is 409 (it would only stack log rows); a date older than 3 months (calendar
months, clamped to month end) is 400, and so is one before the 입사일 — a past
date clears schedules from the next day on, so an early one would erase the days
actually worked. There is no upper bound on a future date. A malformed or
impossible date (`2026-02-30`) is 400 from one validator on the DTO, so every 400
has the same body shape.

The preview runs the checks retire and change share — joined, not yet retired,
the date range, the 입사일 — so a confirmation dialog does not show for a date or
record those will refuse. It does not run the checks only one of them has
(already 퇴직 예정, before the retirement date): the change dialog uses the same
preview for the new date.

**A past date cannot be undone.** It is finalised on the spot — schedules
deleted, unsigned contracts ended, assignments released — and nothing in this API
restores them; the preview is the only guard. Whether a correction path is needed
is a question for 기획.

A change writes `CANCEL` and `RETIRE` rows with the same `processed_at`, so
"rows of one action" is `processed_at` plus `action` when reading back a change,
and the log does not tell a change from a cancel immediately followed by a new
retirement. The outcome is the same; a `CHANGE` action can be added if the
difference ever matters.

Each of retire, change and cancel locks the `staff_members` row
(`SELECT … FOR UPDATE`) before deciding, so two 관리자 acting on one record go
one at a time.

One edge is accepted: a retirement for *today* committed in the last moments
before midnight, after that night's batch has already listed its records, is
finalised a day late — the next run's `<` catches it.

# Permission first: no 수정 권한 is 403

All four routes, the preview included, need 직원 정보 관리 (`MN000005`) 수정 권한
(WHALEERP-586). The preview only feeds the confirmation dialog of retire and
change, and 관리자 웹 shows those buttons by the same permission, so it is not a
read. The guard (`MenuPermissionGuard`, [admin authentication](/api/admin-auth.md))
reads the role group from the database on every request: switching the permission
off takes effect on the next call, without logging in again.

The guard answers 403 for two different reasons, with two different `message`s
([403 messages](/api/admin-auth.md#403-messages)): no 수정 권한 (or a 직원 앱
token) is `ACCESS_DENIED_MESSAGE`, and a deleted, 미사용 or 탈퇴 account still
holding a session is `ACCOUNT_UNAVAILABLE_MESSAGE`. 관리자 웹 branches on that
`message`, so neither is reworded here.

The order is 403 → 400 → 404. The guard runs first (403, no permission); then the
validation pipe checks the date of preview, retire and change (400); then the
handler reads the id and the scope (404: malformed, missing, or out of scope). So
without the permission even a wrong date is 403, and the 403 says nothing about
the 직원 — it is the same whatever id is asked. The default role groups
`PM000001` · `BM000001` · `FM000001` all have it on; a 관리자 in a group without it
— a read-only BA group, say — can call none of the four. The 직원 list
(`GET /staff-members`) does not check a menu permission yet: it takes any active
관리자 token within scope (WHALEERP-329).

# Scope: not yours is 404

A 관리자 manages the stores of their own BP — all of them with `is_all_stores`,
otherwise the ones in `admin_store_mappings` (not deleted); the admin account must
be ACTIVE and not deleted.[^admin-scope] A record outside that scope gets the same
404 as a missing one: a 403 would confirm that the id exists in someone else's BP.
Ids outside `1..2147483647` are 404 before the database is asked. The timing
says nothing either: `canManageStaffMember` fixes the 관리자's stores first and
looks the staff member up only inside them (`staffMemberId` + `storeId IN …`),
so an unknown id, another BP's 직원 and one in scope all cost the same four
queries — the lookup reads the 직원's account for 본사 제공 동의, and `findFirst`
issues that second query whether or not a row came back (counted with Prisma's
query log, 2026-10-20; `findUnique` skips it when nothing is found, so the lookup
must stay `findFirst`). Looking the 직원 up first and then asking about the store made another
BP's id one query slower than an unknown one (api #56 review).

A store in scope is not enough for BP 마스터 · BP 관리자: a 직원 of a store that is
not 직영 who has not given 본사 제공 동의 (`accounts.is_hq_sharing_consented` — on the
account since 2026-10-20; no account yet means not consented) is the row the
[staff member list](/api/staff-members.md) masks (ATT-30), so
`canManageStaffMember` refuses it with the same 404 — preview, retire, change and
cancel alike. Both sides call `hidesPersonalData`, so the list and these routes
cannot drift apart (`canManageStaffMember` judges with the 직원's consent;
`canManageStaffAt`, for a store with no 직원 yet, passes `false`); ids are sequential, and hiding them in the list alone would
not stop a guess (PR #13 review, 2026-10-13). The password reset link sent from
the same 직원 상세 does **not** follow consent — it is an account action, judged
per store (`canManageStaffAccount`, 2026-10-14 재영).

Platform 관리자 (PM · PA) belong to the platform BP and so manage no customer
store under this rule. How far their scope reaches is still open (업무 범위 적용,
WHALEERP-301); `AdminScopeService` is where it would widen.

# One record, not the person

A person with an account can have 직원 레코드 at several stores. Retirement is per
record: the row lock, the date, the log and every cleanup — schedules, personal
TO-DO assignments, unsigned contracts — are keyed by `staff_member_id`, and
`accounts` is never touched. The person's record at another store stays EMPLOYED
with its own schedules, TO-DOs and contracts, whether this one is scheduled,
cancelled or finalised at once with a past date (e2e, WHALEERP-586).

# Tests

The rules live in `test/staff-retirement.e2e-spec.ts` against a real database,
because they span five tables and their constraints. That suite runs
`retireDue` over **the whole database**, so it refuses to start without
`APP_ENV=test` and an explicit `DATABASE_URL` — without them `ConfigModule` would
load `.env.local`, the shared development DB, and retire other people's records.
The boundaries that need no database (3 months, 입사일, the day itself, same
date, route ids) are also unit-tested beside the service and controller, so plain
`pnpm test` catches a regression there.

The permission (WHALEERP-586) is tested at both levels:

- the controller spec checks the class carries `MENU_PERMISSION` `MN000005`
  `update`, `USER_TYPES` `admin` and `MenuPermissionGuard`, and that no method
  carries its own `MENU_PERMISSION` · `IS_PUBLIC` · `USER_TYPES` that would
  override them;
- e2e: without 수정 권한 all four routes are 403 for a 직원 in scope, and nothing
  changes;
- e2e: without it a missing id and an out-of-scope 직원 get the same 403 on all
  four routes — the same ids are 404 for a 관리자 with the same scope and the
  permission;
- e2e: switching the permission off turns the next request with the same token
  into 403;
- e2e: the same person's record at another store is untouched by retire, cancel
  and an immediate past-date finalisation.

# Dates

"Today" is the Korean date (`kstToday`); date-only columns come back from Prisma
as UTC midnight, and every helper in `kst-date.ts` works in that shape. A
schedule's `start_at` is a timestamp, so "from the next day" is compared against
`kstDayStart(retired_date + 1)` — 15:00 UTC of the retirement date.[^kst-date]

[^retirement-service]: RetirementService (preview · retire · changeDate · cancel · retireDue)
[^retirement-controller]: /staff-members/:id/retirement (직원 정보 관리 수정 권한)
[^retirement-scheduler]: Midnight KST batch (staff-retire)
[^admin-scope]: Which stores an 관리자 manages
[^kst-date]: KST "today" and date-only helpers
