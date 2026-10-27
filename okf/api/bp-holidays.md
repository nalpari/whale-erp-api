---
type: API
title: BP holidays
description: 관리자 웹 「BP 휴일 관리」(MN000015) — rule-stored holidays whose dates are computed when read, month calendar · list, detail, change history, overlap check, create, update, force termination and deletion; past dates never change, stores join from today and leave as of yesterday.
tags: [admin, holiday, bp, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-27T07:37:14Z }
sources:
  - id: bp-holidays-controller
    resource: ../../src/bp-holidays/bp-holidays.controller.ts
    title: /bp-holidays routes (path-form @MenuPermission, X-Bp-Code-Id)
    last_modified: 2026-10-26T06:06:05Z
  - id: bp-holiday-changes
    resource: ../../src/bp-holidays/bp-holiday-changes.service.ts
    title: create · update · terminate · remove under a row lock
    last_modified: 2026-10-26T06:06:05Z
  - id: bp-holiday-access
    resource: ../../src/bp-holidays/bp-holiday-access.ts
    title: who manages what — manageAll, store scope, per-state actions
    last_modified: 2026-10-26T06:06:05Z
  - id: holiday-dates
    resource: ../../src/bp-holidays/holiday-dates.ts
    title: date computation for DAY · PERIOD · REPEAT
    last_modified: 2026-10-26T06:06:05Z
  - id: holiday-application
    resource: ../../src/bp-holidays/holiday-application.ts
    title: which stores a date applies to (closed · deleted · registration date)
    last_modified: 2026-10-26T06:06:05Z
  - id: store-periods
    resource: ../../src/bp-holidays/store-periods.ts
    title: store list changes → period rows (add · close · drop)
    last_modified: 2026-10-26T08:01:25Z
  - id: bp-holiday-rule
    resource: ../../src/bp-holidays/bp-holiday-rule.ts
    title: input normalization, 2100 ceiling, describeRule
    last_modified: 2026-10-26T06:06:05Z
  - id: bp-holidays-service
    resource: ../../src/bp-holidays/bp-holidays.service.ts
    title: list · detail · histories · overlaps
    last_modified: 2026-10-27T07:37:14Z
  - id: store-periods-migration
    resource: ../../prisma/migrations/20261026135250_team1_bp_holiday_store_periods/migration.sql
    title: target · excluded stores become one row per period
    last_modified: 2026-10-26T06:06:05Z
---

# Status

Eight routes on `/bp-holidays` (Plane WHALEERP-551 – 559, 565; 명세 S-YAFRYZ and the BP
휴일 등록 · 상세 · 수정 specs), changed by **BP 휴일 변경 · 종료 정책** (1팀, 2026-10-26),
which replaces the specs' "이후 모두" split editing and date-range deletion:[^bp-holidays-controller]

