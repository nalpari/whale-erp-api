---
type: Service
title: Whale ERP API
description: NestJS 11 HTTP service; currently a starter skeleton with no ERP domain code.
tags: [nestjs, api, typescript]
status: stable
generated: { by: claude-code/opus-5, at: 2026-08-28T03:32:37Z }
sources:
  - id: package-json
    resource: ../../package.json
    title: package.json (scripts, dependency set)
    last_modified: 2026-08-28T02:30:00Z
  - id: main-ts
    resource: ../../src/main.ts
    title: Application entrypoint
    last_modified: 2026-08-28T01:50:00Z
  - id: app-module
    resource: ../../src/app.module.ts
    title: Root module (ConfigModule registration)
    last_modified: 2026-08-28T02:30:00Z
---

# Status

`AppModule` wires `ConfigModule` (profile env), `PrismaModule` (database), and
`ItemsModule` (the first domain module).[^app-module] The generated
`AppController` still answers `/` with `Hello World!` and can go once something
real replaces it. There is no authentication yet.

The worked domain example is the [Items API](/api/items-api.md).

Read [Items API](/api/items-api.md) for how a domain module is put together,
and CLAUDE.md for the Prisma 7 setup traps (config location, CHECK constraints,
bigint serialization).

# Runtime

The entrypoint creates the Nest application from `AppModule` and listens on
`process.env.PORT`, falling back to `8000`.[^main-ts]

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
| `pnpm lint` | ESLint over `src`, `apps`, `libs`, `test` — **writes fixes** (`--fix`). |

A `pnpm-workspace.yaml` exists solely to allow the `unrs-resolver` build
script; pnpm 11+ blocks build scripts unless listed under `allowBuilds`.

Testing is covered separately in [testing conventions](/conventions/testing.md);
compiler and lint settings in [TypeScript and lint conventions](/conventions/typescript.md).

[^package-json]: package.json (scripts, dependency set)
[^app-module]: Root module (ConfigModule registration)
[^main-ts]: Application entrypoint
