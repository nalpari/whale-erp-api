---
type: Design
title: Employment Contract Batch (Expiry & Reminder)
description: Duplicate-execution-safe batch design for contract auto-expiry and expiry reminders across multiple instances, using a PostgreSQL advisory lock. The lock helper and the expiry job exist; the reminder job and run-log table do not.
tags: [batch, cron, advisory-lock, postgresql, design]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-06T07:51:01Z }
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
    last_modified: 2026-10-06T07:51:01Z
  - id: contract-expiry
    resource: ../../src/contracts/contract-expiry.service.ts
    title: ContractExpiryService
    last_modified: 2026-10-06T07:51:01Z
  - id: contract-expiry-scheduler
    resource: ../../src/contracts/contract-expiry.scheduler.ts
    title: ContractExpiryScheduler
    last_modified: 2026-10-06T07:51:01Z
  - id: contracts-module
    resource: ../../src/contracts/contracts.module.ts
    title: ContractsModule (not wired into AppModule)
    last_modified: 2026-10-06T07:51:01Z
---

# What exists, and where it departs from the design

The design document predates the physical schema, so the code follows the
schema where the two disagree.[^batch-design]

- **The helper is real**: `BatchLockService.runExclusive(jobName, work)`
  (`src/batch/`). Every job name lives in `BATCH_JOB`
  (`src/batch/batch-job-names.ts`), and `runExclusive` accepts only those
  names. A new job adds its name there rather than passing a bare string.
- **The expiry job is real but not wired in.** `ContractsModule`
  (`src/contracts/`) is deliberately absent from `AppModule`: the
  `contracts` table has no migration yet (migrations wait for 1팀's tables),
  so wiring it now would fail every midnight. Add it to `imports` once the
  migration lands. `ScheduleModule.forRoot()` is already registered.
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
- **Not built**: the reminder job, `contract_reminders`, and the manual
  re-run path.
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
first.[^batch-design] Jobs with different names (`contract-expire` today,
the designed `contract-expiry-reminder` once built) run fully independently
of each other. Nothing in the database enforces that
separation — reusing a name for an unrelated job makes it block that job too.
`BATCH_JOB` keeps every name in one place so a collision is visible.

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
failure leaves overdue contracts un-expired for up to 24 hours. The expiry
`UPDATE` itself is idempotent (`where status = 'PENDING_SIGNATURE'`), so it is always
safe to re-run — but nothing re-runs it automatically. The design detects
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
