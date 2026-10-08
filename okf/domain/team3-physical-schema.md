---
type: Reference
title: Team 3 physical schema
description: The PostgreSQL schema for 3팀's 46 tables, generated from the logical ERD; what it depends on, what it adds, and what Prisma cannot carry.
tags: [database, schema, erd, postgresql, prisma]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-08T09:00:00Z }
sources:
  - id: physical-erd
    resource: ../../docs/raw/2026-10-06-3팀-물리-ERD.md
    title: 3팀 물리 ERD 테이블 정의서
    last_modified: 2026-10-08T09:00:00Z
  - id: physical-sql
    resource: ../../docs/raw/2026-10-06-3팀-schema.sql
    title: 3팀 물리 스키마 DDL
    last_modified: 2026-10-08T09:00:00Z
  - id: physical-model
    resource: ../../docs/erd-physical/_model.py
    title: 물리 결정 (이름 변경 · 나눔 · 추가 · 뺌 · 제약)
    last_modified: 2026-10-08T09:00:00Z
  - id: prisma-schema
    resource: ../../prisma/schema.prisma
    title: Prisma 스키마 (3팀 46개 + 1팀 27개)
    last_modified: 2026-10-08T09:00:00Z
  - id: account-status-migration
    resource: ../../prisma/migrations/20261007100000_account_status_withdrawn/migration.sql
    title: 계정 상태에 탈퇴를 더하는 마이그레이션
    last_modified: 2026-10-07T07:40:43Z
---

# Status

