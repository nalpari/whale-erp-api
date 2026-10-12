---
type: Service
title: Whale ERP API
description: NestJS 11 HTTP service over PostgreSQL via Prisma; every route needs a bearer token.
tags: [nestjs, api, typescript]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-12T06:00:00Z }
sources:
  - id: package-json
    resource: ../../package.json
    title: package.json (scripts, dependency set)
    last_modified: 2026-10-07T05:38:00Z
  - id: main-ts
    resource: ../../src/main.ts
    title: Application entrypoint
    last_modified: 2026-10-06T09:07:33Z
  - id: app-module
    resource: ../../src/app.module.ts
    title: Root module (ConfigModule registration)
    last_modified: 2026-10-07T05:38:00Z
---

# Status

`AppModule` wires `ConfigModule` (profile env), `ScheduleModule` (cron),
`PrismaModule` (database), `AuthModule` (JWT guard — no login route yet), and
`EnumsModule` (`GET /enums`, the enum values and Korean labels
front and staff fetch — see [Naming conventions](/conventions/naming.md)).[^app-module]
`EnumsModule` is `@Public()` on purpose: the 비로그인 홈 renders choices from it
too.

**The DB enums' Korean labels live in the database**, as each enum type's
description: `COMMENT ON TYPE "use_status" IS '사용 · 사용중지'`, one label per
value in value order (재영, 2026-10-12, agreed with 1팀). This is the single source
for both teams; before it, 3팀's labels came from `_model.py` and 1팀's existed only
as SQL comments, so 1팀's enums were missing from `GET /enums`.
`pnpm enums:generate` (`scripts/build-enum-labels.mjs`) applies every migration in
`prisma/migrations/` to an empty PGlite — never the shared database, which can hold
migrations the repository lacks — and writes `src/enums/db-enums.generated.ts`. It
stops on an enum with no description or a label count that differs from the value
count. Two consequences:

- **A migration that creates an enum, or adds a value to one, writes
  `COMMENT ON TYPE` in the same file** — with the full label list, since the
  description is replaced, not appended. (`ALTER TYPE … ADD VALUE` cannot use the new
  value in its transaction, but a comment does not use it.) 3팀's
  `_build_physical.py` emits the line into `schema.sql` from `_model.py`; 1팀 writes it
  by hand.
- **Forgetting to regenerate fails `pnpm test`.** `db-enums.generated.spec.ts`
  compares the generated file with every `enum` in `schema.prisma` by DB name
  (`@@map`), values and order.

`ScheduleModule` has no jobs yet: the contract expiry batch lives in
`ContractsModule`, which stays out of `AppModule` until the contracts migration
exists — see [Employment Contract Batch](/api/employment-contract-batch.md).
The generated `AppController` still answers `/` with `Hello World!` and can go
once something real replaces it — it only still answers because it carries
`@Public()`.

`AuthModule` registers a global guard, so **every route requires a bearer
token** unless marked `@Public()`: see [Authentication](/api/auth.md) before
adding a controller. There is no login yet, so no token can be issued: the
template's samples (items, stock movements, staff/customer login) were removed
on 2026-10-07, and the 1팀 and 3팀 logins replace them. No module is the worked
example until the first real domain module lands.

Read CLAUDE.md for the Prisma 7 setup traps (config location, CHECK constraints,
id 범위 처리), and [Team 3 physical schema](/domain/team3-physical-schema.md)
before writing a migration.

# Runtime

The entrypoint creates the Nest application from `AppModule` and listens on
`process.env.PORT`, falling back to `8000`.[^main-ts] Outside production it serves
Swagger at `/docs`; the document is built by `src/openapi/document.ts`, the one
function `pnpm openapi:export` also calls, so the committed `openapi/openapi.json`
matches what the server shows.

# Configuration profiles

`ConfigModule` loads `.env.<APP_ENV>` and defaults to `.env.local` when
`APP_ENV` is unset.[^app-module] `APP_ENV` must come from the real
environment, not from the env file: the value selecting which file to read
cannot itself live in that file.

`NODE_ENV` is kept to the values Node and its libraries expect
(`development` / `production`); `APP_ENV` carries the `local` / `dev` /
`prod` profile separately, so setting a profile never silently changes
library behaviour keyed on `NODE_ENV`.

Value files are gitignored; `.env.example` is the committed key list.

# Build and run

Commands are defined as npm scripts and run through **pnpm**.[^package-json]

| Command | Effect |
|---------|--------|
| `pnpm start:dev` | Watch-mode development server. |
| `pnpm build` | Compiles to `dist/`; `nest-cli.json` sets `deleteOutDir: true`. |
| `pnpm start:prod` | Runs `node dist/main`. |
| `pnpm lint` | ESLint over `src`, `apps`, `libs`, `test`, `scripts` — **writes fixes** (`--fix`). |
| `pnpm openapi:export` | Builds, then writes `openapi/openapi.json` without opening a port or touching the database (needs `JWT_SECRET`). Run it after changing any DTO or route — front and staff generate types from the committed file. |

A `pnpm-workspace.yaml` exists solely to allow the `unrs-resolver` build
script; pnpm 11+ blocks build scripts unless listed under `allowBuilds`.

Testing is covered separately in [testing conventions](/conventions/testing.md);
compiler and lint settings in [TypeScript and lint conventions](/conventions/typescript.md).

[^package-json]: package.json (scripts, dependency set)
[^app-module]: Root module (ConfigModule registration)
[^main-ts]: Application entrypoint
