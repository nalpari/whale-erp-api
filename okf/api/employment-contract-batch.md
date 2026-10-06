---
type: Design
title: Employment Contract Batch (Expiry & Reminder)
description: Duplicate-execution-safe batch design for contract auto-expiry and expiry reminders across multiple instances, using a PostgreSQL advisory lock. Not yet implemented.
tags: [batch, cron, advisory-lock, postgresql, design]
status: draft
generated: { by: claude-code/opus-5, at: 2026-10-06T04:10:04Z }
sources:
  - id: batch-design
    resource: ../../docs/batch/employment-contract-batch.md
    title: 근로계약서 만료 처리 · 알림 배치 설계
    last_modified: 2026-09-18T06:21:15Z
---

# Not yet implemented

This concept summarizes a design document, not running code.[^batch-design]
`employment_contracts`, `contract_reminders`, `batch_job_runs`,
`BatchLockService`, and `ContractBatchScheduler` do not exist in the
codebase yet. When the contract domain model is actually built, re-check
this concept's premises first — the design document itself flags its
assumptions (response states, `expires_at`, the notification channel) as
provisional.

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
hash of a job-name string — not any row in `employment_contracts`. Postgres
has no idea what that integer means; it only tracks who grabbed it
first.[^batch-design] The two jobs (`contract-expire`,
`contract-expiry-reminder`) use different strings, so they run fully
independently of each other. The trap: that separation exists only as a
hardcoded string at each call site, not as anything the database enforces —
reusing the same name for an unrelated job makes it block that job too.

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
`UPDATE` itself is idempotent (`where status = 'PENDING'`), so it is always
safe to re-run — but nothing re-runs it automatically. Detection is a
`FAILED` row in `batch_job_runs`; recovery is re-invoking the same
idempotent job function (an admin endpoint or script), not hand-editing
`status` in the database.[^batch-design]

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

See [Items API](/api/items-api.md) for the same service's existing
idempotent-write pattern (a conditional `UPDATE` instead of a lock).

[^batch-design]: 근로계약서 만료 처리 · 알림 배치 설계
