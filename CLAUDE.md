# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

`whale-erp-api` is a NestJS 11 service backed by PostgreSQL through Prisma. The template's samples (`items` / `stock_movements`, the `staff` / `customers` login, `/items`) were removed on 2026-10-07, so **there is no worked example yet** — the first real domain module becomes it. Every route requires a JWT bearer token unless it carries `@Public()`; the only login so far is 직원 근무 앱's (see Authentication). The generated `AppController` still returns "Hello World!" at `/` and can be deleted once something real replaces it.

## Commands

Package manager is **pnpm** (a `pnpm-workspace.yaml` exists solely to allow the `unrs-resolver` build script — pnpm 11+ blocks build scripts by default; add new entries under `allowBuilds` if an install warns about an ignored one).

```bash
pnpm start:dev              # watch mode (port from PORT env, default 8000)
pnpm build                  # nest build → dist/ (deleteOutDir: true)
pnpm lint                   # eslint --fix over src, apps, libs, test, scripts
pnpm test                   # unit tests: *.spec.ts under src/
pnpm test:e2e               # e2e tests: *.e2e-spec.ts under test/ (separate jest config)
pnpm test enums.service     # one file, by path pattern
pnpm test enums.service -t "version"  # one case, by title (no `--`)
pnpm test:cov               # coverage
```

Do **not** write `pnpm test -- -t "name"`. pnpm forwards the `--`, so jest reads
`-t` as a path pattern rather than a flag and matches nothing. Pass jest flags
directly, without `--`.

Note `pnpm lint` writes fixes (`--fix`), so run it before inspecting a diff, not after.

The e2e suites hit a real database and need `DATABASE_URL` and `JWT_SECRET`. Point them at a throwaway PostgreSQL with the migrations applied (`DATABASE_URL=<throwaway> corepack pnpm exec prisma migrate deploy` — not `pnpm db:deploy`, which always loads `.env.local` and so targets the shared database), never the shared one — each suite creates and deletes only its own rows, but a crashed run leaves them behind. Concurrency, row locks and session revocation are only proven there; mocks cannot.

`ConfigModule` loads `.env.<APP_ENV>`, defaulting to `.env.local` when `APP_ENV` is unset — `APP_ENV=dev pnpm start` reads `.env.dev`. `APP_ENV` must come from the real environment, never from the file itself. Value files are gitignored; `.env.example` lists the keys.

## Database

PostgreSQL, accessed with Prisma 7. Two things about this setup are not guessable:

- **Prisma 7 moved the connection URL out of `schema.prisma`.** It lives in `prisma.config.ts` for the CLI, and the runtime client gets it through a driver adapter (`PrismaPg`) in `src/prisma/prisma.service.ts`. A `url = env(...)` line in the datasource block is a validation error, not a fallback.
- **The Prisma CLI reads `.env`, not `.env.local`.** The `db:*` scripts wrap it in `dotenv-cli` to load the profile file. Run migrations through those scripts, never bare `prisma` — the one exception is the throwaway e2e database (see Commands), where the URL is passed explicitly precisely because `db:deploy` would load `.env.local` and hit the shared database.

```bash
pnpm db:pull       # introspect the live DB into schema.prisma
pnpm db:deploy     # apply pending migrations (dev/prod) — the only way migrations are applied to a real environment
pnpm db:generate   # regenerate the client after schema edits
```

**Do not run `pnpm db:migrate` (`prisma migrate dev`).** Some constraints exist only in the migration SQL — the 3팀 foreign keys into 1팀 tables, CHECKs, some partial and `NULLS NOT DISTINCT` uniques — so Prisma's diff against `schema.prisma` produces a migration that drops them. The script is still in `package.json`; it is not used.

