---
okf_version: "0.2"
---

# Whale ERP API — Knowledge Bundle

Knowledge about the `whale-erp-api` service: what it is, and the conventions
that govern how code is written in it.

The repository is currently an unmodified NestJS 11 starter. This bundle is a
scaffold: the conventions are real and verified against config files, the
service concept is a stub that fills in as ERP domain code lands.

# Service

* [Whale ERP API](/api/whale-erp-api.md) - NestJS 11 HTTP service; currently a starter skeleton with no ERP domain code.

# Conventions

* [Testing conventions](/conventions/testing.md) - Two separate Jest configurations split unit tests from e2e tests by directory.
* [TypeScript and lint conventions](/conventions/typescript.md) - Deliberately loose compiler strictness and the ESLint/Prettier rules that back it.

# Not yet written

ERP domain concepts (orders, inventory, accounting) belong under a
`domain/` subdirectory once the corresponding modules exist. Attested
Computations (§10) are the right home for any financial figure the API
reports.
