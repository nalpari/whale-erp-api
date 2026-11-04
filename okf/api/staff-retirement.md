---
type: API
title: Staff retirement
description: How a 관리자 retires a 직원 레코드 — the date is stored now, the record turns RETIRED the day after by a midnight batch that also clears schedules, personal TO-DO assignments and unsigned contracts; contracts are never shortened.
tags: [staff, retirement, batch, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-11-04T09:30:00Z }
sources:
  - id: retirement-service
    resource: ../../src/staff-members/retirement.service.ts
    title: RetirementService (preview · retire · changeDate · cancel · retireDue · retireStore · retireStores)
    last_modified: 2026-11-04T06:27:00Z
  - id: store-closing-check
    resource: ../../src/staff-members/store-closing-check.ts
    title: storeClosingCheck — 폐점 확인(WHALEERP-647 · 650, 읽기만)
    last_modified: 2026-11-04T06:50:06Z
  - id: retirement-controller
    resource: ../../src/staff-members/retirement.controller.ts
    title: /staff-members/:id/retirement (직원 정보 관리 수정 권한)
    last_modified: 2026-10-21T01:46:17Z
  - id: retirement-scheduler
    resource: ../../src/staff-members/retirement.scheduler.ts
    title: Midnight KST batch (staff-retire)
    last_modified: 2026-10-08T05:19:12Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: Which stores an 관리자 manages
    last_modified: 2026-10-29T07:10:00Z
  - id: kst-date
    resource: ../../src/staff-members/kst-date.ts
    title: KST "today" and date-only helpers
    last_modified: 2026-10-13T00:58:41Z
---

# What it is

