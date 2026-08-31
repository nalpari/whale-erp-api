# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

`whale-erp-api` is a NestJS 11 service backed by PostgreSQL through Prisma. The `items` / `stock_movements` pair plus the `/items` endpoints are the worked example to copy when adding domain modules. Every route requires a JWT bearer token unless it carries `@Public()`. The generated `AppController` still returns "Hello World!" at `/` and can be deleted once something real replaces it.

## Commands

Package manager is **pnpm** (a `pnpm-workspace.yaml` exists solely to allow the `unrs-resolver` build script — pnpm 11+ blocks build scripts by default; add new entries under `allowBuilds` if an install warns about an ignored one).

```bash
pnpm start:dev              # watch mode (port from PORT env, default 8000)
pnpm build                  # nest build → dist/ (deleteOutDir: true)
pnpm lint                   # eslint --fix over src, apps, libs, test, scripts
pnpm test                   # unit tests: *.spec.ts under src/
pnpm test:e2e               # e2e tests: *.e2e-spec.ts under test/ (separate jest config)
pnpm test items.service     # one file, by path pattern
pnpm test items.service -t "동시"  # one case, by title (no `--`)
pnpm test:cov               # coverage
pnpm user:create staff a@b.c 'pw' 이름   # 로그인 계정 생성/비밀번호 재설정
```

Do **not** write `pnpm test -- -t "name"`. pnpm forwards the `--`, so jest reads
`-t` as a path pattern rather than a flag and matches nothing. Pass jest flags
directly, without `--`.

Note `pnpm lint` writes fixes (`--fix`), so run it before inspecting a diff, not after.

`ConfigModule` loads `.env.<APP_ENV>`, defaulting to `.env.local` when `APP_ENV` is unset — `APP_ENV=dev pnpm start` reads `.env.dev`. `APP_ENV` must come from the real environment, never from the file itself. Value files are gitignored; `.env.example` lists the keys.

## Database

PostgreSQL, accessed with Prisma 7. Two things about this setup are not guessable:

- **Prisma 7 moved the connection URL out of `schema.prisma`.** It lives in `prisma.config.ts` for the CLI, and the runtime client gets it through a driver adapter (`PrismaPg`) in `src/prisma/prisma.service.ts`. A `url = env(...)` line in the datasource block is a validation error, not a fallback.
- **The Prisma CLI reads `.env`, not `.env.local`.** The `db:*` scripts wrap it in `dotenv-cli` to load the profile file. Run migrations through those scripts, never bare `prisma`.

```bash
pnpm db:pull       # introspect the live DB into schema.prisma
pnpm db:migrate    # create + apply a migration (dev)
pnpm db:deploy     # apply pending migrations (dev/prod)
pnpm db:generate   # regenerate the client after schema edits
```

**CHECK constraints do not survive `db:pull`.** Prisma's schema language cannot express them, so `items_sku_not_blank`, `items_name_not_blank`, `stock_movements_quantity_nonzero`, and `stock_movements_reason_not_blank` exist only in `prisma/migrations/0_init/migration.sql` — as do `staff_email_lower`, `staff_name_not_blank`, `customers_email_lower`, and `customers_name_not_blank` in the auth migration. Introspection silently drops them from `schema.prisma` — never treat that file as the whole truth, and add new CHECKs by hand-editing migration SQL.

`id` columns are `integer GENERATED ALWAYS AS IDENTITY`. Two consequences: never accept `id` in a create DTO (Postgres rejects the insert), and reject an id above `2147483647` before it reaches the database — a route parameter is a string, and an out-of-range value makes Postgres raise, turning a 404 into a 500. `ItemsService.toId` is the pattern.

The columns were `bigint` until the ids were narrowed; `BigInt` no longer appears anywhere, and it should stay that way — `JSON.stringify` throws on `BigInt`, so a bigint column would force a string id in every response.

`prisma.config.ts` is excluded in `tsconfig.build.json`; without that, `nest build` widens its root and emits `dist/src/main.js`, breaking `pnpm start:prod`.

### Keeping the generated client in sync

The Prisma client is generated into `node_modules` and goes stale whenever `prisma/schema.prisma` changes. Two mechanisms cover that, because neither is enough alone:

- `postinstall` runs `prisma generate` — but **pnpm skips it when dependencies are unchanged**. A pull that only changes the schema prints `Already up to date` and regenerates nothing, so this only covers fresh clones and CI.
- `.githooks/post-merge` and `.githooks/post-checkout` regenerate when `prisma/schema.prisma` appears in the diff, which is exactly the case pnpm skips.

Hooks live in the committed `.githooks/` directory and are wired up by `git config core.hooksPath .githooks`, run automatically by `postinstall` (`scripts/setup-hooks.mjs`, which swallows every error so a missing git never fails an install). A developer whose clone predates this needs `pnpm hooks:install` once — their `postinstall` will not fire on an up-to-date install.

If anything looks wrong after a pull, `pnpm db:generate` is always the manual fix.

## Authentication