The 46 models are in `prisma/schema.prisma`, and the DDL is the migration
`20261007000000_team3_initial`, which sorts after 1팀's three (`20261006…`)
because every 3팀 table points at 1팀 tables. It was applied to the development
database on 2026-10-07, together with 1팀's three, after the template samples
were dropped (재영) — so it is now frozen. The reference data followed as
`20261007000100_team3_initial_data` — 공통코드 5 groups / 43 codes (sort order
13–17 after 1팀's twelve, all 플랫폼고정, `BP000000`) and the 29 payroll items —
hand-written in 1팀's style, ending in a `DO` block that checks the counts per
group and per category and the exact 비과세 and 시스템 계산 sets, so a truncated
or edited file fails at deploy. The generator does not touch it. The 40 default
notification templates are `20261007000200_team3_notification_templates`
(운영 알림 10 · 앱 푸시 5 · 메일 24 · 알림톡 1, four 메일 switched off); its check
block also proves every `#{…}` in a body or title is in the variable list and
every required variable appears — except one marked `isButtonLink`.[^prisma-schema]

**The DDL migration was generated until it was applied; changes since are
diff migrations.** `_build_physical.py` wrote `20261007000000_team3_initial`
with the same body as `docs/raw/2026-10-06-3팀-schema.sql`. Applying it fixed its
checksum in `_prisma_migrations` — editing it now makes Prisma refuse to deploy —
so `_model.MIGRATION_APPLIED = True` and the generator leaves that file alone. It
still rewrites `schema.sql`, the table document, the screens, and
`schema.prisma` from the model, and prints a notice when the model has moved
past the applied DDL.

A model change therefore becomes a hand-assembled migration: take the lines
`git diff` adds to `schema.sql` (types, tables, `ALTER TABLE … ADD COLUMN`,
constraints, foreign keys, indexes, comments) into a new folder, then prove it —
apply every migration in order to an empty PGlite, apply 1팀's DDL plus the new
`schema.sql` to another, and diff columns, defaults, constraints, indexes, and
comments (column order aside: `ADD COLUMN` appends). The first one was
`20261007000300_team3_staff_retirement`.

**After the freeze, 탈퇴 joins `account_status`.** Decided
2026-10-07 (노영주, WHALEERP-168): 직원 계정은 퇴직해도 막지 않고 탈퇴하지 않는 한
로그인되는데(ACC-15), `accounts.status` had only `JOINED` and `LINK_HOLD`, so a
withdrawn account could not be told apart. The migration
`20261007100000_account_status_withdrawn` adds `WITHDRAWN` (same word as 1팀's
`ACCOUNT_STATUS`) and nothing else; 휴면 is deliberately **not** a value (ACC-18).
It is additive on purpose — `ALTER TYPE … ADD VALUE` cannot use the new value in
the same transaction, and existing rows are all `JOINED` or `LINK_HOLD`.[^account-status-migration]

Two things to know before the next change of this kind. The model source is
`_model.py` `ENUMS`, edited here, and `_build_enum_labels.py` regenerated
`src/enums/db-enums.generated.ts` from it. But `_build_physical.py` needs
`whale-erp-front`'s `docs/erd/_build.py` beside this repository and refuses to
overwrite the applied migration anyway, so `docs/raw/2026-10-06-3팀-schema.sql`
and the 물리 ERD page still list two values (the ERD page's description already
says 탈퇴) until the generator is run again. The raw files are therefore **behind the
database** by this one value, and `prisma/schema.prisma` was edited by hand to
match.

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

# The Prisma half

`prisma/schema.prisma` holds the four template models (`Item`, `StockMovement`,
`Staff`, `Customer`) untouched, then a marked 3팀 section generated by
`docs/erd-physical/_build_prisma.py` from the same physical model, then 1팀's
section (generated in another repository). Re-run the 3팀 generator after the
physical generator; it rewrites only its own section — from its banner to the
next section's banner — and running it twice changes nothing. Do not edit the
3팀 section by hand.

That boundary is the trap. The generator first rewrote everything below its
marker, which was correct while the 3팀 section was last in the file; once 1팀's
section was appended after it, one re-run would have deleted all 27 1팀 models
without an error. A third section appended later needs to start with the same
`// ═══` banner line, or the 3팀 generator will treat it as its own.

Checked against the DDL by applying 1팀 then 3팀 `schema.sql` to PostgreSQL
(PGlite) and running `prisma migrate diff` against the schema: on the 3팀 side the
only difference is one constraint Prisma cannot express (below). Columns, types,
defaults, enums, keys, internal relations, uniques, and indexes matched (checked
2026-10-06, at 38 tables; not re-run for the two added on 2026-10-07).

**Never run `pnpm db:migrate` (`prisma migrate dev`) against this schema.**
Diffing a database built from all migration SQL plus the 3팀 DDL against
`schema.prisma`, Prisma wants to drop the 28 foreign keys into 1팀 tables and the
`NULLS NOT DISTINCT` unique — all deliberately SQL-only, so a generated
migration would remove real constraints. Migrations here are written from the
DDL and applied with `pnpm db:deploy`.

Until 2026-10-07 the same diff also dropped and re-created eleven 1팀 columns,
and queries filtering or writing them failed with
`type "public.UseStatus" does not exist`: 1팀's eight enums in `schema.prisma`
had no `@@map` while its migration named the types `use_status`, … (an
unfiltered `findMany` worked, which is why it went unnoticed). 3팀 added the
eight `@@map` lines (재영's approval, 1팀 전달 사항 16); after that the diff is the
29 intentional items only and those queries pass. The 3팀 Prisma generator
rewrites only its own section, so the lines survive a re-run.

1팀 tables are **not models** — `store_id`, `bp_code_id`, `admin_account_id` and
the `*_by` columns are plain `Int`. That keeps 1팀's tables out of our migrations,
at the cost of `include`: a 3팀 query cannot follow a relation into `stores` or
`admin_accounts`. When 1팀's tables exist, whether to model them (Prisma 7 can mark
them `tables.external`, still experimental) is decided again.

Two things read differently from the DDL. The enum type `payslip_review_reason` is
`PayslipReviewReasonValue` in Prisma, because the table `payslip_review_reasons`
already takes the name `PayslipReviewReason`; the database name is unchanged. And
primary keys show as `@default(autoincrement())` while the SQL says
`GENERATED ALWAYS AS IDENTITY` — Prisma has no identity syntax, so the migration
SQL must keep the SQL form, as `20261007000000_team3_initial` does.

# What Prisma will not carry

75 constraints exist only in SQL and live in the migration SQL — the generator
writes them there, and `db:pull` would lose them. The
31 foreign keys to 1팀 tables are the largest group; the rest:

- **CHECK constraints** (39) — formats, ranges, and cross-column rules such as
  `payslips.net_pay_amount = gross_pay_amount - total_deduction_amount`.
- **Partial unique indexes** (3) — e.g. one active location consent per account
  (`WHERE withdrawn_at IS NULL`), invitation tokens only where present.
- **A `NULLS NOT DISTINCT` unique** (1) — `post_audiences`, so audiences without
  an add-on product cannot repeat either.
- **The overlap exclusion on `work_schedules`** (1) — a staff member's schedules may
  not overlap unless deleted. It needs the `btree_gist` extension, which the DDL
  creates; a migration that forgets the extension fails on that one statement.

**Names longer than 63 bytes are cut silently.** PostgreSQL truncates an
identifier at 63 bytes without an error (PGlite accepted a 71-byte index name),
so the name in the migration SQL and the name in the database would differ, and
anything that later drops or alters the constraint by name misses it. Prisma's
validate rejects such a `map` name, but nothing checks the SQL side, so the
physical generator's self-check now fails on any quoted identifier over 63
bytes. Long table names reach it fast: `notification_template_histories` plus
two columns and `_idx` is already 71.

`db:pull` drops all of these, so `schema.prisma` will never be the whole truth for
these tables. There is no separate list: the constraints themselves are in
`docs/raw/2026-10-06-3팀-schema.sql`, which is what the migration copies from.

# Decisions the physical model makes on its own

Most columns follow the logical ERD. These do not, and each has a reason in the
table document:

- **근무 장소 is its own column** (`contracts.work_location`, text, 2026-10-08,
  `20261008000500_team3_contract_work_location`). It is the address written
  into the contract's 근무 장소 clause, typed by the 관리자 (mockup
  contracts-new), and is separate from 근무지 `store_id`. The naming table has
  no row for 근무 장소 yet; the source belongs to the 기획 세션.
