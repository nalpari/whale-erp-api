---
type: API Endpoint
title: Items API
description: Item master and stock movements; the worked example for adding a domain module.
tags: [api, items, inventory, prisma]
status: stable
generated: { by: claude-code/opus-5, at: 2026-08-28T03:45:44Z }
sources:
  - id: items-service
    resource: ../../src/items/items.service.ts
    title: ItemsService (business rules)
    last_modified: 2026-08-28T03:30:00Z
  - id: main-ts
    resource: ../../src/main.ts
    title: Swagger 설정 및 전역 ValidationPipe
    last_modified: 2026-08-28T03:44:00Z
  - id: init-migration
    resource: ../../prisma/migrations/0_init/migration.sql
    title: Baseline migration (the only place CHECK constraints exist)
    last_modified: 2026-08-28T03:25:00Z
---

# Endpoints

Browsable at `/docs` (Swagger UI) outside production; the raw document is at
`/docs-json`.[^main-ts]


| Method | Path | Notes |
|---|---|---|
| `GET` | `/items` | Every item with its derived stock. |
| `GET` | `/items/:id` | 404 when absent, including a non-numeric id. |
| `POST` | `/items` | 409 on duplicate `sku`. |
| `POST` | `/items/:id/stock-movements` | Positive quantity receives, negative issues. |

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