직원 퇴직 처리 (WHALEERP-583 · 584). Four 관리자 웹 routes, all behind
`@MenuPermission('update')` — 직원 정보 관리 수정 권한 (WHALEERP-586; the guard finds the menu by the controller path `/staff-members`, MN000005's URL):[^retirement-controller]

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

# Closing a store sets the retirement dates (WHALEERP-648)

운영 정책 CTR-31, decided 2026-11-03 (노영주: follow the 1팀 request document; this replaces the
WHALEERP-646 `retireAllForStoreClosing(tx, storeIds, …)` of PR #237). `RetirementService.retireStore(tx, storeId, closedDate, adminAccountId, now?)`
is a method only — no route, no DTO, no migration; `StaffMembersModule` already exports the service.
1팀's 폐점 api (`PUT /stores/:id`) calls it **inside the transaction that has locked the store row
and sets it CLOSED** (`FOR NO KEY UPDATE` since 2026-11-04, through `retireStores` — see 「1팀 답」 below), so one failure rolls the closing back. Exceptions are not swallowed
and no notification goes to the staff. `closedDate` is normalised to the KST date (`kstToday`).[^retirement-service]

**Lock order: store (1팀, first) → staff → account.** Inside the method: the store's `EMPLOYED` staff rows
in ascending `staff_member_id`, `FOR NO KEY UPDATE`; then their account rows (rows with an `account_id`,
de-duplicated) in ascending `account_id`, `FOR UPDATE` — the staff → account order of `lockStaff`. The
conditions are re-evaluated after the lock, so a record that changed in between is not missed. After
the locks every locked record gets the same open-check-in check as a normal retirement
(`assertNoOpenCheckIn`: 3-month correction window, working until the day after check-in); one open
check-in is 409 `OPEN_CHECK_IN` (same body as `retire`) and rolls the whole closing back.

**What happens at the closing moment (this method, same transaction):**

1. The store's pending contracts (`contracts.store_id = storeId`; 임시저장 · 발송 대기 · 서명 대기 · 수정 요청)
   become `ENDED` at once, with a `contract_status_histories` row (`actor` ADMIN; the history table has no
   operator column). The drafts of a "임시저장만 있는 가입 전" record are closed too.
2. Every `SENT` invitation on the store's staff records — sign-up, re-invite, affiliation confirm, return
   confirm — becomes `EXPIRED`.
3. The retirement date of each target (every `EMPLOYED` record of the store, **including a "임시저장만 있던 가입 전"
   record** — its drafts were just ended, so it now counts as 재직 (CTR-29) and the next day's batch must retire it) is
   decided the way `schedule` / `changeDate` do:
   - no date → the closing date (`RETIRE` log rows, one per spanning 체결 완료 contract);
   - date after the closing date → pulled forward to it (`CANCEL` old date + `RETIRE` closing date, same `processed_at`);
   - date on or before the closing date → kept, no log;
   - hired date after the closing date → the closing date anyway (WHALEERP-613); already `RETIRED` → excluded.
4. 체결 완료 contracts that start after the closing date are left alone (CTR-31; check-in is blocked by WHALEERP-643).

**What it does not do — the next day's `retireDue` batch does:** the record stays `EMPLOYED`
(`finalize` is not called). Work-schedule deletion and personal TO-DO release happen when the batch finds
`retired_date < today`. Contracts and invitations are already closed, so the batch has nothing left to
close there; its conditional updates are no-ops for them.

**Accepted risk (2026-11-03 노영주):** while 1팀 holds the store `FOR UPDATE`, inserting a new staff record
(foreign key) is blocked; if 1팀 changes to `FOR NO KEY UPDATE`, a record created between the query and the lock may not
be retired. The gap is short, so it is accepted. **1팀 changed to `FOR NO KEY UPDATE` on 2026-11-04 (1팀 note:
under `FOR UPDATE` the insert was only delayed until the closing committed, not refused, so the gap existed before as
well)** — see [store management](/api/stores.md) 「Closing a store」.

**Return value** (same names and meaning as the 폐점 확인 service, WHALEERP-647; 1팀 uses it for the result
message and the store change history):

| Field | Meaning |
|---|---|
| `retiringStaff` | staff who will retire — the same criterion as the 폐점 확인 service's (647): the store's `EMPLOYED` records that are not 「임시저장만 있는 가입 전」 (no date, pulled forward, on or before the closing date all counted). A 「임시저장만 있던 가입 전」 record still gets its date set but is not counted (it shows up in `draftContracts`) |
| `pulledForwardStaff` | how many had the date pulled forward to the closing date |
| `draftContracts` | 임시저장 contracts ended |
| `pendingSendContracts` | 발송 대기 contracts ended |
| `pendingSignatureContracts` | 서명 대기 + 수정 요청 contracts ended |
| `expiredInvitations` | `SENT` invitations expired |

**Known risk — lock order against the closing (not fixed here; 1팀 decides, see 「1팀이 정할 것」):** the closing
takes store → staff, but these paths take staff → store, so running at the same time as a closing they can
deadlock (`40P01`):

- expired / rejected contract resend — staff `FOR NO KEY UPDATE` (`contract-status.ts:224`, called by
  `contract-send.service.ts:136`) then `reopenBlockOf` takes the store `FOR SHARE` (`contract-reopen.ts:51-54`);
- work-schedule save — staff `FOR NO KEY UPDATE` (`work-schedules.service.ts:1097`) then the insert at
  `work-schedules.service.ts:973` takes the store foreign key;
- TO-DO creation — the store's staff rows `FOR SHARE` (`todos.service.ts:190`) then `todo.createManyAndReturn`
  (`todos.service.ts:215`, store foreign key);
- staff-app check-in / check-out — account `FOR UPDATE` (`my-attendance.service.ts:404`) then
  `attendanceRecord.create` (`my-attendance.service.ts:363`), whose `attendance_records_store_id_fkey` takes the store
  `FOR KEY SHARE`; admin attendance register / correction — account (or staff, when there is no account) `FOR UPDATE`
  (`attendance-edit.service.ts:442-445`, `:731-734`) then the inserts (`:302`, `:326`, `:549`, `:589`). These collide
  with the closing's store `FOR UPDATE`, and the closing then waits for the same account `FOR UPDATE`: `40P01` is
  possible, and a check-out on the closing day is common;
- account → staff order (the closing takes staff → account, so these can deadlock): adding a workplace
  (`staff-signup.service.ts:445` account `FOR UPDATE` then `:461` staff `FOR UPDATE`) and accepting an affiliation
  request (`affiliation-requests.service.ts:371` account `FOR UPDATE` then `:379` staff `FOR UPDATE`);
- staff → store foreign key: writing an employment contract (`lockStaffForReplace` staff `FOR NO KEY UPDATE`,
  `contract-duplicates.ts:68`, called at `contracts.service.ts:1188`, then `tx.contract.create` at
  `contracts.service.ts:1387`) and copying last week's work schedules (staff rows `FOR NO KEY UPDATE` at
  `work-schedules.service.ts:801`, then `this.insert` at `:859` → `tx.workSchedule.create` at `:973`).

Since 2026-11-04 (1팀 답 1) the closing locks the store `FOR NO KEY UPDATE`, which the foreign-key `FOR KEY SHARE`
does not wait for — the store-foreign-key items above no longer deadlock with it. Contract resend (store `FOR SHARE`)
and the account → staff paths remain; the closing retries once on them (1팀 답 2).

The employee-side contract rejection (`my-contracts.service.ts:318`, `lockMine` staff `FOR SHARE`) was
listed too, but no store lock was found in `rejectContract` (`contract-status.ts:543`); it is unconfirmed.
The code is not changed.

**1팀이 정할 것** (decisions for 1팀, not for 3팀 or 재영; 노영주 2026-11-03):

1. How the store row is locked. `lockStore` is `FOR UPDATE` (delete still uses it; the closing no longer does — 1팀 답 below), which collides with the foreign-key inserts
   (`FOR KEY SHARE`) of attendance (staff app, admin register, correction), work schedules and TO-DOs: between a
   check-in/out that took the account first and `retireStore` (waiting for the account `FOR UPDATE`) `40P01` can
   happen. 1팀's document (D4) does not cover these foreign-key locks. `FOR NO KEY UPDATE` breaks that loop.
2. The deadlock with the resend path (staff `FOR NO KEY UPDATE` → store `FOR SHARE`) remains even with 1 — how to
   handle it (e.g. retry the closing on `40P01`) is 1팀's call.
3. The closing transaction's `timeout` (a store with many staff exceeds Prisma's default 5 seconds), and the
   precondition that 1팀 passes today (KST) as `closedDate` — this method does not check that it is today. With many
   staff the account locks are held long, until the transaction ends.
4. Closing several stores at once (e.g. BP withdrawal): calling `retireStore` once per store stacks the store, staff
   and account locks store by store, so the order gets mixed (deadlock is possible when an account spans several
   stores' staff). How to call it — e.g. in ascending store id — is 1팀's call.
   **1팀 답 (2026-11-04, WHALEERP-651): 회원 탈퇴는 점포 행을 모두 id 오름차순으로 잠근 뒤 `retireStores` 를 한 번 부른다. 점포 하나 폐점도 `[storeId]` 로 부른다(`retireStore` 는 같은 동작의 감싼 함수로 남김).** The transaction `timeout` is still raised by 1팀 (item 3).

   **1팀 답 (2026-11-04, 1–3 — 1팀 폐점 서비스 `StoreClosingsService`, [store management](/api/stores.md) 「Closing a store」):**
   1. 폐점은 점포 행을 `lockStore`(`FOR UPDATE`)가 아니라 `FOR NO KEY UPDATE` 로 잠근다(여러 점포는 id 오름차순).
   2. 교착(`40P01`)이면 폐점 트랜잭션 전체를 한 번 다시 한다(`retryOnDeadlock`, 첫 교착은 경고 로그). 두 번째도 교착이면 409 「다른 처리와 겹쳐 폐점하지 못했습니다…」로 알린다.
   3. 폐점 트랜잭션 `timeout` 은 30초(`STORE_CLOSING_TRANSACTION_TIMEOUT_MS`), `closedDate` 는 1팀이 늘 한국 날짜 오늘로 넘긴다.

# Closing several stores at once — `retireStores` (WHALEERP-651)

운영 정책 CTR-31 follow-up of 648 (1팀 요건 「BP 탈퇴 시 소유 점포 자동 폐점」). `RetirementService.retireStores(tx, storeIds, closedDate,
adminAccountId, now?)` closes every store's pending work in one transaction, called after 1팀 has locked **all** the store rows in
ascending `store_id` and run the closing check. Method only — no route, DTO or migration.[^retirement-service]

```ts
interface StoresClosingRetirementResult {
  byStore: Record<number, StoreClosingRetirementResult>; // one entry per store id passed (zeros if no staff)
  total: StoreClosingRetirementResult;                   // sum of byStore
}
```

- `storeIds` is de-duplicated; an empty array runs no query and returns `byStore: {}` with an all-zero `total`. `closedDate` is
  normalised with `kstToday` as in `retireStore`.
- `retireStore(tx, storeId, …)` is kept as a thin wrapper: it calls `retireStores(tx, [storeId], …)` and returns `byStore[storeId]`,
  so its return value and processing are the same; the 409 `OPEN_CHECK_IN` body gains `storeId`, and the open check-in it picks is now the earliest in the whole store (it used to be the earliest of the lowest-id staff record that had one).
- **Same rules as `retireStore`, with `IN` instead of one query per store.** Lock: every store's `EMPLOYED` staff rows in one
  `store_id IN (…)` query ordered by `staff_member_id`, `FOR NO KEY UPDATE`; then the de-duplicated account rows in one query ordered by
  `account_id`, `FOR UPDATE` — an account with records in several stores is locked once, in one global order.
- Open check-ins: after the locks, one query over all locked records, the same criteria as `assertNoOpenCheckIn` (a shared
  `openCheckInWhere`: 3-month correction window, CHECK_IN without its check-out, 「근무 중」 wording up to the next day). The earliest open
  check-in raises 409 `OPEN_CHECK_IN` with the usual body plus **`storeId`** (its store); the whole transaction rolls back. The single
  retire's 409 body is unchanged (no `storeId`).
- Retiring staff / dates / counts: the same rules; the 「draft-only 가입 전」 test is one `contract.groupBy` for all pre-join records
  (not a `count` per staff). `schedule` (save the date, log, spanning contracts) still runs per staff. Each result lands in the
  record's own `storeId` entry.
- Pending contracts: `endPendingContracts` with `{ storeId: { in: ids } }`, once per status, counting by the returned `storeId`
  (waiting for signature + correction requested are summed); history actor `ADMIN`. `SENT` invitations: one `updateManyAndReturn`
  over `staffMember.storeId IN (…)`, counted per store by mapping the returned `staffMemberId` to the store's records (retired ones
  included, one lookup by store ids).
- No `finalize` (`retireDue` does it the next day), exceptions are not swallowed (whole rollback), no staff notification.
- Tests: unit (several stores, duplicate ids, empty array, an account across two stores locked once, 409 `storeId`, per-store and total
  counts, query count not growing with the store count, `retireStore` equal to `retireStores([id])`) and e2e (two stores with one shared
  account locked in id order then `retireDue`, an open check-in in only one store rolls both back).

# An open check-in blocks retirement

Retire and change-date both refuse with 409 `OPEN_CHECK_IN` while that staff record has a check-in without its check-out
(「MM/DD HH:mm 퇴근하지 않은 출근이 있습니다. 출 · 퇴근 현황에서 먼저 보정으로 닫아 주세요.」). Otherwise the retired membership would keep an
open check-in no one can close (2026-10-27 재영). Check-ins older than the 3-month correction window are ignored — they can no
longer be corrected, so they would block forever. An open check-in made after the date is saved stays as 퇴근 미등록 for the
admin to correct; the batch does not close it. `assertNoOpenCheckIn` in `retirement.service.ts`; unit and e2e tests.
Locks go staff row → account row, the same order as 생년월일 정정 and 세무 정보. The staff row is taken `FOR NO KEY UPDATE`
(all three places), so a staff check-in — which locks the account first and then inserts a record whose foreign key takes
`FOR KEY SHARE` on the staff row — never waits on it, and the two orders cannot deadlock (PR #159 review). Holding the account
row means no check-in slips in between the open check-in check and the retirement commit.

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
대신 임시저장을 지워 주세요.」.

Other refusals: RETIRED is 409; changing to the same
date is 409 (it would only stack log rows); a date older than 3 months (calendar
months, clamped to month end) is 400, and so is one before the 입사일 — a past
date clears schedules from the next day on, so an early one would erase the days
actually worked — **unless the 입사일 has not come yet** (a contract with a future 시작일 was signed and
the person leaves before starting: no day was worked, so an earlier 퇴직일 is accepted — WHALEERP-613,
2026-10-22 김민식). The 입사일 is filled when a contract becomes 체결 완료
([Contracts API](/api/contracts-api.md)); a record left without one because its 퇴직일 came before a signed
contract's 시작일 gets it when the 퇴직 is cancelled or moved past that 시작일 (`refillHiredDate`, api #124
review). There is no upper bound on a future date. A malformed or
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
store under this rule — until this route passes the tab BP (`@TargetBp()`) to
`AdminScopeService`, which then gives them all of that BP's stores (2026-10-26).

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

# Checking before closing

WHALEERP-647 · 650, 운영 정책 CTR-31. `storeClosingCheck(client, storeIds, closedDate, now?)` is the read-only pre-closing
check — a plain function, no route. It takes several stores because BP withdrawal closes all of a BP's open stores in one
transaction (1팀 request, 2026-11-04); a single store closing passes `[storeId]`. 1팀 means to call it from the store edit
screen (`transitionCheck`), the closing confirmation popup and right before saving the closing inside its own transaction,
passing the same `client` (PrismaService or the transaction) so all three see the same rows. Scope and permission are the
caller's; whether to block the closing is the caller's decision too.

Right before saving, call it once for all the stores, before any of them is set CLOSED (a closed 가맹 store hides consented
staff too, so `first` would go empty while `count + hiddenCount` stays) and before `retireStores` (after it the pending
contracts are already ENDed and the contract counts read 0). The check alone does not close anything safely: it reads without
locks, and `retireStores` is what sees the rows again after locking. The staff and contract fields of `stores[n]` have the same
names and meaning as `byStore[storeId]` of the `retireStores` return value, and `total` as its `total`.[^store-closing-check]

Duplicate ids count once and an empty array returns an empty list and zeros without a query. Each table is asked once with
`IN`, so the query count does not grow with the stores. A store that does not exist or is deleted is 404 with its id in the
message — returning a partial count could let a closing through that should be blocked.

It returns `{ stores, total }`: `stores` is one entry per store in ascending id (`storeId` plus the fields below), `total` is the same
fields summed. `total.openCheckIns.first` is the earliest of the check-ins whose name may be shown, across the stores, and
`first` carries `storeId`. 1팀 decides on `total.openCheckIns.count + total.openCheckIns.hiddenCount`. The fields:

- `openCheckIns: { count, hiddenCount, first }` — open check-ins of the store's `EMPLOYED` records, by the same rule as
  the admin open-check-in route (WHALEERP-644, shared `openCheckInsOf`: within the 3-month correction window) but without
  retired records — exactly what `retireStore` blocks on (`assertNoOpenCheckIn` per employed record); a retired record's
  open check-in does not block the closing. Staff a 본사 역할 would not see (`hidesPersonalData` judged for 본사 역할 — on a non-직영 store, unless the staff
  consented and the store is not closed) are counted in `hiddenCount` only and never picked as `first` — always, whoever
  calls, since the caller is not an input (2026-11-03 재영). Blocking must look at `count + hiddenCount`: `retireStore`
  answers 409 `OPEN_CHECK_IN` for any open check-in of an `EMPLOYED` record and rolls the closing back, so the
  confirmation screen is where 1팀 can warn first.
- `retiringStaff` — `EMPLOYED` records of the store minus draft-only 가입 전 records, the same count `retireStore` returns.
- `draftContracts` · `pendingSendContracts` · `pendingSignatureContracts` (서명 대기 + 수정 요청) — the store's pending
  contracts (`contracts.store_id`) by status, which `retireStore` ENDs at the closing moment (a draft-only 가입 전 record's
  drafts included, a retired record's pending contracts on that store too). 체결 완료 contracts are never ENDed.
  `closedDate` is taken like `retireStore`'s input but changes none of these counts today.
- `unconfirmedPayslips` — 작성 중 · 검토 중 payslips of the store. Retirement keeps payslips (PAY-4: the staff app
  shows sent ones for 3 years from creation, retired or not).

It reads without locks; whatever changes between the check and the save, `retireStore` sees again after its locks
(an open check-in is the 409, contracts and staff are ended and counted from the locked rows). The e2e checks the counts
against a real `retireStore` run (rolled back).

# Dates

"Today" is the Korean date (`kstToday`); date-only columns come back from Prisma
as UTC midnight, and every helper in `kst-date.ts` works in that shape. A
schedule's `start_at` is a timestamp, so "from the next day" is compared against
`kstDayStart(retired_date + 1)` — 15:00 UTC of the retirement date.[^kst-date]

[^retirement-service]: RetirementService (preview · retire · changeDate · cancel · retireDue · retireStore · retireStores)
[^retirement-controller]: /staff-members/:id/retirement (직원 정보 관리 수정 권한)
[^retirement-scheduler]: Midnight KST batch (staff-retire)
[^admin-scope]: Which stores an 관리자 manages
[^kst-date]: KST "today" and date-only helpers
[^store-closing-check]: storeClosingCheck — 폐점 확인(WHALEERP-647 · 650, 읽기만)
