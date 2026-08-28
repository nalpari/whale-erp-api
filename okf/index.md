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

# Conventions

* [Testing conventions](/conventions/testing.md) - API code is written test-first; two separate Jest configurations split unit tests from e2e tests by directory.
* [TypeScript and lint conventions](/conventions/typescript.md) - Deliberately loose compiler strictness and the ESLint/Prettier rules that back it.

# Not yet written

ERP domain concepts (orders, inventory, accounting) belong under a
`domain/` subdirectory once the corresponding modules exist. Attested
Computations (§10) are the right home for any financial figure the API
reports.
