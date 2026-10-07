---
type: API Endpoint
title: Items API
description: (Removed 2026-10-07) The template's item master and stock movements sample, once the worked example for a domain module.
tags: [api, items, inventory, prisma]
status: deprecated
generated: { by: claude-code/opus-5.5, at: 2026-10-07T05:38:00Z }
sources:
  - id: items-service
    resource: ../../src/items/items.service.ts
    title: ItemsService (business rules)
    last_modified: 2026-08-28T03:30:00Z
  - id: main-ts
    resource: ../../src/main.ts
    title: Swagger 설정 및 전역 ValidationPipe
    last_modified: 2026-10-06T09:07:33Z
  - id: init-migration
    resource: ../../prisma/migrations/0_init/migration.sql
    title: Baseline migration (the only place CHECK constraints exist)
    last_modified: 2026-08-28T03:25:00Z
---

> **Deprecated (2026-10-07).** The `items` / `stock_movements` sample, its
> migrations, and `ItemsModule` were removed with the other template samples
> (재영). Nothing replaces it as the worked example yet; the first real domain
> module will. Kept for history — its lessons (id range check, CHECK constraints
> living only in migration SQL) are in CLAUDE.md and
> [Naming conventions](/conventions/naming.md).


# Endpoints

Every route here requires a **staff** access token: the controller carries
`@UserTypes('staff')`, so a customer token gets 403 rather than 200. Without a
token at all the global guard answers 401 before any handler runs. See
[Authentication](/api/auth.md).

Browsable at `/docs` (Swagger UI) outside production; the raw document is at
`/docs-json`.[^main-ts]


| Method | Path | Notes |
|---|---|---|
| `GET` | `/items` | Every item with its derived stock. |
| `GET` | `/items/:id` | 404 when absent, including a non-numeric id. |
| `POST` | `/items` | 409 on duplicate `sku`. |
| `PATCH` | `/items/:id` | Partial update. 400 on an empty body, 409 on duplicate `sku`. |
| `DELETE` | `/items/:id` | 204 on success, **409 when the item has movements**. |
| `POST` | `/items/:id/stock-movements` | Positive quantity receives, negative issues. |

`GET /items` is paged: `take` defaults to 50 and caps at 200, `skip` defaults to
0. The stock aggregate is scoped to the ids on the current page, so response
time does not grow with the movement history of items the caller never sees.

# Stock is derived, not stored

There is no `qty` column. Stock is `SUM(stock_movements.quantity)` for the
item, so every change carries a `reason` and history is never lost to an
overwrite.[^items-service]

The cost is a `SUM` per read. `findAll` avoids N+1 by doing one `groupBy`
across all items rather than one aggregate per item. If that aggregate ever
becomes the bottleneck, the fix is a cached balance column maintained in the
same transaction — not a different read shape.

# Why the transaction takes a row lock

`addMovement` opens a transaction and issues `SELECT id FROM items WHERE id =
$1 FOR UPDATE` before reading the balance.[^items-service] Without the lock,
two concurrent issues both read the same stock, both pass the check, and both
commit — leaving negative stock that no single request appears to have caused.
The lock is held until the transaction ends, so the second request waits and
then sees the first one's movement.

Unit tests cover the arithmetic (reject when `current + quantity < 0`, allow
an exact-to-zero issue, treat a null `SUM` as zero). They cannot prove the
locking, because a mocked client has no concurrency — that guarantee rests on
the `FOR UPDATE` and is verified against a real database.

# Deletion is restricted, not cascading

The foreign key is `ON DELETE RESTRICT`, so deleting an item that has any
movement raises `23503`, which Prisma surfaces as `P2003` and the service
converts to a 409.[^items-service] Cascading was not chosen: stock movements are
the audit trail behind every balance, and letting a `DELETE /items/:id` erase
them would remove the evidence for numbers that were already reported.

An item with history therefore cannot be removed through the API at all. When
that becomes a real need, the answer is a soft-delete flag, not a cascade — the
history has to survive either way.

# Constraints live in two places

Validation is deliberately duplicated: `class-validator` on the DTOs rejects
bad input at the HTTP boundary with a useful message, and CHECK constraints in
the database reject it regardless of which client wrote the row.[^init-migration]
The DTO layer is the nice error; the database is the guarantee. Removing
either one is a downgrade.

See [Whale ERP API](/api/whale-erp-api.md) for the service overview.

[^items-service]: ItemsService (business rules)
[^init-migration]: Baseline migration (the only place CHECK constraints exist)
[^main-ts]: Swagger 설정 및 전역 ValidationPipe
