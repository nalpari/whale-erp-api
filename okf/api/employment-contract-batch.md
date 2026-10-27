---
type: Design
title: Employment Contract Batch (Expiry & Reminder)
description: Duplicate-execution-safe batch design for the daily employment-contract job across multiple instances, using a PostgreSQL advisory lock. The daily job expires 서명 대기 contracts and overdue invitations, ends 체결 완료 contracts past their end date and picks 갱신 예정 contracts, then notifies 관리자 after the commit; the run-log table does not exist.
tags: [batch, cron, advisory-lock, postgresql, design]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-26T03:00:00Z }
sources:
  - id: batch-design
    resource: ../../docs/batch/employment-contract-batch.md
    title: 근로계약서 만료 처리 · 알림 배치 설계
    last_modified: 2026-09-18T06:21:15Z
  - id: batch-lock
    resource: ../../src/batch/batch-lock.service.ts
    title: BatchLockService
    last_modified: 2026-10-06T07:51:01Z
  - id: batch-job-names
    resource: ../../src/batch/batch-job-names.ts
    title: BATCH_JOB
    last_modified: 2026-10-13T04:47:40Z
  - id: contract-expiry
    resource: ../../src/contracts/contract-expiry.service.ts
    title: ContractExpiryService (하루 배치 runDaily)
    last_modified: 2026-10-26T03:00:00Z
  - id: contract-expiry-scheduler
    resource: ../../src/contracts/contract-expiry.scheduler.ts
    title: ContractExpiryScheduler
    last_modified: 2026-10-26T03:00:00Z
  - id: contract-notice
    resource: ../../src/contracts/contract-notice.service.ts
    title: ContractNoticeService (날인 · 거부 · 만료 · 갱신 예정 알림)
    last_modified: 2026-10-26T03:00:00Z
  - id: contracts-module
    resource: ../../src/contracts/contracts.module.ts
    title: ContractsModule (wired into AppModule)
    last_modified: 2026-10-26T03:00:00Z
---

# What exists, and where it departs from the design

The design document predates the physical schema, so the code follows the
schema where the two disagree.[^batch-design]

- **The helper is real**: `BatchLockService.runExclusive(jobName, work)`
  (`src/batch/`). Every job name lives in `BATCH_JOB`
  (`src/batch/batch-job-names.ts`), and `runExclusive` accepts only those
  names. A new job adds its name there rather than passing a bare string.
- **The expiry job runs.** `ContractsModule` (`src/contracts/`) is in
  `AppModule` since 2026-10-13 (api PR #19, which also brought
  `GET /contracts`); before that the module existed but nothing loaded it. Every running instance schedules it at
  midnight; the advisory lock is what keeps it to one run.
- **Schema names, not design names**: `contracts` / `contract_id`,
  `PENDING_SIGNATURE` → `EXPIRED`, `sign_deadline_at` — not the design's
  `employment_contracts` / `PENDING` / `expires_at`. Each expiry also writes a
  `contract_status_histories` row with `actor = SYSTEM`, which the design
  omits. It uses `updateManyAndReturn`, so history is written only for the
  rows the conditional `UPDATE` actually changed.
- **No run-log table.** The design's `batch_job_runs` would need a
  migration, so `RAN` / `SKIPPED_LOCKED` / `FAILED` go to the Nest `Logger`
  for now. Under the naming rules the table, when it comes, is a
  `_logs` table, not `_runs`.
- **One daily job, `contract-expire`** (KST midnight, `ContractExpiryService.runDaily`, WHALEERP-152). In one
  transaction it expires 서명 대기 contracts past `sign_deadline_at`, expires `SENT` invitations past `expires_at`
  (the 발송 대기 contract stays, so the 관리자 can resend — a 만료 contract has no way out until WHALEERP-153, api #150
  review), ends 체결 완료 contracts whose `end_date` is before today (KST) or whose 재계약 (WHALEERP-156 —
  `previous_contract_id` points at it) is 체결 완료 and has started (`start_date` today or earlier; the end date is
  kept), copies the 고용 형태 · 직무 of the latest started contract that went through 체결 (`SIGNED`, or `ENDED` from `SIGNED`
  by `SYSTEM`; any contract of the record; ties on 시작일 go to the larger id) to the 직원 레코드 where they differ (a 재계약 signed
  ahead of its 시작일 — `applyStartedTerms` only copies at signing when it has started; WHALEERP-156), and stamps
  `renewal_notified_at` on 체결
  완료 contracts ending within 30 days that were not stamped yet (a range, not one date, so a skipped day does not
  lose any) — not for a 직원 leaving on or before that contract's end date or one who already has a contract in
  progress or a 체결 완료 ending after it (`needsRenewal`). Every step is a conditional `UPDATE`, so a rerun changes
  nothing twice. 체결 완료 → 종료 keeps the contract in every 「signed」 count (재직 직원 TO-DO, 점포 재직 직원 수,
  급여명세서 효력 계약) through `SIGNED_ONCE` (`src/contracts/signed-contract.ts`) — a 종료 this batch made from 체결
  완료 (history `SIGNED → ENDED` by `SYSTEM`; a 체결 완료 closed by 대체 is not, api #152 review).
- **Notices after the commit.** `runExclusive` only returns a count, so the scheduler keeps what `runDaily`
  returned and, once the lock's transaction has committed, tells the 관리자 about each 만료 (keyed by its history
  ID) and each 갱신 예정 (keyed by the contract ID) through `ContractNoticeService` — one at a time, never throwing.
  Sending inside the transaction would make the affected contracts' 날인 · 재발송 wait on SMTP and would send even
  when the batch rolls back. A skipped run (`SKIPPED_LOCKED`) or a failed one notifies nothing.