- **`contracts` keeps NOT NULL on its keys only** (2026-10-08). So a 근로계약서
  can be saved half-filled as 임시저장, every column but the primary key and the
  foreign keys `staff_member_id` · `store_id` · `created_by` accepts NULL —
  booleans and `created_at` · `updated_at` included; their defaults stay. The
  generator does this per table through `_model.KEYS_ONLY_NOT_NULL`, which
  overrides its usual "booleans and timestamps are always NOT NULL". **What is
  required at each save step is now the app's job**, with one exception: a
  `SIGNED` contract must have `start_date` (CHECK
  `contracts_start_date_required_when_signed`, 재영 2026-10-08). 근무스케줄 and
  출퇴근 are accepted only on a day inside a `SIGNED`, undeleted contract's
  period (`end_date` NULL means open-ended), and a start date is what makes that
  period decidable. Migration
  `20261008000700_team3_contracts_start_date_required_when_signed`. The migration
  `20261008000400_team3_contracts_keys_only_not_null` relaxes `work_terms` ·
  `wage_terms` only if they exist, because a branch that replaces them with
  columns has already reached the development database.

- **Payroll items are a table, not 공통코드** (재영, 2026-10-07).
  `payslip_item_masters` holds the 29 items (`item_code`, `name`, `category`
  지급 · 기본 공제 · 추가 공제 · 원천징수, `is_tax_free`, `is_system_calculated`,
  `sort_order`, `is_active`) because each item carries attributes a 공통코드 row
  has no place for. Its codes are not 공통코드, so the 20-character limit does
  not apply (`EMPLOYMENT_INSURANCE_SETTLEMENT` is 31).
- **Snapshots on issued documents.** `payslip_items` points at
  `payslip_item_masters` and also stores `item_name`, `item_category`, and
  `is_tax_free` as they were. 플랫폼 관리자 edits the item table; a payslip already
  sent must keep showing what it said. The line's category uses the same
  four-value enum as the item table — it is a copy of it.
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
- **`notification_templates` is the source of the wording, 알림톡 included**
  (재영, 2026-10-07). The 40 default rows are inserted by migration, the same way
  1팀 seeds its data; operators register more and edit every field afterwards;
  the code-side `ALIMTALK_TEMPLATES` registry was removed on 2026-10-08
  ([Alimtalk](/api/alimtalk.md)). The system keeps no Kakao approval state: an
  unapproved body is rejected by Bizppurio at send time, which the delivery
  record shows. CHECKs tie the columns to the channel: `kakao_template_code` is
  required for 알림톡 and absent otherwise,
  `title` is required for the other three and absent for 알림톡, and `body` is
  required for all four.
- **A template is identified by its code, not by a 공통코드** (재영,
  2026-10-07). The `NOTIFICATION_TYPE` and `SEND_PURPOSE` groups were dropped:
  a template is its channel plus a `template_name` (「근로계약 날인 알림」) plus a
  `template_code`, and everything that points at a template does so by that
  code. Callers send by it (`send('EMAIL_SIGNUP_DONE', vars)`); `notifications`
  records it per row (`template_code`, not a foreign key — the text is a record
  of what was sent, and a later rename does not rewrite history); 1팀's
  `mail_send_logs.mail_type_code` holds it too (1팀's column, changed on their
  side). 1팀's eight mail kinds are ordinary `EMAIL` templates, and nothing stops
  two templates sharing a channel — the old one-per-(channel, type) rule went
  with the types.
