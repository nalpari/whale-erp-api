---
type: Reference
title: Testing conventions
description: API code is written test-first; two separate Jest configurations split unit tests from e2e tests by directory.
tags: [testing, jest, tdd, conventions]
status: stable
generated: { by: claude-code/opus-5, at: 2026-08-31T01:23:01Z }
sources:
  - id: jest-unit
    resource: ../../package.json
    title: Root Jest config (package.json "jest" key)
    last_modified: 2026-08-31T01:23:01Z
  - id: jest-e2e
    resource: ../../test/jest-e2e.json
    title: E2E Jest config
    last_modified: 2026-08-28T01:50:00Z
---

# Policy

API code — controllers, services, guards, pipes, interceptors, repository
methods — is written **test-first**: failing spec, minimum code to pass,
then refactor. The full directive lives in [CLAUDE.md](../../CLAUDE.md);
the mechanics of writing NestJS tests come from the
`nestjs-best-practices` skill. This concept covers only how the test
runners are wired.

The `rootDir` trap below is what most often breaks the red step: a spec
that never runs reports as a pass.

# The two configs

Unit and e2e tests do not share a configuration, and the split is by
**directory**, not by filename alone.

| | Unit | E2E |
|---|---|---|
| Config | `package.json` `"jest"` key[^jest-unit] | `test/jest-e2e.json`[^jest-e2e] |
| `rootDir` | `src` | `.` (repo root) |
| `testRegex` | `.*\.spec\.ts$` | `.e2e-spec.ts$` |
| Command | `pnpm test` | `pnpm test:e2e` |

The consequence that catches people: because the unit config's `rootDir` is
`src`, a `*.spec.ts` file placed in `test/` is **silently never run** by
`pnpm test`. Unit tests live beside their subject inside `src/`.

# Examples

```bash
pnpm test                         # all unit tests
pnpm test -- app.controller       # single file, by path pattern
pnpm test -- -t "should return"   # single case, by test title
pnpm test:cov                     # coverage → ../coverage relative to src/
pnpm test:e2e                     # e2e only
```

[^jest-unit]: Root Jest config (package.json "jest" key)
[^jest-e2e]: E2E Jest config
