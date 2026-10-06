---
type: Reference
title: Team 3 physical schema
description: The PostgreSQL schema for 3팀's 38 tables, generated from the logical ERD; what it depends on, what it adds, and what Prisma cannot carry.
tags: [database, schema, erd, postgresql, prisma]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-06T05:14:18Z }
sources:
  - id: physical-erd
    resource: ../../docs/raw/2026-10-06-3팀-물리-ERD.md
    title: 3팀 물리 ERD 테이블 정의서
    last_modified: 2026-10-06T00:00:00Z
  - id: physical-sql
    resource: ../../docs/raw/2026-10-06-3팀-schema.sql
    title: 3팀 물리 스키마 DDL
    last_modified: 2026-10-06T00:00:00Z
  - id: physical-model
    resource: ../../docs/erd-physical/_model.py
    title: 물리 결정 (이름 변경 · 나눔 · 추가 · 뺌 · 제약)
    last_modified: 2026-10-06T00:00:00Z
---

# Status

A design document, not yet code. The schema exists as DDL and as a browsable ERD
(`/erd/physical/` on 미니); no migration or `schema.prisma` has been written from
it. 재영 reviews the screens first, and Prisma conversion is a separate step that
has not been ordered.[^physical-erd]

# Where it comes from

The logical model is `whale-erp-front`'s `docs/erd/README.md` catalog, which this
repository does not own. `docs/erd-physical/_build_physical.py` reads that
catalog, applies the decisions in `_model.py`, and writes three things: the DDL
and the table document in `docs/raw/`, and the HTML screens into front's
`docs/erd/physical/`.[^physical-model] All three are generated — change the
model or the catalog and re-run, never edit the outputs.

The logical names are not always the physical ones. Where the catalog breaks the
[naming conventions](/conventions/naming.md) — primary keys like `history_id`,
booleans like `urgent`, abbreviations like `ci` — `_model.py` renames the column
on the physical side only, and the table document lists every rename with its
reason. A column named one way in the logical ERD and another in the DDL is
expected; the document is where to look it up.

The generator stops on a catalog cell it cannot parse. The 1팀 generator it was
adapted from silently skipped rows like `start_date·end_date`, and a later short
reference block for a table overwrote its full definition — either would have
dropped columns without an error.

# It sits on top of 1팀's schema

3팀 tables point at `stores`, `bp_codes`, and `admin_accounts` by their integer
keys but never create them. Apply 1팀's `schema.sql` first; on an empty database
the 3팀 DDL fails at its first foreign key.[^physical-sql] A foreign key to a
관리자 is named for the role (`created_by`, `reviewed_by`), per the naming
conventions.

# What Prisma will not carry

When this becomes `schema.prisma`, three kinds of constraint have no Prisma
syntax and have to live in hand-written migration SQL — the same trap as the
existing CHECK constraints on `items`:

- **CHECK constraints** (22) — formats, ranges, and cross-column rules such as
  `payslips.net_pay_amount = gross_pay_amount - total_deduction_amount`.
- **Partial unique indexes** — e.g. one active location consent per account
  (`WHERE withdrawn_at IS NULL`), invitation tokens only where present.
- **The overlap exclusion on `work_schedules`** — a staff member's schedules may
  not overlap unless deleted. It needs the `btree_gist` extension, which the DDL
  creates; a migration that forgets the extension fails on that one statement.

`db:pull` drops all three, so `schema.prisma` will never be the whole truth for
these tables.

# Decisions the physical model makes on its own

Most columns follow the logical ERD. These do not, and each has a reason in the
table document:

- **Snapshots on issued documents.** `payslip_items` stores `item_name` and
  `is_tax_free` alongside `item_code`. The item list is managed by 플랫폼 관리자 and
  will change; a payslip already sent must keep showing what it said.
- **`is_deleted` only where rows may be removed.** Added to `work_schedules` and
  `post_attachments`; never on `*_histories` or `*_logs`. Every read of a table
  with the flag must filter `is_deleted = false` — forgetting it returns deleted
  rows without an error.
- **Money is `integer` won.** Not `bigint`: the api serialises ids and amounts
  with `JSON.stringify`, which throws on `BigInt`.
- **Columns the logical ERD lacked**: 주휴일 `contracts.weekly_holiday` (kept by
  재영's decision of 2026-10-06), 3.3% `payslips.is_withholding_applied`, location
  pause `location_consents.paused_at`, and `auth_sessions.refresh_token_hash` /
  `last_used_at` for multi-device logins kept 30 days after last use.
- **Polymorphic references split.** `inquiries.scope_id` (BP or 점포) became
  `bp_code_id` + `store_id` so both can carry foreign keys.

Enum values come from the [naming conventions](/conventions/naming.md) mapping
table where it has them; the rest (`work_type`, `invitation_channel`,
`notice_type`, …) are proposals marked as such in the document.

[^physical-erd]: 3팀 물리 ERD 테이블 정의서
[^physical-sql]: 3팀 물리 스키마 DDL
[^physical-model]: 물리 결정 (이름 변경 · 나눔 · 추가 · 뺌 · 제약)
