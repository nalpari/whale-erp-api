---
type: Service
title: Whale ERP API
description: NestJS 11 HTTP service over PostgreSQL via Prisma; every route needs a bearer token.
tags: [nestjs, api, typescript]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-13T02:30:00Z }
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
    last_modified: 2026-10-12T02:21:57Z
  - id: code-groups-controller
    resource: ../../src/code-groups/code-groups.controller.ts
    title: 플랫폼 공통코드 관리 routes (/code-groups)
    last_modified: 2026-10-12T08:26:11Z
  - id: code-groups-service
    resource: ../../src/code-groups/code-groups.service.ts
    title: 플랫폼 공통코드 관리 rules (PM · PA check, panel save, BP application)
    last_modified: 2026-10-12T08:26:11Z
  - id: leads-service
    resource: ../../src/leads/leads.service.ts
    title: 도입문의 접수 · 파기 (POST /leads, lead-purge)
    last_modified: 2026-10-13T02:30:00Z
---

# Status

`AppModule` wires `ConfigModule` (profile env), `ScheduleModule` (cron),
`PrismaModule` (database), `AuthModule` (JWT guard — no login route yet), and
`EnumsModule` (`GET /enums`, the enum values and Korean labels
front and staff fetch — see [Naming conventions](/conventions/naming.md)).[^app-module]
`CodeGroupsModule` (`/code-groups` — 플랫폼 공통코드 관리 S-UQPNIH) lists and saves
the 플랫폼고정 · 플랫폼제공 groups and their platform-original (`BP000000`) items, and
copies a 플랫폼제공 group to every active customer BP (`POST /code-groups/{groupCode}/bp-application`).
Each BP gets only the rows it does not have yet — rows a BP edited, deleted, or added as BP전용 are
never overwritten or revived. The target BPs are re-read on every application, so re-applying gives
existing BPs the items created since and a BP that became active in between every item; edits to
the original never reach rows a BP already has. Applying cannot be undone, so a group with no items,
or no active customer BP, is refused with 409 instead of being marked applied.[^code-groups-service]
It is `@UserTypes('admin')`, and the service additionally requires an undeleted, `ACTIVE` admin
account of role type PM · PA — the guard never reads admin rows, so this is where a withdrawn or
deleted admin is stopped. Creating a code that another admin inserted between the check and the
write is a 409, not a 500. Nothing can call it until 1팀's 관리자 웹 login issues admin tokens.
`LeadsModule` (`POST /leads` — 홈 도입문의 S-SDMDKC, Plane #295) is `@Public()` and takes two limits:
the same IP gets 5 per hour (`ThrottlerGuard`, counted before validation, so a rejected form counts too),
and the same phone or email is refused with 429 for 10 minutes — that one is a DB lookup, not a lock, so
two simultaneous submissions can both land. 업종 · 도입 예정 시기 must be active platform 공통코드
(`INDUSTRY` · `PLAN_PERIOD`). The nightly `lead-purge` job `DELETE`s rows whose 상담 완료일 is more than a year
past in Korea time (CNT-12); a lead never marked consulted is never purged. The receipt mail and operator
notification the mockup shows are not sent yet.[^leads-service]
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

`ContractsModule` (`/contracts` — list, 근로계약서 초안 저장, 임시저장 이어 쓰기 · 삭제, and the
nightly contract expiry job) and `StoresModule` (`GET /stores`, a read-only 근무지 lookup over
1팀's table) are in `AppModule` — see [Contracts API](/api/contracts-api.md) and
[Employment Contract Batch](/api/employment-contract-batch.md).
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
[^code-groups-service]: 플랫폼 공통코드 관리 rules (PM · PA check, panel save, BP application)
[^leads-service]: 도입문의 접수 · 파기 (POST /leads, lead-purge)