**Migrations are SQL files in `prisma/migrations/`, applied only with `pnpm db:deploy`.** The 3팀 DDL migration (`20261007000000_team3_initial`) is written by the physical generator (`docs/erd-physical/_build_physical.py`) with the same body as `docs/raw/2026-10-06-3팀-schema.sql`. Reference-data migrations are hand-written and end with a `DO` block that checks the row counts, so a truncated or edited file fails at deploy. **A migration that has been applied is never edited** — Prisma's checksum would no longer match; the change goes into a new migration. `_model.MIGRATION_APPLIED = True` makes the generator refuse to rewrite the applied DDL file.

### Migration rules (3팀 채널 합의, 2026-10-08)

1. **공용 개발 DB(`whale-erp`)에는 main 에 병합된 마이그레이션만 올린다.** PR 이 main 에 들어간 뒤 `pnpm db:deploy` 하고, 3팀 채널에 이름과 커밋을 남긴다. 브랜치 작업 중 DB 가 필요하면 로컬 DB 나 일회용 컨테이너를 쓴다. 적용되기 전에는 폴더 이름을 바꿔도 되지만, 공용 DB 에 먼저 올리면 그 이름이 굳는다.
2. **새 마이그레이션 폴더 이름은 한국 시각 14자리다** — `TZ=Asia/Seoul date +%Y%m%d%H%M%S` + `_team3_설명`(1팀은 `_team1_`). Prisma 기본은 UTC 지만, 기존 이름(`20261008000800_…` 같은 날짜 + 순번)이 한국 날짜라 UTC 로 만들면 오전에 만든 것이 전날로 찍힌다. 기존 순번 이름은 적용된 것이라 바꾸지 않는다.
3. **머지 직전에 origin/main 을 받아** 내 마이그레이션이 main 의 마지막 것보다 뒤에 정렬되는지 본다. 아니면 폴더 이름을 지금 시각으로 바꾼다. `migrate deploy` 는 이름 순서가 뒤집혀도 오류 없이 적용하므로, 같은 테이블을 건드리는 두 마이그레이션의 순서는 이 확인만이 지킨다.
4. **`.githooks/pre-push` 가 검사한다** — main 에 있는 마이그레이션을 고치거나 지웠는지, 새 이름이 main 마지막 것보다 뒤인지, 앞 14자리가 겹치는지. `--no-verify` 로 건너뛸 수 있으니 3번 확인을 대신하지 않는다.
5. **`schema.prisma` 충돌은 손으로 합치지 않는다.** 「3팀 1차 물리 모델」 표시 줄 아래는 `docs/erd-physical/_build_prisma.py` 가 통째로 다시 쓰므로, `_model.py` 충돌만 손으로 합치고 `_build_physical.py` → `_build_prisma.py` 를 다시 돌린다. 표시 줄 위의 1팀 모델은 생성기가 없어 손으로 합친다.

**시드 스크립트는 없다.** 1팀 초기 데이터는 전부 마이그레이션 INSERT 다 — 기준 데이터 245행은 `20261006000100_team1_initial_data`, 공식 휴일 1346행은 `20261006000200_team1_public_holidays`. 명세의 공통코드 13그룹 중 `MAIL_TYPE` 은 넣지 않았다 — 메일 유형은 메일 템플릿에서 관리한다. 그래서 공통코드는 그룹 12 · 상세 52 다. `_prisma_migrations` 가 한 번만 실행되는 것을 보장하므로 멱등 로직이 없고, 「스키마 적용」이 「앱이 뜰 수 있다」와 같아진다. 설치는 `pnpm db:deploy` 하나로 끝나고 환경변수도 필요 없다.

공휴일 SQL 은 손으로 쓴 것이 아니라 계산 결과이고, **계산기는 저장소에 없다** — 일회용이었고 지금 그 규칙을 호출할 곳이 없어 남기지 않았다. 그래서 그 마이그레이션 머리말에 **규칙 전체를 적어 뒀다**(양력 10종의 적용 연도, 음력 3종과 2050년 상한, 대체공휴일의 단계별 적용 연도와 '다음 평일' 탐색 규칙). 다시 만들어야 하면 그 주석이 명세다. 적용된 마이그레이션은 되돌지 않으므로 규칙이 바뀌면 그 파일을 고치지 말고 새 마이그레이션을 쓴다.

