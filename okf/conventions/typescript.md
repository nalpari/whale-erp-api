---
type: Reference
title: TypeScript and lint conventions
description: Deliberately loose compiler strictness and the ESLint/Prettier rules that back it.
tags: [typescript, eslint, prettier, conventions]
status: stable
generated: { by: claude-code/opus-5, at: 2026-08-28T02:01:15Z }
sources:
  - id: tsconfig
    resource: ../../tsconfig.json
    title: TypeScript compiler options
    last_modified: 2026-08-28T01:50:00Z
  - id: eslint-config
    resource: ../../eslint.config.mjs
    title: ESLint flat config
    last_modified: 2026-08-28T01:50:00Z
  - id: prettierrc
    resource: ../../.prettierrc
    title: Prettier config
    last_modified: 2026-08-28T01:50:00Z
---

# Compiler strictness

Strictness is **intentionally partial**, not an oversight.[^tsconfig] Only
`strictNullChecks` is on; several checks are explicitly disabled:

| Option | Value |
|--------|-------|
| `strictNullChecks` | `true` |
| `noImplicitAny` | `false` |
| `strictBindCallApply` | `false` |
| `noFallthroughCasesInSwitch` | `false` |

Do not tighten these as a side effect of an unrelated change — that turns a
small diff into a repo-wide error cascade.

Other settings that constrain how code is written: `module` and
`moduleResolution` are `nodenext` with `isolatedModules: true`, so import
form matters (type-only imports must be written as such). Decorator support
(`experimentalDecorators`, `emitDecoratorMetadata`) is on, as NestJS
requires. Target is `ES2023`.

# Lint

ESLint runs `typescript-eslint`'s `recommendedTypeChecked` with three
deliberate relaxations.[^eslint-config]

| Rule | Level |
|------|-------|
| `@typescript-eslint/no-explicit-any` | off |
| `@typescript-eslint/no-floating-promises` | warn |
| `@typescript-eslint/no-unsafe-argument` | warn |
| `prettier/prettier` | **error** |

Prettier runs *as a lint rule*, so a formatting deviation fails lint as an
error while an unawaited promise only warns. Prettier itself is configured
with `singleQuote: true` and `trailingComma: "all"`.[^prettierrc]

Note that `pnpm lint` passes `--fix`, so it rewrites files. Run it before
inspecting a diff, not after.

[^tsconfig]: TypeScript compiler options
[^eslint-config]: ESLint flat config
[^prettierrc]: Prettier config
