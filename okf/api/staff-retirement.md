---
type: API
title: Staff retirement
description: How a 관리자 retires a 직원 레코드 — the date is stored now, the record turns RETIRED the day after by a midnight batch that also clears schedules, personal TO-DO assignments and unsigned contracts; contracts are never shortened.
tags: [staff, retirement, batch, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-08T05:27:58Z }
sources:
  - id: retirement-service
    resource: ../../src/staff-members/retirement.service.ts
    title: RetirementService (preview · retire · changeDate · cancel · retireDue)
    last_modified: 2026-10-08T05:27:58Z
  - id: retirement-controller
    resource: ../../src/staff-members/retirement.controller.ts
    title: /staff-members/:id/retirement (admin only)
    last_modified: 2026-10-08T05:19:12Z
  - id: retirement-scheduler
    resource: ../../src/staff-members/retirement.scheduler.ts
    title: Midnight KST batch (staff-retire)
    last_modified: 2026-10-08T05:19:12Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: Which stores an 관리자 manages
    last_modified: 2026-10-08T05:19:12Z
  - id: kst-date
    resource: ../../src/staff-members/kst-date.ts
    title: KST "today" and date-only helpers
    last_modified: 2026-10-08T05:19:12Z
---

# What it is

직원 퇴직 처리 (WHALEERP-583 · 584). Four 관리자 웹 routes, `@UserTypes('admin')`:[^retirement-controller]

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
value — its column comment still says "취소 때 되돌림" until 3팀 updates it). No
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
record with `employment_status = EMPLOYED AND retired_date < today` and, in the
job's transaction, per record:

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
4. closes 발송 대기 · 서명 대기 contracts as 종료 with a status history row.
   Signed contracts are left alone.

Batch rows use actor `SYSTEM` and no `changed_by`.

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

Other refusals: a record not yet 가입 완료 (초안 · 초대 발송) is 409 — delete it
instead, the 관리자 웹 hides the button; RETIRED is 409; changing to the same
date is 409 (it would only stack log rows); a date older than 3 months (calendar
months, clamped to month end) is 400, and so is one before the 입사일 — a past
date clears schedules from the next day on, so an early one would erase the days
actually worked. There is no upper bound on a future date. A malformed or
impossible date (`2026-02-30`) is 400 from one validator on the DTO, so every 400
has the same body shape.

The preview runs the same date and state checks, so a confirmation dialog never
shows for something the action itself will refuse. It accepts someone already
퇴직 예정, because the change dialog uses it for the new date.

**A past date cannot be undone.** It is finalised on the spot — schedules
deleted, unsigned contracts ended, assignments released — and nothing in this API
restores them; the preview is the only guard. Whether a correction path is needed
is a question for 기획.

A change writes `CANCEL` and `RETIRE` rows with the same `processed_at`, so
"rows of one action" is `processed_at` plus `action` when reading back a change.

Each of retire, change and cancel locks the `staff_members` row
(`SELECT … FOR UPDATE`) before deciding, so two 관리자 acting on one record go
one at a time.

One edge is accepted: a retirement for *today* committed in the last moments
before midnight, after that night's batch has already listed its records, is
finalised a day late — the next run's `<` catches it.

# Scope: not yours is 404

A 관리자 manages the stores of their own BP — all of them with `is_all_stores`,
otherwise the ones in `admin_store_mappings` (not deleted); the admin account must
be ACTIVE and not deleted.[^admin-scope] A record outside that scope gets the same
404 as a missing one: a 403 would confirm that the id exists in someone else's BP.
Ids outside `1..2147483647` are 404 before the database is asked.

Platform 관리자 (PM · PA) belong to the platform BP and so manage no customer
store under this rule. How far their scope reaches is still open (업무 범위 적용,
WHALEERP-301); `AdminScopeService` is where it would widen. 관리자 웹 login is not
built yet (1팀), so these routes are reachable only with an `admin` token the
e2e tests sign themselves.

# Tests

The rules live in `test/staff-retirement.e2e-spec.ts` against a real database,
because they span five tables and their constraints. That suite runs
`retireDue` over **the whole database**, so it refuses to start without
`APP_ENV=test` and an explicit `DATABASE_URL` — without them `ConfigModule` would
load `.env.local`, the shared development DB, and retire other people's records.
The boundaries that need no database (3 months, 입사일, the day itself, same
date, route ids) are also unit-tested beside the service and controller, so plain
`pnpm test` catches a regression there.

# Dates

"Today" is the Korean date (`kstToday`); date-only columns come back from Prisma
as UTC midnight, and every helper in `kst-date.ts` works in that shape. A
schedule's `start_at` is a timestamp, so "from the next day" is compared against
`kstDayStart(retired_date + 1)` — 15:00 UTC of the retirement date.[^kst-date]

[^retirement-service]: RetirementService (preview · retire · changeDate · cancel · retireDue)
[^retirement-controller]: /staff-members/:id/retirement (admin only)
[^retirement-scheduler]: Midnight KST batch (staff-retire)
[^admin-scope]: Which stores an 관리자 manages
[^kst-date]: KST "today" and date-only helpers
