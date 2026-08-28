# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

`whale-erp-api` is a NestJS 11 starter that still returns "Hello World!" from `src/app.{controller,service}.ts`. `ConfigModule` is wired for profile-based env loading; there is no ERP domain code, database layer, or authentication yet — when adding one, establish the pattern rather than looking for an existing one.

## Commands

Package manager is **pnpm** (a `pnpm-workspace.yaml` exists solely to allow the `unrs-resolver` build script — pnpm 11+ blocks build scripts by default; add new entries under `allowBuilds` if an install warns about an ignored one).

```bash
pnpm start:dev              # watch mode (port from PORT env, default 3000)
pnpm build                  # nest build → dist/ (deleteOutDir: true)
pnpm lint                   # eslint --fix over src, apps, libs, test
pnpm test                   # unit tests: *.spec.ts under src/
pnpm test:e2e               # e2e tests: *.e2e-spec.ts under test/ (separate jest config)
pnpm test -- app.controller # run a single unit test file by name pattern
pnpm test -- -t "should return"   # run a single test case by title
```

Note `pnpm lint` writes fixes (`--fix`), so run it before inspecting a diff, not after.

`ConfigModule` loads `.env.<APP_ENV>`, defaulting to `.env.local` when `APP_ENV` is unset — `APP_ENV=dev pnpm start` reads `.env.dev`. `APP_ENV` must come from the real environment, never from the file itself. Value files are gitignored; `.env.example` lists the keys.

## TDD for API code

API code is written test-first. "API code" means anything carrying behavior: controllers, services, guards, pipes, interceptors, and repository methods. Module wiring, DTO type declarations, and config need no test of their own.

1. **Red** — write the failing spec first, run it, and *read the failure*. Confirm it fails for the reason you intended, not from a typo or an unresolved import.
2. **Green** — the least code that passes. No speculative branches, no error handling for a case no test names.
3. **Refactor** — restructure with the test green, then run again before moving on.

```bash
pnpm test -- orders.service --watch   # tight loop on one subject
pnpm test                             # full unit suite before committing
```

**Verify the red step actually ran.** The unit jest config's `rootDir` is `src`, so a `*.spec.ts` written under `test/` is silently skipped by `pnpm test` — zero executed tests reports as a pass and reads like green. Check the file and test counts are non-zero. Specs live beside their subject: `src/orders/orders.service.spec.ts`.

Drive units with `Test.createTestingModule` and mocked dependencies; add an `*.e2e-spec.ts` under `test/` when the HTTP contract itself is under test (status codes, payload shape, auth). For how to write either, follow the `nestjs-best-practices` skill — this section governs the order, that skill governs the mechanics.

ERP business rules (amount calculation, stock movement, state transition) are where this pays off: write the edge cases — zero, negative, rounding, concurrent update — before the implementation invites you to forget them.

## Worktrees

Worktrees live **outside** the repository, under a fixed per-platform root:

| Platform | Root |
|---|---|
| Windows | `C:\workspace\.whale-erp-worktrees\` |
| macOS / Linux | `~/.whale-erp-worktrees/` |

The directory name is a Pokémon name in lowercase — `pikachu`, `snorlax`, `gengar`. Check `git worktree list` first and pick another if the name is taken. The Pokémon name identifies the worktree, not the work; branch names stay descriptive.

```bash
git worktree add ~/.whale-erp-worktrees/pikachu -b feat/order-api
```

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
