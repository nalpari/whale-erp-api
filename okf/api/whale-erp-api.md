---
type: Service
title: Whale ERP API
description: NestJS 11 HTTP service; currently a starter skeleton with no ERP domain code.
tags: [nestjs, api, typescript]
status: draft
generated: { by: claude-code/opus-5, at: 2026-08-28T02:01:15Z }
sources:
  - id: package-json
    resource: ../../package.json
    title: package.json (scripts, dependency set)
    last_modified: 2026-08-28T01:50:00Z
  - id: main-ts
    resource: ../../src/main.ts
    title: Application entrypoint
    last_modified: 2026-08-28T01:50:00Z
---

# Status

The repository contains only the generated NestJS starter: `AppController`
returns the string `Hello World!` from `AppService`. There is no database
layer, configuration module, authentication, or ERP domain code.[^main-ts]

Treat this concept as `draft` until real modules exist. A reader looking for
"how does this service work" currently has no answer beyond the skeleton.

# Runtime

The entrypoint creates the Nest application from `AppModule` and listens on
`process.env.PORT`, falling back to `3000`.[^main-ts]

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
[^main-ts]: Application entrypoint