- **`template_code` is an editable name, so only its format is checked.**
  Registration fills in the channel prefix (`NTF` · `PUSH` · `EMAIL` · `TALK`)
  and operators finish and may later change it; the 40 defaults start as
  `NTF_CONTRACT_SIGNED`, `PUSH_PAYSLIP_SENT`, `EMAIL_SIGNUP_DONE`, …. The CHECK
  is `^[A-Z][A-Z0-9_]*$` plus a unique index.
- **Staff opt-outs are by 수신 설정 묶음 (`preference_category`), not by template.**
  `CONTRACT` · `SCHEDULE` · `TODO` · `PAYSLIP` — 근로계약서 · 근무스케줄 · TO-DO ·
  급여명세서 (enum `preference_category`, glossary term 「수신 설정 묶음」) — is
  set on every 앱 푸시 template and on no other (CHECK), and
  `notification_preferences` is keyed by it per account. 근로계약서 and 급여명세서
  cannot be turned off (운영 정책 NTF-14) — a CHECK refuses `is_enabled = false`
  for those two, so the rule holds even if the screen forgets it.
- **Templates are switched off, never deleted.** `is_active` (the same name as
  `terms_versions.is_active` on 1팀's side) — sent notifications and mail logs
  carry the template code.
- **The variable list is one JSON column** (재영, 2026-10-07):
  `notification_templates.variables` = `[{name, label, isRequired, sampleValue, isButtonLink?}]`,
  array order being display order. A separate table was modelled first and
  dropped: the list is always saved together with its template, history
  already stores it as JSON, and a table would have needed `is_deleted`, a
  partial unique, and an `is_deleted` filter on every read just to let a list
  shrink. The database checks only that the value is an array
  (`jsonb_typeof = 'array'`); element shape, the name rule (no `#`, braces, or
  whitespace — Korean names such as `#{고객명}` are allowed because Kakao
  templates use them), and 「every `#{…}` in body and title is in the list」 are
  checked by the api when saving.
- **A link the mail frame or the 알림톡 button adds is marked, not named.**
  `#{링크}` is required in 21 default templates but never in their body: the
  common mail layout renders it as a button, and the 알림톡 button carries it.
  Such a variable carries `isButtonLink: true` in `variables`, and that flag —
  not the name 「링크」 — is what exempts it from 「a required variable must
  appear in the body or title」. An operator can rename the variable, and an
  exemption keyed on a Korean name would silently stop applying.
- **Retirement is an event log, one row per shortened contract** (재영,
  2026-10-07; 운영 정책 CTR-24 · CTR-25). `staff_member_retirement_logs` records
  `RETIRE` and `CANCEL` (enum `retirement_action`) with the date and
  `processed_by`. A `RETIRE` writes a row per 체결 완료 contract whose end date it
  pulled forward, keeping `previous_contract_end_date`, all with the same
  `processed_at` — renewal can leave two signed contracts overlapping, so one
  pair of columns per retirement would not do. With nothing pulled forward it is
  one row with `contract_id` NULL. `CANCEL` restores from the latest `RETIRE`
  group; CHECKs keep the contract columns on `RETIRE` rows only. Unassigning a
  retiring 직원's personal TO-DO deletes the `todo_assignees` row — the one table
  excepted from the never-`DELETE` rule — and records
  `todo_status_histories.unassigned_staff_member_id`.
- **A password-reset pin has no cooldown; five misses close it** (재영,
  2026-10-08; 운영 정책 ACC-08 · ACC-09). A pin lives 10 minutes from
  `issued_at`, on one clock. `cooldown_step` / `cooldown_expires_at` were dropped
  (`20261008000000_team3_password_reset_pin`); "closed after five wrong tries" is
  not a column — `attempt_count = 5` is the closed state, and the existing CHECK
  keeps it from going higher. Saving the new password verifies the pin again,
  which is when `used_at` is set.
- **Inquiry attachments cannot be removed, and the limit of five is the
  database's** (재영, 2026-10-08; 운영 정책 CNT-18). `inquiry_attachments` mirrors
  `post_attachments` (file name, size, storage key, order) plus `file_type`
  (enum `attachment_file_type` JPG · PNG · PDF — the api sets it from the file's
  magic bytes, not its extension), but has no `is_deleted`: files are attached
  only when the 문의 is registered and never added or removed after, so nothing
  should delete them. 10 MB is a CHECK on `size_bytes`. "Five per inquiry" is
  enforced without a trigger: `sort_order` must be 1–5 and is unique per
  inquiry, so a sixth row fails one or the other. The api still checks first, to
  answer with a readable 400. Downloads go through the api (문의자 본인 and 플랫폼
  운영자 only); `storage_key` is never a public URL.
- **알림톡 has its own send log** (2026-10-08). `alimtalk_send_logs` gets one row
  per Bizppurio attempt — `SUCCEEDED` when accepted, `FAILED` with the code,
  HTTP status and message — written by `AlimtalkService`
  (`20261008000200_team3_alimtalk_send_logs`). It is not
  `notification_deliveries`: that table hangs off `notification_recipients`, so
  it cannot hold a 가입 초대 sent to someone with no account. The recipient is
  the digits-only number (CHECK `to_phone_format`, `^01[0-9]{8,9}$`) plus an
  optional `related_type` · `related_id`, a polymorphic reference with no foreign
  key that CHECK `related_pair` keeps both-or-neither. `kakao_template_code` is
  copied at send time because the template row can be edited later.
  `reference_key` is unique — it is ours, and a result report is matched on it —
  while `message_key` has a plain index: Bizppurio does not document it as unique,
  and a collision under a unique index would fail the INSERT and silently lose the
  row (PR #6 팀 리뷰).
- **Reset links and email-find attempts keep only keys** (재영 승인, 2026-10-08;
  노영주 요청, 운영 정책 ACC-19). `password_reset_links` holds the sha256 of the
  token (unique, `^[0-9a-f]{64}$`), expires 24 hours after issue, and is always
  issued by an 관리자 (`requested_by` NOT NULL). Being used and being replaced by a
  newer link both just set `closed_at` — there is no reason column, so a closed
  link cannot tell which happened. `email_find_attempts` stores the phone number
  only as an HMAC `phone_key`, with `failed_count` and `lock_expires_at`
  (`20261008000600_team3_password_reset_links_email_find`). The same migration
  rewords `staff_member_retirement_logs.previous_contract_end_date` as a reference
  value: 퇴직 처리 취소 no longer restores it.
- **Work schedules have no confirmation step** (재영, 2026-10-08; 운영 정책
  PAY-14 v90). Saving a schedule publishes it to the 직원 근무 앱 at once, so
  `work_schedules.confirm_status` and its enum were dropped
  (`20261008000300_team3_work_schedule_confirm_drop`). The push that follows a
  save — once per save, only to the 직원 whose rows that save added, changed, or
  removed — is api behavior, not schema. The same migration renames the
  default template `PUSH_SCHEDULE_CHANGED` from 「근무스케줄 주요 변경」 to
  「근무스케줄 변경」, only where the old name is still there — an operator's own
  rename is left alone.
- **History keeps the whole row before each change**, the list included, in
  `notification_template_histories`.
- **The physical generator now fails on a column listed twice in one table.**
  It used to pass with zero errors while emitting a `CREATE TABLE` PostgreSQL
  rejects — what happens when the logical catalog gains a column that
  `_model.ADD` was still adding. Unique index names can be set in
  `_model.KEY_NAMES` when the default `{table}_{cols}_key` would pass 63 bytes.
- **Polymorphic references split.** `inquiries.scope_id` (BP or 점포) became
  `bp_code_id` + `store_id` so both can carry foreign keys.

`post_audiences.service_code` (was `addon_code`) holds a value of 1팀's
`SERVICE` group; which of its twelve values count as 부가서비스 is still being
asked of 1팀.

Enum values come from the [naming conventions](/conventions/naming.md) mapping
table where it has them; the rest (`invitation_channel`,
`notice_type`, …) are proposals marked as such in the document.

[^physical-erd]: 3팀 물리 ERD 테이블 정의서
[^physical-sql]: 3팀 물리 스키마 DDL
[^physical-model]: 물리 결정 (이름 변경 · 나눔 · 추가 · 뺌 · 제약)
[^prisma-schema]: Prisma 스키마 (3팀 46개 + 1팀 27개)
[^account-status-migration]: 계정 상태에 탈퇴를 더하는 마이그레이션 (2026-10-07)