- **Not built**: `contract_reminders` (the design's per-contract reminder table — `renewal_notified_at` covers the
  one 갱신 예정 notice) and the manual re-run path.
- **Pinned to `@nestjs/schedule` 6.x.** 12.x is ESM-only, and Jest
  (ts-jest, CommonJS) fails to parse it.

# The problem: the same cron fires on every instance

`whale-erp-api` runs as multiple stateless instances behind a load
balancer, so a cron registered with `@nestjs/schedule` fires once per
instance, simultaneously. Left alone, that means contracts get
double-expired and reminders get double-sent. Instances cannot coordinate a
"leader" because they are stateless and unaware of each other, and the
stack has no dedicated lock infrastructure (Redis etc.) — only
PostgreSQL.[^batch-design]

# The lock holds a job name, not a row

`pg_try_advisory_xact_lock(hashtext(jobName))` locks a single integer — the
hash of a job-name string — not any row in `contracts`. Postgres
has no idea what that integer means; it only tracks who grabbed it
first.[^batch-design] Jobs with different names (`contract-expire`, `staff-retire`,
`lead-purge`, `todo-due-soon` and `work-schedule-purge` today, the designed `contract-expiry-reminder` once built) run fully
independently of each other. Nothing in the database enforces that
separation — reusing a name for an unrelated job makes it block that job too.
`BATCH_JOB` keeps every name in one place so a collision is visible. Request
paths take advisory locks in the same `hashtext` space — 도입문의 접수 locks
`lead-intake…`, 근무스케줄 등록 · 지난 주 복사 lock `work-schedule-week:<store>:<monday>` —
so a new job name must not reuse one of those either.

**The lock excludes overlap, not repetition.** It stops two runs that are in
flight at the same moment; it does not make a job run once per cycle. An
instance whose cron fires a little late — clock skew, a busy event loop —
arrives after the first run has committed and released the lock, finds it
free, and runs the job again. With few rows the first run finishes in
milliseconds, so this is not hypothetical. Every `work` passed to
`runExclusive` must therefore be idempotent; the expiry job is (a second run
matches no rows), but a job that appends or sends cannot rely on the lock
alone and needs its own per-target guard, as the reminder design does with
its unique constraint. This is where the design's requirement 1 ("exactly
one instance per cycle") does not hold.

The lock is transaction-scoped (`pg_try_advisory_xact_lock`, not
`pg_advisory_lock`) specifically because Prisma's `$transaction` callback is
guaranteed to run on one connection for its whole duration. The
session-scoped variant would require acquiring and releasing on the same
physical connection, which a pooled client cannot guarantee — the easy way
to leak a lock forever.[^batch-design]

# Release is "connection-loss detection," not a timeout

When `work(tx)` throws, or the instance exits cleanly (SIGTERM), the
transaction rolls back and the lock is freed almost immediately. A hard
crash (SIGKILL, OOM, power loss) or a network partition is different: no
TCP FIN is ever sent, so Postgres only notices the connection is gone via
TCP keepalive — which, at default settings, can take tens of minutes to
hours. This is a separate mechanism from Prisma's `$transaction` `timeout`
option: `timeout` only fires because a live process is still running code
that enforces it; a dead process enforces nothing.[^batch-design]
Satisfying the design's own requirement — a crashed instance must not hold
the lock forever — for the hard-crash case requires explicitly tuning
keepalive settings, not just trusting the default.

# Moving the expiry cadence from 10 minutes to daily raises the cost of failure

The expiry job's cadence was fixed at once a day
(`EVERY_DAY_AT_MIDNIGHT`). At a 10-minute cadence, a failed run self-heals
within 10 minutes and the delay is negligible; at once a day, the same
failure leaves overdue contracts un-expired for up to 24 hours. Every step of the daily job is a conditional
`UPDATE` (`status = 'PENDING_SIGNATURE'` for 만료, `'SENT'` for invitations, `'SIGNED'` for 종료,
`renewal_notified_at IS NULL` for 갱신 예정), so it is always safe to re-run — but nothing re-runs it automatically.
It locks the 직원 rows of the contracts and invitations it will change first — 만료 targets, expired
invitations and 체결 완료 contracts ending by the end of the 갱신 예정 window — in id order (직원 → 초대 → 계약, like
퇴직 확정, 가입 and contract replacement), so they queue instead of deadlocking. After the commit it sends the
notices five at a time, so a large first run or one stalled SMTP connection does not hold up the rest. The design detects
failure with a `FAILED` row in `batch_job_runs` and recovers by re-invoking
the same idempotent job function (an admin endpoint or script), not by
hand-editing `status` in the database.[^batch-design] Neither exists yet.
Once the job is wired in, a failed midnight run leaves only a `FAILED` log
line, and a run that never happens — no instance up at midnight, say during a
deploy — leaves nothing at all. Overdue contracts then stay un-expired until
the next midnight run, and nothing alerts anyone unless the logs are watched.

# The reminder job is at-least-once, not exactly-once

Duplicate reminders are blocked by a unique constraint on
`(contract_id, reminder_type)`, but the window between "insert succeeds,"
"external notification call," and "commit" is not closed: if the
transaction rolls back after the notification call already fired — a
crash, or an exception thrown later in the same loop — the insert rolls
back with it, and the next cycle resends. The loop case generalizes beyond
a plain crash: an exception on contract N also rolls back the inserts
already made for contracts `1..N-1` in that same transaction, even though
their notifications already went out. Exactly-once would need an outbox
pattern; the design doesn't adopt one, judging it over-engineered for the
expected volume (one store's worth of reminders).[^batch-design]

The removed items sample ([Items API](/api/items-api.md), deprecated) used the
same idempotent-write pattern — a conditional `UPDATE` instead of a lock.

[^batch-design]: 근로계약서 만료 처리 · 알림 배치 설계
