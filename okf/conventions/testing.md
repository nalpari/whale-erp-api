---
type: Reference
title: Testing conventions
description: API code is written test-first; two separate Jest configurations split unit tests from e2e tests by directory.
tags: [testing, jest, tdd, conventions]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-07T05:38:00Z }
sources:
  - id: jest-unit
    resource: ../../package.json
    title: Root Jest config (package.json "jest" key)
    last_modified: 2026-10-07T05:38:00Z
  - id: jest-e2e
    resource: ../../test/jest-e2e.json
    title: E2E Jest config
    last_modified: 2026-11-09T07:00:00Z
  - id: e2e-listen
    resource: ../../test/e2e-listen-loopback.ts
    title: E2E loopback listen setup
    last_modified: 2026-11-09T07:00:00Z
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

What belongs in e2e rather than beside the subject: anything whose correctness
lives in the wiring instead of in a class. `test/auth.e2e-spec.ts` is the worked
example — deleting the `APP_GUARD` registration leaves every unit test green
while the entire application becomes unauthenticated, and only the e2e run
notices.

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

E2E apps listen before the first request: `test/e2e-listen-loopback.ts`[^e2e-listen]
(`setupFilesAfterEnv`) binds each app to a random `127.0.0.1` port right after
`init`, and a spec's own `app.listen` reuses that server. Left to itself,
supertest opens and closes a port per request on `::` and sends to `127.0.0.1`,
so a local program already holding that port answers instead (stray 501 · 404 ·
`socket hang up`), and concurrent requests get `ECONNREFUSED` when the first one
closes the shared server.

# Examples

```bash
pnpm test                             # all unit tests
pnpm test app.controller              # single file, by path pattern
pnpm test enums.service -t "version"  # single case, by test title
pnpm test:cov                         # coverage → ../coverage relative to src/
pnpm test:e2e                         # e2e only
```

**Do not put `--` before a Jest flag.** pnpm forwards the separator, so
`pnpm test -- -t "name"` reaches Jest as a *path pattern* `-t`, which matches
no file: it prints `0 matches` and exits non-zero. Pass Jest flags directly.
This is the second way this repo reports "nothing ran" — the first is the
`rootDir` trap above, and that one exits **0**.

[^jest-unit]: Root Jest config (package.json "jest" key)
[^jest-e2e]: E2E Jest config
[^e2e-listen]: E2E loopback listen setup
