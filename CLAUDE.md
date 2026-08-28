# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

`whale-erp-api` is currently an unmodified NestJS 11 starter (`src/app.{module,controller,service}.ts` still return "Hello World!"). There is no ERP domain code, database layer, or config module yet — when adding one, establish the pattern rather than looking for an existing one.

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
