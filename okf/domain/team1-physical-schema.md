---
type: Reference
title: Team 1 physical schema
description: The PostgreSQL schema for 1팀's 27 tables (auth · BP · stores · system settings) and the migrations that load its reference data; what Prisma cannot carry and why the platform master has no password.
tags: [database, schema, erd, postgresql, prisma, seed]
status: draft
generated: { by: claude-code/opus-5, at: 2026-10-07T00:35:00Z }
sources:
  - id: team1-migration
    resource: ../../prisma/migrations/20261006000000_team1_initial/migration.sql
    title: 1팀 27 테이블 마이그레이션 (제약의 진실)
    last_modified: 2026-10-06T09:00:00Z
  - id: team1-data-migration
    resource: ../../prisma/migrations/20261006000100_team1_initial_data/migration.sql
    title: 1팀 초기 기준 데이터 254행 (마이그레이션 INSERT)
    last_modified: 2026-10-07T00:30:00Z
  - id: prisma-schema
    resource: ../../prisma/schema.prisma
    title: Prisma 스키마 (견본 4개 + 3팀 38개 + 1팀 27개)
    last_modified: 2026-10-06T09:00:00Z
  - id: holiday-migration
    resource: ../../prisma/migrations/20261006000200_team1_public_holidays/migration.sql
    title: 공식 휴일 1346행 (규칙 명세는 머리말에)
    last_modified: 2026-10-07T01:30:00Z
---

# Status

