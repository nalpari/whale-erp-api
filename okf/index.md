---
okf_version: "0.2"
---

# Whale ERP API — Knowledge Bundle

Knowledge about the `whale-erp-api` service: what it is, and the conventions
that govern how code is written in it.

The service runs on NestJS 11 over PostgreSQL via Prisma. The items module is
the worked example: copy its shape when adding a domain module.

# Service

* [Whale ERP API](/api/whale-erp-api.md) - NestJS 11 HTTP service backed by PostgreSQL through Prisma.
* [Items API](/api/items-api.md) - Item master and stock movements; the worked example for adding a domain module.
* [Authentication](/api/auth.md) - JWT bearer auth for the staff and customer clients; deny-by-default global guard.

# Design

* [Employment Contract Batch (Expiry & Reminder)](/api/employment-contract-batch.md) - Multi-instance-safe batch design for contract auto-expiry and expiry reminders via a PostgreSQL advisory lock; not yet implemented.

# Conventions

* [Testing conventions](/conventions/testing.md) - API code is written test-first; two separate Jest configurations split unit tests from e2e tests by directory.
* [TypeScript and lint conventions](/conventions/typescript.md) - Deliberately loose compiler strictness and the ESLint/Prettier rules that back it.
* [Naming conventions](/conventions/naming.md) - One Korean term maps to one English identifier across the three repositories; per-layer casing follows from that.

# Domain

* [Team 3 physical schema](/domain/team3-physical-schema.md) - The PostgreSQL schema for 3팀's 38 tables, generated from the logical ERD; what it depends on, what it adds, and what Prisma cannot carry.

# Not yet written

ERP domain concepts (orders, inventory, accounting) belong under a
`domain/` subdirectory once the corresponding modules exist. Attested
Computations (§10) are the right home for any financial figure the API
reports.