JWT bearer tokens, no Passport. `JwtAuthGuard` is registered as an `APP_GUARD` in `src/auth/auth.module.ts`, so **a new controller is protected the moment it exists** — mark the exceptions with `@Public()`, narrow a route to one client with `@UserTypes('staff')` (as `ItemsController` does), and read the caller with `@CurrentUser()`. An empty `@UserTypes()` denies everyone — a restriction-shaped decorator must not become a no-op when its argument is forgotten.

Two identity tables, not one table with a role column: `staff` (whale-erp-staff) and `customers` (whale-erp-front), each with its own login route. There is no signup endpoint; accounts come from `pnpm user:create <staff|customer> <email> <password> <name>`, which upserts and so doubles as a password reset.

Four things here are not guessable:

- **`JWT_SECRET` has no default.** A missing value throws while `AuthModule` is constructed. Do not add a fallback — a server that boots with a guessable signing key is worse than one that refuses to boot.
- **Tokens carry a `typ` claim (`access` / `refresh`) and a random `jti`.** The `typ` claim is what stops the long-lived refresh token from being replayed as a bearer token. The `jti` is not decoration: without it two issues in the same second produce byte-identical tokens, and refresh rotation stops rotating.
- **The refresh token's sha256 lives on the user row**, so only the newest one works and logout can revoke it. A token that verifies but no longer matches the stored hash is a *replay*: clear the hash and kill the session rather than failing that one request, or whoever rotated first keeps the account. Rotation itself is one conditional `updateMany` (previous hash in the `where`) — read-then-write lets two concurrent refreshes both succeed and kills the loser's fresh token. The cost is one session per account; multiple devices need a `refresh_tokens` table.
- **Login runs the password comparison even when no row is found**, against a dummy hash. Returning the same message is not enough — skipping the ~30 ms derivation for unknown emails leaks registration status through response time.

Passwords use `scrypt` from `node:crypto` (`src/auth/password.ts`), stored as `scrypt$<N>$<r>$<p>$<salt>$<key>`. No bcrypt/argon2 dependency. The cost parameters are stored in the value and passed explicitly rather than left to Node's defaults — without them, raising the cost locks out every existing account, because nothing records which parameters produced a given key. Changing the format is a migration: existing hashes must be re-created with `pnpm user:create`.

`scripts/` is excluded in `tsconfig.build.json` for the same reason `prisma.config.ts` is: leaving it in widens `nest build`'s root to `dist/src/` and breaks `pnpm start:prod`. It *is* inside the `pnpm lint` glob, though — a source directory left outside that glob gets no Prettier enforcement at all, which is how a formatting error sat in a committed file while `pnpm lint` exited 0.

The OpenAPI document declares the bearer requirement per controller (`@ApiBearerAuth()`), not globally. A global requirement marks login and refresh as needing the token they exist to issue, and generated clients then send `Authorization` on login.

## API docs (Swagger)

Swagger UI is at `/docs`, the raw OpenAPI document at `/docs-json`. Both are **disabled when `APP_ENV=prod`** — a full schema dump is a map of the attack surface. If production docs are ever needed, put authentication in front of them before removing the guard in `src/main.ts`.

Schemas are generated by the `@nestjs/swagger` CLI plugin (`nest-cli.json`), so `@ApiProperty` decorators are not needed. Two constraints come with that:

- The plugin only reads files ending in `.dto.ts` or `.entity.ts`. A response type declared anywhere else gets no schema.
- Response types must be **classes**, not interfaces. An interface is erased at compile time, leaving Swagger nothing to describe. `src/items/dto/item.response.dto.ts` is the pattern.

`introspectComments` is on, so a JSDoc comment on a DTO property becomes its description in the UI. Validation decorators are read too — `@IsIn([...])` surfaces as an enum, and optionality follows `@IsOptional`.

The plugin runs only through `nest build` / `nest start`. Jest uses ts-jest and never applies it, which is fine because nothing under test reads the OpenAPI metadata.

## TDD for API code

API code is written test-first. "API code" means anything carrying behavior: controllers, services, guards, pipes, interceptors, and repository methods. Module wiring, DTO type declarations, and config need no test of their own.

1. **Red** — write the failing spec first, run it, and *read the failure*. Confirm it fails for the reason you intended, not from a typo or an unresolved import.
2. **Green** — the least code that passes. No speculative branches, no error handling for a case no test names.
3. **Refactor** — restructure with the test green, then run again before moving on.

```bash
pnpm test orders.service --watch   # tight loop on one subject
pnpm test                          # full unit suite before committing
```

**Verify the red step actually ran.** Two ways this repo reports "nothing ran" as success, both exiting 0:

- The unit jest config's `rootDir` is `src`, so a `*.spec.ts` under `test/` is never collected by `pnpm test`. Specs live beside their subject: `src/orders/orders.service.spec.ts`.
- A `-t` filter that matches no title prints `Tests: N skipped` and exits 0 — a typo in the title silently runs nothing.

Read the counts, not the exit code: a run that proves anything shows a non-zero *passed* or *failed* count.

Drive units with `Test.createTestingModule` and mocked dependencies; add an `*.e2e-spec.ts` under `test/` when the HTTP contract itself is under test (status codes, payload shape, auth). For how to write either, follow the `nestjs-best-practices` skill — this section governs the order, that skill governs the mechanics.