플랫폼 휴일 관리(공공 API 동기화)를 만들 때 같은 계산이 필요해진다 — 2051~2100 음력분을 채우고 API 값을 규칙값과 대조해야 한다. 그때 음력 변환 의존성(`korean-lunar-calendar` 등)과 함께 다시 들인다.

**플랫폼 마스터(`whaleadmin`)는 쓸 수 있는 비밀번호 없이 들어간다.** `password_hash` 가 NOT NULL 이라 `'!'` 를 넣는데, `verifyPassword` 가 scheme 를 먼저 보므로 어떤 입력과도 맞지 않는다(`/etc/shadow` 관례). 첫 로그인은 임시 비밀번호 발급으로 하고, 받는 곳은 `rjy1537@interplug.co.kr` 다 — **이 계정의 보안은 그 수신함의 보안과 같다.** 마이그레이션에 비밀은 없다.

그래서 **지금은 아무도 로그인할 수 없다.** 1팀 인증(로그인·계정 찾기·임시 비밀번호 발급)과 메일 발송이 구현 전이라 의도한 상태다. 로컬에서 비밀번호가 필요하면 마이그레이션 주석의 한 줄로 해시를 만들어 `UPDATE` 하고, 그 값은 커밋하지 않는다.

**`schema.prisma` holds 1팀's 27 models and 3팀's 41**, and both have migrations: 1팀 `20261006000000_team1_initial` (+ reference data and public holidays), 3팀 `20261007000000_team3_initial` (DDL) and `20261007000100_team3_initial_data` (공통코드 5그룹 43, 급여 항목 29). All five are applied to the shared development database (2026-10-07). The remaining `prisma migrate diff` against that database is the 29 deliberately SQL-only items. See @okf/domain/team1-physical-schema.md and @okf/domain/team3-physical-schema.md.

**CHECK constraints do not survive `db:pull`.** Prisma's schema language cannot express them, so `accounts_phone_format`, `accounts_email_lower`, `notification_templates_template_code_format`, and the rest of 3팀's CHECKs exist only in `prisma/migrations/20261007000000_team3_initial/migration.sql` — as 1팀's do in `20261006000000_team1_initial`. Introspection silently drops them from `schema.prisma` — never treat that file as the whole truth, and add new CHECKs in migration SQL (for 3팀, through the physical model).

`id` columns are `integer GENERATED ALWAYS AS IDENTITY`. Two consequences: never accept `id` in a create DTO (Postgres rejects the insert), and reject an id above `2147483647` before it reaches the database — a route parameter is a string, and an out-of-range value makes Postgres raise, turning a 404 into a 500. Parse the route parameter, and answer 404 for anything outside `1..2147483647` before querying.

The columns were `bigint` until the ids were narrowed; `BigInt` no longer appears anywhere, and it should stay that way — `JSON.stringify` throws on `BigInt`, so a bigint column would force a string id in every response.

`prisma.config.ts` is excluded in `tsconfig.build.json`; without that, `nest build` widens its root and emits `dist/src/main.js`, breaking `pnpm start:prod`.

### Keeping the generated client in sync

The Prisma client is generated into `node_modules` and goes stale whenever `prisma/schema.prisma` changes. Two mechanisms cover that, because neither is enough alone:

- `postinstall` runs `prisma generate` — but **pnpm skips it when dependencies are unchanged**. A pull that only changes the schema prints `Already up to date` and regenerates nothing, so this only covers fresh clones and CI.
- `.githooks/post-merge` and `.githooks/post-checkout` regenerate when `prisma/schema.prisma` appears in the diff, which is exactly the case pnpm skips.

Hooks live in the committed `.githooks/` directory and are wired up by `git config core.hooksPath .githooks`, run automatically by `postinstall` (`scripts/setup-hooks.mjs`, which swallows every error so a missing git never fails an install). A developer whose clone predates this needs `pnpm hooks:install` once — their `postinstall` will not fire on an up-to-date install.

