---
type: Service
title: Whale ERP API
description: NestJS 11 HTTP service; currently a starter skeleton with no ERP domain code.
tags: [nestjs, api, typescript]
status: draft
generated: { by: claude-code/opus-5, at: 2026-08-28T02:33:33Z }
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

`AppController` still returns the string `Hello World!` from `AppService`.
Beyond the generated starter, only configuration is wired: `AppModule`
registers `ConfigModule` globally.[^app-module] There is no database layer,
authentication, or ERP domain code.

Treat this concept as `draft` until real modules exist. A reader looking for
"how does this service work" currently has no answer beyond the skeleton.

# Runtime

The entrypoint creates the Nest application from `AppModule` and listens on
`process.env.PORT`, falling back to `3000`.[^main-ts]

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