| Route | Menu action | What |
|---|---|---|
| `GET /bp-holidays?year&month&name` | read | month calendar · list — one row per computed date, plus that month's 공식 휴일 |
| `GET /bp-holidays/histories?from&to&page&pageSize` | read | change history, default 이달 1일 ~ 오늘 (only `to` → from its month's 1st; only `from` → to today, or `from` if later), deleted holidays included |
| `POST /bp-holidays/overlaps` | create or update | overlap summary before saving; never blocks |
| `GET /bp-holidays/:id?date` | read | detail, every store period (open · closed, with state), applied store count, next three dates, history, actions |
| `POST /bp-holidays` | create | `{ bpHolidayId }` |
| `PUT /bp-holidays/:id` | update | 204 |
| `POST /bp-holidays/:id/terminate` | delete | 204 — ends the holiday as of yesterday |
| `DELETE /bp-holidays/:id?updatedAt` | delete | 204 — logical |

The menu is found by the path (`menus.url = '/bp-holidays'`, MN000015, set by
`20261019144438`); the target BP comes from `X-Bp-Code-Id` through `@TargetBp()`. A
platform account (플랫폼 BP 의 PM · PA) must pick a BP — without the header every route
is 400 「휴일을 볼 BP 를 골라 주세요」 — and then handles that BP like a BP 마스터.
「오늘」 is always the Korean date (`kstToday`).

# Stored as a rule, computed when read

A holiday is one `bp_holidays` row; its dates are never expanded into rows (CONFIG-8).
`holiday-dates.ts` computes them:[^holiday-dates]

- DAY: `end_date = start_date`. PERIOD: every day `start ~ end`. REPEAT: `end_date` is
  null; DAILY · WEEKLY step from the start date, MONTHLY · YEARLY keep the start's day
  and **skip months or years that lack it** (31일, 2월 29일) — skipped dates are not
  counted toward `repeat_count`.
- The repeat end is NONE, UNTIL_DATE (`repeat_end_date`) or COUNT; computation stops at
  2100, the same ceiling as `public_holidays`.
- State against today: UPCOMING (start after today), ENDED (last date before today),
  otherwise ONGOING. A repeat whose last occurrence has passed is ENDED even if its
  UNTIL_DATE is later.

Which stores a date applies to (`holiday-application.ts`): a 특정 점포 holiday applies to
its target stores whose period covers the date; a 전체 점포 holiday applies to every live
store of the BP **from that store's registration date (KST)** minus the stores excluded on
that date. A closed store drops out the day after `closed_date`; a deleted store never
applies — **including past dates**, the one exception to "past dates never change". Only
a 미운영 store that never operated can be deleted (store module), so it had no real
holidays to keep. The list shows a 특정 점포 date only if one of the caller's stores applies on it.
Two cases follow from that: when a store is **removed from the holiday**, its period closes
and only the dates after it disappear for a caller who covers only that store; when the
**caller's own store mapping changes**, scope is judged against the current mapping, so a
store they no longer cover hides that holiday's past dates too.

# Past dates never change

The policy's core: **a change affects only today onward.** That shapes every write:[^bp-holiday-changes]

| | 시작 전 (UPCOMING) | 진행 중 (ONGOING) | 종료 (ENDED) |
|---|---|---|---|
| 휴일명 · 설명 | ✓ | ✓ | — |
| 유형 · 날짜 · 반복 · 종료 조건 · 적용 범위 | ✓ | 409 | — |
| 점포 더하기 · 빼기 | ✓ (from the start; removing deletes the row) | ✓ (today / yesterday) | — |
| 강제 종료 | — | start ≤ yesterday | — |
| 삭제 | ✓ | start = today only | — |

- **Ongoing holidays keep their schedule.** `PUT` is the whole form; an ongoing holiday
  must send the schedule fields unchanged or get 409 「진행 중인 휴일은 … 바꿀 수 없습니다」.
  Ended holidays are read-only (409 on every write).
- **Force termination** ends the holiday as of yesterday: PERIOD sets `end_date`, REPEAT
  becomes `UNTIL_DATE · yesterday` and drops `repeat_count`. It cannot be undone, and the
  store periods are left as they are — the holiday's end bounds them.
- **Deletion** is only for holidays starting today or later; anything with a past date is
  terminated instead. The two never overlap: a holiday that started today can be deleted
  but not terminated — yesterday would precede its start, so the service refuses with 409
  「어제 이전에 시작한 휴일만 강제 종료할 수 있습니다 …」 (for DAY · PERIOD the CHECK
  `bp_holidays_end_date_after_start` would refuse it too; a REPEAT ends through
  `repeat_end_date`, which has no CHECK).
- New holidays may not start before today (400 「시작일은 오늘 이후로 정해 주세요」), and
  nothing may run past 2100-12-31 — start, end and repeat end dates, and for COUNT the
  date of the last occurrence (400 「반복 횟수가 2100-12-31 을 넘습니다 …」). Monthly · yearly
  computation and `public_holidays` stop at 2100, and the list cannot ask for a later
  year, so such a holiday would never show anywhere.
- A holiday that started today shows `blockedReason` 「오늘 시작한 휴일은 강제 종료할 수
  없습니다 — 삭제해 주세요」.

## Stores are periods

`20261026135250_team1_bp_holiday_store_periods` turned both link tables into one row per
period, with an identity key instead of `(bp_holiday_id, store_id)`:[^store-periods-migration]

- **Adding** a store opens a period from today (from the holiday's start if it has not
  started). **Removing** closes it as of yesterday. A period that never applied — added
  today and removed today, or anything removed before the holiday starts — is marked
  `is_deleted` instead.
- Re-adding a store opens a **new row**, so 「적용 → 빠짐 → 다시 적용」 stays recorded.
- A partial unique index (`…_bp_holiday_id_store_id_open_key`, `WHERE NOT is_deleted AND
  effective_end_date IS NULL`) keeps
  one open period per holiday and store; the CHECK `effective_end_date >=
  effective_start_date` backs the rule that an empty period is deleted, not stored.
- Changing an upcoming holiday's start date moves the open periods' start with it.
- Excluded stores of a 전체 점포 holiday follow exactly the same rules: excluded from
  today, back in from today when removed.
- **The detail shows every period, not only the open ones** (front 요청, 2026-10-26):
  `stores` carries every undeleted period — open and closed — one line per period, so a
  store removed and re-added is two lines, sorted 점포명 → 점포 ID → 적용 시작일 →
  `periodId` (store names are not unique, so the id keeps one store's periods together).
  Never-applied (deleted) periods stay out. Each line has `periodId` (the row id, a UI
  key), `effectiveEndDate` (null while open) and `periodState` — UPCOMING · ACTIVE ·
  ENDED (API-only enum `BpHolidayPeriodState`, labels from `GET /enums`), judged against
  the holiday's own end too: a terminated or ended holiday makes its open periods ENDED,
  and an upcoming holiday's periods are UPCOMING, so the screen never recomputes the rule.
  `periodState` is judged against today (KST), not the `?date` the detail was opened
  with — `appliedStoreCount` follows `?date`, so on a past date the two use different days.
  The edit form's 「지금 열린 점포」 are the lines with `effectiveEndDate === null &&
  periodState !== 'ENDED'`; the PUT body is unchanged (open store ids).
- **Deploy this after (or with) the front that filters `stores`.** The field kept its name
  and shape but now includes closed periods. A form that still sends
  `stores.map(s => s.storeId)` puts removed stores back into the PUT body; duplicates are
  merged rather than rejected, so there is no 400 — the removed store silently starts a new
  period from today (a 전체 점포 holiday re-excludes a store whose exclusion was lifted).

# Who handles what

`bp-holiday-access.ts`, matching the store module's scope (`is_all_stores`,
`admin_store_mappings`):[^bp-holiday-access]

- **manageAll** — platform accounts, BP 마스터, and BP 관리자 with 전체 점포. Only they
  create or change 전체 점포 holidays and their excluded stores. 가맹 roles never do, even
  with 전체 점포 (CONFIG-10).
- Everyone else handles 특정 점포 holidays of the stores they cover. On a holiday that
  also covers someone else's store they may **only add or remove their own stores**;
  name, description, termination and deletion need every open target store in scope (403
  「맡지 않은 점포가 함께 묶인 휴일입니다 …」). Touching an uncovered store is 403.
- Every holiday in list and detail carries `actions` — `canUpdate`, `canUpdateStores`,
  `canTerminate`, `canDelete`, `blockedReason` — from those rules and the caller's menu
  cells (read from `role_group_menus` the way the guard reads them).

Writes lock the holiday row (`FOR UPDATE`), re-read it within the caller's scope, and
compare the `updatedAt` the screen read (update · terminate · delete — delete takes it as
`?updatedAt=`, since a deleted holiday cannot be restored): a stale value is 409
「다른 사용자가 먼저 수정했습니다 …」. Two saves of the same form therefore land once. A save
that changes nothing writes nothing, so it does not bump `updatedAt` and push other open
screens into a 409. Added stores must belong to the BP and be undeleted, and a closed
store cannot become a target store; each 400 names the reason and the store ids
(「이 BP 의 점포가 아닙니다: 99」, 「지운 점포입니다: 14」, 「폐점한 점포는 대상으로 더할 수
없습니다: 13」). Excluding a closed store is allowed — it only takes a store out.

# History and overlaps

Every write appends to `bp_holiday_change_histories`: `등록` with a one-line summary, then
`휴일명` · `설명` · `날짜` (`describeRule`, e.g. 「매주 · 시작 2026-10-30 · 종료일 없음」) ·
`적용 범위`, one `대상 점포` / `예외 점포` row per store (「… 추가(2026-10-26부터)」,
「… 빼기(2026-10-25까지)」, 「… 빼기」), `강제 종료`, and `삭제`. The history route is
the only place a deleted holiday still shows.

`POST /bp-holidays/overlaps` takes the same form (plus `bpHolidayId` when editing — it
must be a holiday the caller can see, or 404; the holiday itself is left out, and a past
start date is accepted only when that holiday has already started) and reports, per store, the dates another holiday already covers — the first ten dates with
holiday names and a count of the rest. It looks at the new holiday's dates from today (or
its start) for **one year**; endless repeats are not compared beyond that. A caller who
covers only some stores sees only their own stores in the answer. 공식 휴일 are
not compared.

# Not done here

- 1팀's ERD in `whale-erp-new-front` (`docs/erd/team1`) still describes the link tables
  with the old keys and "예외 점포는 휴일의 모든 날짜에 적용"; the next regenerated DDL would
  bring them back. The migration is the truth until the ERD is updated there.
- `origin_bp_holiday_id` is no longer written (split editing is gone); dropping the column
  is a later migration.
- Holiday-driven behavior elsewhere (attendance, payroll) does not read BP holidays yet.

[^bp-holidays-controller]: /bp-holidays 경로와 메뉴 동작(경로로 찾는 MN000015, X-Bp-Code-Id)
[^holiday-dates]: 하루 · 기간 · 반복의 날짜 계산
[^bp-holiday-changes]: 등록 · 수정 · 강제 종료 · 삭제(행 잠금)
[^bp-holiday-access]: 누가 어디까지 — manageAll · 점포 범위 · 상태별 동작
[^store-periods-migration]: 대상 · 예외 점포를 기간 행으로