ERP business rules (amount calculation, stock movement, state transition) are where this pays off: write the edge cases — zero, negative, rounding, concurrent update — before the implementation invites you to forget them.

## Worktrees

Worktrees live **outside** the repository, under a fixed per-platform root:

| Platform | Root |
|---|---|
| Windows | `C:\workspace\.whale-erp-worktrees\` |
| macOS / Linux | `~/.whale-erp-worktrees/` |

The directory name is a Pokémon name in lowercase — `pikachu`, `snorlax`, `gengar`. Check `git worktree list` first and pick another if the name is taken. The Pokémon name identifies the worktree, not the work; branch names stay descriptive.

**Branch from `main` unless told otherwise.** `git worktree add -b <branch>` with no start point branches from whatever HEAD happens to be, so a worktree created while sitting on a feature branch silently inherits that branch's commits. Name the start point explicitly. When the request specifies a different base, use that instead.

A fresh worktree is also missing everything git does not track, so copy the env files and install before running anything:

```bash
# macOS / Linux
W=~/.whale-erp-worktrees/pikachu
git fetch origin                          # otherwise origin/main is whatever you last fetched
git worktree add "$W" -b feat/order-api origin/main --no-track
cp .env.local .env.dev .env.prod "$W"/    # gitignored, so the worktree has none
cd "$W" && pnpm install                   # node_modules is not shared between worktrees
```

```powershell
# Windows (PowerShell)
$W = "C:\workspace\.whale-erp-worktrees\pikachu"
git fetch origin
git worktree add $W -b feat/order-api origin/main --no-track
Copy-Item .env.local, .env.dev, .env.prod $W
Set-Location $W; pnpm install
```

`--no-track` is not optional noise. Starting a branch from a remote-tracking ref makes git set its upstream to `origin/main`, and a later `git push` from that branch then refuses with advice about `push.default` instead of pushing the feature branch (verified). Branching from local `main` avoids that too, but local `main` is only as current as your last pull.

Without the copy the app starts against no configuration at all: `ConfigModule` silently ignores a missing env file, so `DATABASE_URL` is undefined and `pg` quietly falls back to a localhost default instead of failing loudly.

Only the three `.env.*` value files need copying. `.serena/project.local.yml` is local tool state and `coverage/` is build output — neither belongs in a worktree. Git hooks need no setup there: `core.hooksPath` is shared repo config and `.githooks/` is tracked, so both arrive with the checkout (verified). They are still worth running only after `pnpm install`, since regenerating the Prisma client into a missing `node_modules` accomplishes nothing.

**Do not create worktrees with `EnterWorktree({name})`.** It hardcodes creation to `.claude/worktrees/` inside the repo, which violates this convention and drops an untracked tree into a directory that *is* tracked (`.claude/` holds 43 committed skill files and `.claude/worktrees/` is not gitignored), so the worktree surfaces in `git status`. Create with `git worktree add` at the path above, then enter it with `EnterWorktree({path: "~/.whale-erp-worktrees/pikachu"})` — that form is accepted because the path appears in `git worktree list`.

## Knowledge bundle

`okf/` is an [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle — plain markdown with YAML frontmatter, no tooling required. Start at `okf/index.md`. `type` is the only required frontmatter key, `index.md`/`log.md` are reserved filenames, and links between concepts are relative to the **bundle root**, not the repo root (`/conventions/testing.md` means `okf/conventions/testing.md`).

### Keeping it current

Each concept's `sources[].resource` names the real file it describes. When you change one of those files, update the concept in the same commit:

- Bump `generated.at` (ISO 8601, UTC) and set `generated.by` — `human:<id>` for hand edits, `<tool>/<version>` (e.g. `claude-code/opus-5`) for agent edits.
- Update the matching `sources[].last_modified`.
- Add a line to `okf/log.md` under a `## YYYY-MM-DD` heading, newest date first.
- Touch `okf/index.md` only when adding or removing a concept.
- A concept that no longer applies gets `status: deprecated` — do not delete it; links and history depend on it.

**Never update `verified` to reflect your own edit.** It records human or process confirmation and is deliberately separate from `generated`. Leaving it stale is the point: `verified.at < generated.at` is the signal that content changed without review. Add a `verified` entry only when a human actually confirmed the content.

Write concepts that explain consequences and traps, not ones that mirror config values — a doc restating `tsconfig.json` rots the moment it changes.

## Conventions

- Unit tests live beside their subject in `src/` as `*.spec.ts`; the root jest config's `rootDir` is `src`, so tests placed in `test/` are only picked up by `test:e2e`.
- TypeScript is intentionally loose: `noImplicitAny: false`, `strictBindCallApply: false`, only `strictNullChecks` is on. Don't tighten these as a side effect of another change.
- ESLint runs `recommendedTypeChecked` with `no-explicit-any` off and `no-floating-promises` / `no-unsafe-argument` downgraded to warnings (`eslint.config.mjs`). Prettier runs as a lint rule, so formatting failures surface as lint *errors*.
- Module resolution is `nodenext` with `isolatedModules`, so relative imports and type-only imports must be written accordingly.
