---
type: Service
title: Whale ERP API
description: NestJS 11 HTTP service over PostgreSQL via Prisma; items is the worked domain module and every route needs a bearer token.
tags: [nestjs, api, typescript]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-06T09:07:33Z }
sources:
  - id: package-json
    resource: ../../package.json
    title: package.json (scripts, dependency set)
    last_modified: 2026-10-06T09:07:33Z
  - id: main-ts
    resource: ../../src/main.ts
    title: Application entrypoint
    last_modified: 2026-10-06T09:07:33Z
  - id: app-module
    resource: ../../src/app.module.ts
    title: Root module (ConfigModule registration)
    last_modified: 2026-10-06T09:07:33Z
---

# Status

`AppModule` wires `ConfigModule` (profile env), `ScheduleModule` (cron),
`PrismaModule` (database), `AuthModule` (JWT), `ItemsModule` (the first domain
module), and `EnumsModule` (`GET /enums`, the enum values and Korean labels
front and staff fetch — see [Naming conventions](/conventions/naming.md)).[^app-module]
`EnumsModule` is `@Public()` on purpose: the 비로그인 홈 renders choices from it
too. `ScheduleModule` has no jobs yet: the contract expiry batch lives in
`ContractsModule`, which stays out of `AppModule` until the contracts migration
exists — see [Employment Contract Batch](/api/employment-contract-batch.md).
The generated `AppController` still answers `/` with `Hello World!` and can go
once something real replaces it — it only still answers because it carries
`@Public()`.

`AuthModule` registers a global guard, so **every route requires a bearer
token** unless marked `@Public()`: see [Authentication](/api/auth.md) before
adding a controller. The worked domain example is the
[Items API](/api/items-api.md).

Read [Items API](/api/items-api.md) for how a domain module is put together,
and CLAUDE.md for the Prisma 7 setup traps (config location, CHECK constraints,
id 범위 처리).

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
| `pnpm user:create` | Creates or resets a login account; see [Authentication](/api/auth.md). |

A `pnpm-workspace.yaml` exists solely to allow the `unrs-resolver` build
script; pnpm 11+ blocks build scripts unless listed under `allowBuilds`.

Testing is covered separately in [testing conventions](/conventions/testing.md);
compiler and lint settings in [TypeScript and lint conventions](/conventions/typescript.md).

[^package-json]: package.json (scripts, dependency set)
[^app-module]: Root module (ConfigModule registration)
[^main-ts]: Application entrypoint