If anything looks wrong after a pull, `pnpm db:generate` is always the manual fix.

## Authentication

JWT bearer tokens, no Passport. `JwtAuthGuard` is registered as an `APP_GUARD` in `src/auth/auth.module.ts`, so **a new controller is protected the moment it exists** — mark the exceptions with `@Public()`, narrow a route to one kind of token with `@UserTypes('admin')`, and read the caller with `@CurrentUser()`. An empty `@UserTypes()` denies everyone — a restriction-shaped decorator must not become a no-op when its argument is forgotten.

**직원 근무 앱 login exists; 관리자 웹 login does not.** 3팀 `accounts` routes are under `/auth/account` — `login`, `refresh`, `logout`, `password-reset-pins`, `password-reset-pins/verify`, `password-reset` (WHALEERP-161 – 171). 관리자 웹 login is 1팀's to build against `admin_accounts`; `UserType` is `'admin' | 'account'` and nothing issues `'admin'` yet. Three things are not guessable:

- **The guard checks the session on every request, not only the signature.** An `account` access token carries `sid`, and `JwtAuthGuard` asks `AuthSessionService.isActive` each time, so logout or a password reset cuts off a token that still has minutes left. That is one indexed read per request, accepted on purpose.
- **The refresh token is not rotated.** Policy is "last use + 30 days", one `auth_sessions` row per device. This deliberately differs from the removed sample, which rotated on every use — do not "fix" it.
- **Failure counters are counted under `SELECT … FOR UPDATE` on the account row** (login lock, PIN attempts, PIN issuance). Without the lock, parallel wrong attempts read the same count and the 5-try limit falls.

What stays from the frame:

- **`JWT_SECRET` has no default and is length-checked** (`src/auth/jwt-secret.ts`, 32 bytes minimum). A missing *or short* value throws while `AuthModule` is constructed. HS256 happily signs with a one-byte key, so without the check a single captured token is enough to brute-force the key and forge any identity. Do not add a fallback — a server that boots with a guessable signing key is worse than one that refuses to boot.
- **The guard accepts only `typ: 'access'` tokens**, so a refresh token cannot be replayed as a bearer token.
- **Rate limits** (`src/auth/throttle.ts`): `AuthModule` registers two axes, per-IP and per-normalized-email; a login controller opts in with `@UseGuards(ThrottlerGuard)`. One axis is not enough — an IP limit alone misses a botnet grinding one account, an account limit alone misses one host cycling emails to burn scrypt. Counting lives in process memory; a second instance doubles the effective limit.
- **Passwords** use `scrypt` from `node:crypto` (`src/auth/password.ts`), stored as `scrypt$<N>$<r>$<p>$<salt>$<key>` with the cost parameters in the value, so raising the cost later does not lock out existing accounts.

How the account login, lock, sessions and PIN reset work — and which of those rules 관리자 웹's login should keep — is in @okf/api/auth.md.

`scripts/` is excluded in `tsconfig.build.json` for the same reason `prisma.config.ts` is: leaving it in widens `nest build`'s root to `dist/src/` and breaks `pnpm start:prod`. It *is* inside the `pnpm lint` glob, though — a source directory left outside that glob gets no Prettier enforcement at all, which is how a formatting error sat in a committed file while `pnpm lint` exited 0.

The OpenAPI document declares the bearer requirement per controller (`@ApiBearerAuth()`), not globally. A global requirement would mark login and refresh as needing the token they exist to issue, and generated clients would then send `Authorization` on login.

## API docs (Swagger)

Swagger UI is at `/docs`, the raw OpenAPI document at `/docs-json`. Both are **disabled when `APP_ENV=prod`** — a full schema dump is a map of the attack surface. If production docs are ever needed, put authentication in front of them before removing the guard in `src/main.ts`.

Schemas are generated by the `@nestjs/swagger` CLI plugin (`nest-cli.json`), so `@ApiProperty` decorators are not needed. Two constraints come with that:

- The plugin only reads files ending in `.dto.ts` or `.entity.ts`. A response type declared anywhere else gets no schema.
- Response types must be **classes**, not interfaces. An interface is erased at compile time, leaving Swagger nothing to describe. `src/enums/dto/enum.response.dto.ts` is the pattern.

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

Worktrees live **outside** the repository, under a fixed per-platform root, in a directory named after the repository:

| Platform | Root |
|---|---|
| Windows | `C:\workspace\.whale-erp-worktrees\whale-erp-api\` |
| macOS / Linux | `~/.whale-erp-worktrees/whale-erp-api/` |

The repository level is not decoration. `whale-erp-staff` and `whale-erp-front` share this root and draw landmark names from the same pool, so without it the first `santorini` claims the name for all three. The directory name is the repository's own (`basename` of the toplevel), not a nickname. `git worktree add` creates that intermediate directory itself, so no `mkdir -p` is needed first (verified).

The worktree directory under it is a world landmark in lowercase — `santorini`, `machu-picchu`, `colosseum`. The branch created inside it is a Pokémon name in lowercase — `pikachu`, `snorlax`, `gengar`. Run `git worktree list` and `git branch --all` first and pick another of either if it is taken.

Neither name describes the work, which is the point: the pair is an address ("pikachu lives in santorini"), not a label. What the work *is* has to come from the PR title, the commit messages, and the issue — a branch called `snorlax` tells a reviewer nothing on its own.

**Branch from `main` unless told otherwise.** `git worktree add -b <branch>` with no start point branches from whatever HEAD happens to be, so a worktree created while sitting on a feature branch silently inherits that branch's commits. Name the start point explicitly. When the request specifies a different base, use that instead.

A fresh worktree is also missing everything git does not track, so copy the env files and install before running anything:

```bash
# macOS / Linux
W=~/.whale-erp-worktrees/whale-erp-api/santorini
git fetch origin                          # otherwise origin/main is whatever you last fetched
git worktree add "$W" -b pikachu origin/main --no-track
cp .env.local .env.dev .env.prod "$W"/    # gitignored, so the worktree has none
cd "$W" && pnpm install                   # node_modules is not shared between worktrees
```

```powershell
# Windows (PowerShell)
$W = "C:\workspace\.whale-erp-worktrees\whale-erp-api\santorini"
git fetch origin
git worktree add $W -b pikachu origin/main --no-track
Copy-Item .env.local, .env.dev, .env.prod $W
Set-Location $W; pnpm install
```

`--no-track` is not optional noise. Starting a branch from a remote-tracking ref makes git set its upstream to `origin/main`, and a later `git push` from that branch then refuses with advice about `push.default` instead of pushing the feature branch (verified). Branching from local `main` avoids that too, but local `main` is only as current as your last pull.

Without the copy the app starts against no configuration at all: `ConfigModule` silently ignores a missing env file, so `DATABASE_URL` is undefined and `pg` quietly falls back to a localhost default instead of failing loudly.

Only the three `.env.*` value files need copying. `.serena/project.local.yml` is local tool state and `coverage/` is build output — neither belongs in a worktree. Git hooks need no setup there: `core.hooksPath` is shared repo config and `.githooks/` is tracked, so both arrive with the checkout (verified). They are still worth running only after `pnpm install`, since regenerating the Prisma client into a missing `node_modules` accomplishes nothing.

**Do not create worktrees with `EnterWorktree({name})`.** It hardcodes creation to `.claude/worktrees/` inside the repo, which violates this convention and drops an untracked tree into a directory that *is* tracked (`.claude/` holds 43 committed skill files and `.claude/worktrees/` is not gitignored), so the worktree surfaces in `git status`. Create with `git worktree add` at the path above, then enter it with `EnterWorktree({path: "~/.whale-erp-worktrees/whale-erp-api/santorini"})` — that form is accepted because the path appears in `git worktree list`.

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
- Naming (DB·API·파일·용어 영문 식별자): @okf/conventions/naming.md