27 models are in `prisma/schema.prisma` and, unlike 3팀's, **migrations exist** —
`20261006000000_team1_initial` for the DDL and `20261006000100_team1_initial_data`
for the 254 constant rows.[^team1-migration][^team1-data-migration] Neither has been applied to a real
database; both were verified by applying all five migrations to PostgreSQL 18 under
PGlite, which also confirmed that the CHECK constraints and partial unique indexes
reject what they are meant to. Applying them is what unblocks
[3팀's schema](/domain/team3-physical-schema.md), whose migration was deliberately
deferred until these tables exist — every 3팀 table points at `stores`, `bp_codes`,
or `admin_accounts`.

# Where it comes from

The logical model and the DDL live in `whale-erp-new-front`, not here:
`docs/erd/team1/README.md` is the catalog and `_build_physical.py` generates
`docs/erd/team1/schema.sql` from it. The migration is a copy of that DDL with a
new header, and **the copy is the truth for this database** — an applied migration
is never regenerated. When the ERD changes, write the next migration rather than
re-running the generator over this file.

The Prisma section was derived from the same DDL, so the two agree on columns,
types, defaults, enums, keys, the 74 internal foreign keys, 7 full unique indexes
and 21 lookup indexes.

# What Prisma will not carry

37 constraints exist only in the migration SQL.[^prisma-schema] `db:pull` drops
all of them, so `schema.prisma` will never be the whole truth for these tables —
the same trap as the CHECK constraints on `items`.

- **CHECK constraints** (32) — code formats (`^BP[0-9]{6}$`, `^MN[0-9]{6}$`,
  `role_code` as `^[A-Z]{2}[0-9]{6}$`), length limits, coordinate ranges, and
  `admin_accounts.email = lower(email)`.
- **Partial unique indexes** (5) — these carry business rules, not just
  uniqueness, and are the ones most easily lost:
  - one platform BP (`bp_codes (is_platform) WHERE is_platform`);
  - 사업자등록번호 unique only among live customer BPs (`WHERE is_platform = false
    AND is_deleted = false AND account_status_code <> 'WITHDRAWN'`);
  - `admin_accounts.email` unique among non-withdrawn accounts, while `login_id`
    is unique **including** withdrawn and deleted rows (a full index) — an id is
    never reissued, an address may be;
  - one undeleted 대표 이미지 per store;
  - 권한명 unique per (BP, 관리계정) with `NULLS NOT DISTINCT`, so two groups with
    no manager cannot share a name either.

The `'WITHDRAWN'` literal in two of those was a placeholder while the
`ACCOUNT_STATUS` code value was undecided; the initial-data migration fixes it as
`WITHDRAWN`, so the conditions now match the data.

# Relations stop at the team boundary

1팀 tables relate to each other through Prisma, but the boundary with 3팀 is
integer columns on both sides. 3팀's models hold `store_id`, `bp_code_id`,
`admin_account_id` and `*_by` as plain `Int` by an earlier decision (`ae1e472`),
and adding these models did not change that — a 3팀 query still cannot `include`
into `stores`. The database-level foreign keys for those columns are **not** in
this migration; they belong to 3팀's, which is written after these tables exist.

**`schema.prisma` is ahead of the migrations folder.** The 38 3팀 models have no
migration, so `pnpm db:migrate` will offer to create them alongside anything else
it finds. That drift predates this schema; `pnpm db:deploy` applies only the
migration files and is unaffected.

# Initial data is migrations, not a seed

All of 1팀's initial data is loaded by migrations; there is no seed script.

254 rows are plain constants and live in a second migration,
`20261006000100_team1_initial_data`: the platform BP `BP000000`, 13 공통코드 groups
and 60 detail codes, 64 menus, three fixed role groups (`PM000001` · `BM000001` ·
`FM000001`), their 106 menu permissions, the first 플랫폼 마스터, and the 6 약관
versions.[^team1-data-migration] Putting them in a migration means Prisma's
`_prisma_migrations` guarantees a single execution — no idempotency logic — and
**"the schema is applied" now implies "the app can boot"**; there is no second step
to forget that would otherwise leave the menu and permission tables empty.

Identity keys are unknown at write time, so child rows join on the code columns
(`bp_code`, `menu_code`, `role_code`) instead of ids, and menu parents are set by a
follow-up `UPDATE … FROM (VALUES …)`. 약관 bodies are dollar-quoted (`$terms$`,
tagged so it cannot collide with the `$$` of the check block); none of the six
contains a dollar sign, backslash or apostrophe, and they total 5.5 KB. The
시행일 is the literal `DATE '2026-10-01'` (서비스 오픈일) — it does not vary by
environment and is not a secret.

A `DO` block at the end asserts every count, so a truncated file fails the
migration rather than loading half the data. It also checks that every
`terms_versions.terms_type_code` exists in `code_items` under `TERMS_TYPE`: that is
a code column with no foreign key, so a typo would otherwise leave one 약관 silently
absent from the screen.

The 공식 휴일 go in a third migration, `20261006000200_team1_public_holidays` — 1346
rows, 84 KB. **There is no seed script**, so installing is `pnpm db:deploy` and
nothing else, with no environment variables anywhere.

That file is not hand-written: it is computed output.[^holiday-migration] The
generator was a one-off and is **not kept in the tree** — nothing would call it, so
instead **the whole rule set is written into the migration's header comment**: the
ten solar holidays with their start and end years, the three lunar ones and the
2050 ceiling, and the 대체공휴일 phase-in years with the "next weekday" search. That
comment is the specification if the calculation ever has to be rebuilt; the 84 KB of
`VALUES` states the dates but the header states the reasoning.

Computing the dates in SQL instead was never an option. The solar holidays would be
easy with `generate_series`, but 설날·부처님오신날·추석 need the 한국천문연구원 lunar
table, which PostgreSQL has no function for — so a SQL version would still carry
~357 literal dates, and the 대체공휴일 search would have to be re-expressed on top.

The cost of the migration form: the table can no longer be corrected by re-running
anything. A change means a new migration, because an applied one is never edited.
That matches where this table is going anyway — 공공 API 동기화 will be mutating it,
and that feature is when the calculation (and a lunar conversion dependency) comes
back, to fill 2051–2100 and to reconcile what the API returns against what the rule
predicts.

## The platform master has no password

`admin_accounts.password_hash` is NOT NULL, and PostgreSQL cannot produce a hash in
this service's format anyway — `scrypt$N$r$p$salt$key`, while pgcrypto's `crypt()`
offers only bcrypt, md5 and des. So the column gets `'!'`: `verifyPassword` splits
the stored value on `$` and checks the scheme first, so `'!'` matches no input and
raises nothing (empty string, `'!'` itself and a real password were all confirmed to
return false). It is the `/etc/shadow` convention for a locked account.

**Nothing secret is in the migration.** The first sign-in goes through 비밀번호
찾기's 임시 비밀번호 발급 instead, so `login_id` and `email` being written in the
file are not credentials — the credential is the mailbox. Put plainly: this
account's security equals the security of `rjy1537@interplug.co.kr`. The exposure
window that a committed hash would create, between applying the migration and the
first password change, does not exist.

`phone` stays NULL because the operator's mobile number has no reason to be in the
repository; `email` cannot, since it is where the temporary password arrives, and
`admin_accounts_email_lower` requires it lowercase. The `DO` block asserts
`password_hash = '!'`, so a later attempt to commit a real hash fails the migration.

**Nobody can sign in yet**, and that is deliberate: 1팀's login, 계정 찾기 and 임시
비밀번호 발급 are not implemented, and mail sending is 3팀's. Being unable to log in
is a better state than a working password living in git history. To set one locally,
generate a hash with the one-liner in the migration comment and `UPDATE` the row —
without committing the value.

약관 본문 is the article-by-article content of the Manyfast 기능명세서 「약관 콘텐츠」
(`F-OFBCVL`), not reviewed legal text; all six still carry `[ ]` placeholders.
Changing wording means stacking a new version and lowering the old one's
`is_active`, never editing a row an agreement log points at — which is also why
the bodies sit in a migration rather than somewhere a re-run could overwrite them.

# 공식 휴일 stops at 2050, and that is the data's limit

The 1346 rows follow 관공서의 공휴일에 관한 규정: ten solar holidays with their
start and end years, 설날·부처님오신날·추석 from the lunar calendar, and the
대체공휴일 rules phased in over 2014 · 2021 · 2023 — 189 of the rows are
substitutes. The full rule set is in the migration's header comment.[^holiday-migration]

Lunar conversion followed 한국천문연구원, whose 음양력 변환 table ends at **2050**.
So 2051–2100 hold solar holidays only (487 of the rows). The missing years come
from the 공공 API 동기화 path, which is also the only source for 임시공휴일 and
선거일 — neither is derivable from a rule, so the migration never invents them.

`public_holidays` has a unique index on `holiday_date`, so two holidays on one day
are one row with both names joined (`어린이날 · 부처님오신날`, 2025-05-05). The
substitute-day search skips weekends, existing holidays, and days already taken by
another substitute; 설날 and 추석 shift for a Sunday or a collision, 어린이날 for
either of those or a Saturday, and the rest for a weekend only.

The migration's `DO` block checks the counts and samples the real calendar:
2024-02-12, 2025-05-06 and 2025-10-08 must be substitutes, 임시공휴일 2025-01-27
must be absent, and no lunar holiday may appear after 2050.

[^team1-migration]: 1팀 27 테이블 마이그레이션 (제약의 진실)
[^team1-data-migration]: 1팀 초기 기준 데이터 254행 (마이그레이션 INSERT)
[^prisma-schema]: Prisma 스키마 (견본 4개 + 3팀 38개 + 1팀 27개)
[^holiday-migration]: 공식 휴일 1346행 (규칙 명세는 머리말에)
