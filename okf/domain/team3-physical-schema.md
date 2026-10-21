---
type: Reference
title: Team 3 physical schema
description: The PostgreSQL schema for 3팀's 48 tables, generated from the logical ERD; what it depends on, what it adds, and what Prisma cannot carry.
tags: [database, schema, erd, postgresql, prisma]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-21T01:10:00Z }
sources:
  - id: auth-session-remember-me
    resource: ../../prisma/migrations/20261020174901_team3_auth_session_remember_me/migration.sql
    title: 접속 상태의 자동 로그인 칸 (끄면 7일)
    last_modified: 2026-10-20T06:20:00Z
  - id: email-change-pins
    resource: ../../prisma/migrations/20261020174900_team3_email_change_pins/migration.sql
    title: 이메일 변경 핀 테이블 (WHALEERP-191)
    last_modified: 2026-10-20T05:58:00Z
  - id: account-hq-sharing-consent
    resource: ../../prisma/migrations/20261020101015_team3_account_hq_sharing_consent/migration.sql
    title: 본사 제공 동의를 직원 레코드에서 계정으로 옮기는 마이그레이션
    last_modified: 2026-10-20T04:17:59Z
  - id: hq-sharing
    resource: ../../src/admin-scope/hq-sharing.ts
    title: 본사 제공 동의를 직원 레코드의 계정에서 읽는 조각
    last_modified: 2026-10-20T03:47:38Z
  - id: post-attachments-file-type
    resource: ../../prisma/migrations/20261019171114_team3_post_attachments_file_type/migration.sql
    title: 공지 첨부 file_type · 자리 1~5 CHECK · 지우지 않은 첨부의 자리 부분 고유 (#272)
    last_modified: 2026-10-19T08:43:06Z
  - id: lead-reply-mail-result
    resource: ../../prisma/migrations/20261019102805_team3_lead_reply_mail_result/migration.sql
    title: 도입문의 마지막 답변 메일 결과 · 시각 (#597)
    last_modified: 2026-10-19T01:52:57Z
  - id: lead-reply-without-name
    resource: ../../prisma/migrations/20261015164811_team3_lead_reply_without_name/migration.sql
    title: EMAIL_LEAD_REPLY 에서 문의자이름을 뺌
    last_modified: 2026-10-16T01:20:15Z
  - id: lead-created-at-index
    resource: ../../prisma/migrations/20261015164900_team3_lead_created_at_index/migration.sql
    title: leads (created_at) 조회 인덱스
    last_modified: 2026-10-15T08:14:00Z
  - id: lead-confirmation-fixed-wording
    resource: ../../prisma/migrations/20261015155556_team3_lead_confirmation_fixed_wording/migration.sql
    title: EMAIL_LEAD_CONFIRMATION 을 변수 없는 고정 문구로
    last_modified: 2026-10-15T07:00:00Z
  - id: lead-reply-mail-template
    resource: ../../prisma/migrations/20261015140832_team3_lead_reply_mail_template/migration.sql
    title: 도입문의 답변 메일 기본 템플릿 EMAIL_LEAD_REPLY (41번째, WHALEERP-588)
    last_modified: 2026-10-15T06:30:00Z
  - id: physical-erd
    resource: ../../docs/raw/2026-10-06-3팀-물리-ERD.md
    title: 3팀 물리 ERD 테이블 정의서
    last_modified: 2026-10-21T01:10:00Z
  - id: physical-sql
    resource: ../../docs/raw/2026-10-06-3팀-schema.sql
    title: 3팀 물리 스키마 DDL
    last_modified: 2026-10-21T01:10:00Z
  - id: physical-model
    resource: ../../docs/erd-physical/_model.py
    title: 물리 결정 (이름 변경 · 나눔 · 추가 · 뺌 · 제약)
    last_modified: 2026-10-21T01:10:00Z
  - id: prisma-schema
    resource: ../../prisma/schema.prisma
    title: Prisma 스키마 (3팀 48개 + 1팀 27개)
    last_modified: 2026-10-20T06:20:00Z
  - id: account-status-migration
    resource: ../../prisma/migrations/20261007100000_account_status_withdrawn/migration.sql
    title: 계정 상태에 탈퇴를 더하는 마이그레이션
    last_modified: 2026-10-07T07:40:43Z
  - id: leads-reply-tracking-migration
    resource: ../../prisma/migrations/20261012110123_team3_leads_reply_tracking/migration.sql
    title: 도입문의 답변 관리자 · 답변 일시 · 최근 수정 일시를 더하는 마이그레이션
    last_modified: 2026-10-12T02:05:00Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: hidesPersonalData — 본사 제공 동의를 읽는 곳
    last_modified: 2026-10-20T06:55:00Z
  - id: inquiry-lead-processing-start-migration
    resource: ../../prisma/migrations/20261013151714_team3_inquiry_lead_processing_start/migration.sql
    title: 문의사항 · 도입문의 처리 시작 관리자 · 일시를 더하는 마이그레이션
    last_modified: 2026-10-13T05:55:58Z
  - id: notification-related-index-migration
    resource: ../../prisma/migrations/20261015104957_team3_notification_related_index/migration.sql
    title: 알림의 관련 업무 (related_type, related_id) 조회 인덱스
    last_modified: 2026-10-15T01:51:27Z
---

# Status

The 49 models (with `invitation_code_attempts` — 초대 코드 입력 잠금, JOIN-7, added in
`20261021103042_team3_staff_signup`) are in `prisma/schema.prisma`, and the DDL is the migration
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
every required variable appears — except one marked `isButtonLink`. A 41st,
`EMAIL_LEAD_REPLY` (도입문의 답변 메일, WHALEERP-588), came later in
`20261015140832_team3_lead_reply_mail_template`, which fills its `default_*` columns in the same
INSERT since the copy-once migration `20261013153521` had already run. Its check block only
proves the row and its defaults exist — the variable-list check of `20261007000200` did not run on it.
`20261015155556_team3_lead_confirmation_fixed_wording` then rewrote `EMAIL_LEAD_CONFIRMATION` (body and `default_body`) to fixed
wording with an empty variable list, since an unauthenticated lead intake must not put submitted text in a
company mail (api #50 review, 2026-10-15). `20261015164811_team3_lead_reply_without_name` did the same to
`EMAIL_LEAD_REPLY`: `#{문의자이름}` is gone from body and variables (default_* too), leaving only `#{답변}`, which the
operator writes (CNT-11 v134).[^prisma-schema]

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

The second was `20261007000300_team3_contract_terms` (근로계약 근무 조건 ·
급여 조건, below), checked the same way. Both share the `…000300` prefix —
Prisma orders by full name, so `contract_terms` runs before `staff_retirement`;
the two touch different tables.

**After the freeze, 탈퇴 joins `account_status`.** Decided
2026-10-07 (노영주, WHALEERP-168): 직원 계정은 퇴직해도 막지 않고 탈퇴하지 않는 한
로그인되는데(ACC-15), `accounts.status` had only `JOINED` and `LINK_HOLD`, so a
withdrawn account could not be told apart. The migration
`20261007100000_account_status_withdrawn` adds `WITHDRAWN` (same word as 1팀's
`ACCOUNT_STATUS`) and nothing else; 휴면 is deliberately **not** a value (ACC-18).
It is additive on purpose — `ALTER TYPE … ADD VALUE` cannot use the new value in
the same transaction, and existing rows are all `JOINED` or `LINK_HOLD`.[^account-status-migration]

Two things to know before the next change of this kind. The model source is
`_model.py` `ENUMS`, edited here. (Labels for `GET /enums` were then generated from
it; since 2026-10-12 they come from the enum's `COMMENT ON TYPE` instead — see
[whale-erp-api](/api/whale-erp-api.md).) But `_build_physical.py` needs
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
29 intentional items only and those queries pass — plus, since 2026-10-15, the
no-op `SET DEFAULT now()` on `leads.created_at` (see 「`leads.created_at` is filled
by the database」). The 3팀 Prisma generator
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

98 constraints exist only in SQL and live in the migration SQL — the generator
writes them there, and `db:pull` would lose them. The
34 foreign keys to 1팀 tables are the largest group; the rest:

- **CHECK constraints** (59) — formats, ranges, and cross-column rules such as
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

- **Invitations can go out by 앱 푸시** (`invitation_channel` gains `PUSH`,
  2026-10-08, `20261008000900_team3_invitation_channel_push`). 소속 추가 확인 ·
  복귀 확인 reach the existing account by push, not by a token link, and
  `invitations.channel` is NOT NULL — before this value they had nothing to
  store.

- **근무 장소 is its own column** (`contracts.work_location`, text, 2026-10-08,
  `20261008000500_team3_contract_work_location`). It is the address written
  into the contract's 근무 장소 clause, typed by the 관리자 (mockup
  contracts-new), and is separate from 근무지 `store_id`. The naming table has
  no row for 근무 장소 yet; the source belongs to the 기획 세션.
- **임금 · 근로시간 · 연차휴가 · 퇴직금 clauses are columns on `contracts`**
  (2026-10-12, `20261012182445_team3_contract_allowances_hours_terms`), all
  NULL allowed like the rest of the table. 비과세 수당 식대 · 자가운전보조금 ·
  육아수당 are won integers (`meal_allowance_amount` · `car_allowance_amount` ·
  `childcare_allowance_amount`), right after `wage_amount`. Monthly hours are
  `numeric(5,1)` because shifts move in 30 minutes: 기본시간 `base_hours`, 월간
  연장근무 `monthly_overtime_hours`, 기본시간 중 야간근무 `base_night_hours`,
  기본시간 중 휴일근무 `base_holiday_hours`, 월간 추가 휴일근무
  `monthly_extra_holiday_hours` (Prisma `Decimal`; `_build_prisma.py` now maps
  `numeric(p,s)`). Amounts and hours carry `>= 0` CHECKs
  (`contracts_<column>_nonnegative`). 연차휴가 · 퇴직금 wording is
  `annual_leave_terms` · `severance_pay_terms` (text, after `pay_day`): the
  작성 screen fills the default (근로기준법 제50조 연차휴가 · 1년에 30일분
  퇴직금) and the 관리자 may edit it; the database has no default. The naming
  table has no rows for these yet.
- **`contracts.wage_amount` is always the 시급** (2026-10-12), whatever the 고용
  형태; 월급 is worked out from the hours and is not stored. 정직원 rows saved
  before held a 월급 there, so the same migration sets their `wage_amount` to
  NULL (PR #12 review): converting would need a 월 소정근로시간 rule (주휴 ·
  rounding) that is not settled, and the 관리자 types the 시급 again. The
  logical ERD note (front `docs/erd`) still
  reads 「정직원은 월급, 파트타이머는 시급」; the physical comment is overridden
  through `_model.NOTE`, which `_build_physical.py` now reads.
- **본사 제공 동의 lives on the account** (`accounts`, moved 2026-10-20 노영주,
  `20261020101015_team3_account_hq_sharing_consent`; it started on the staff
  record — #137, 2026-10-12 재영, `20261013091102_team3_staff_member_hq_sharing_consent`):
  `is_hq_sharing_consented` (boolean, NOT NULL, default false) ·
  `hq_sharing_consent_version` · `hq_sharing_agreed_at` ·
  `hq_sharing_withdrawn_at`, after `address_detail`. It decides whether a 가맹 점포
  직원 is shown to BP 마스터 · BP 관리자. **One answer per person**: a 직원 working
  at two 가맹 점포 does not consent at one and refuse at the other, so it applies to
  every 소속 at once. The move copies no values: nothing wrote the staff
  columns yet, so every account starts at the default (not consented), and with
  one value per account there is no rule for choosing among a person's records.
  The four staff columns and their CHECKs were left unread for a while (an older
  Prisma client puts every column into a select-less read or `update`, so dropping
  them at once would 500 any api built before #78 — PR #78 review) and are dropped by
  `20261020140331_team3_drop_staff_member_hq_sharing` (민식, who owns
  `staff_members`). It locks the table ACCESS EXCLUSIVE, stops if any staff row
  still holds a consent or a withdrawal, then drops the CHECKs and the columns. Apply
  it only after the shared server and every local api run #78 or later. A staff record not yet joined has
  no account and counts as **not consented** — there is nobody to ask yet, and
  masking is the safe side. An account can belong to several BPs, so the one
  value holds across BPs too, but each 본사 sees only the person's records in its
  own BP's stores — scope still stops at the BP, and no other 소속 is revealed
  (2026-10-20 노영주). 운영 정책 ATT-30 still says 「직원 레코드별」; the wording
  change waits for 재영 (2026-10-20). Code reads it through `src/admin-scope/hq-sharing.ts`
  (`HQ_SHARING_SELECT` · `HQ_SHARING_CONSENTED` · `hqSharingConsentedOf`), and the
  rule stays in one place, `hidesPersonalData` in
  `src/admin-scope/admin-scope.service.ts`: BP 마스터 · BP 관리자 see a consented
  가맹 점포 직원 like a 직영 one, both in the [staff member list](/api/staff-members.md)
  and on the per-staff routes (`canManageStaffMember`) — but not for account
  actions: the password reset link stays per store (`canManageStaffAccount`,
  2026-10-14 재영). Only the boolean decides —
  a withdrawn row keeps its version and dates, so keying on `hq_sharing_agreed_at`
  would show it again. Names follow the naming table (본사 제공 동의
  `hq_sharing_consent`, 동의 문구 버전 `consent_version`) and the
  `location_consents` pair `agreed_at` · `withdrawn_at`. Three CHECKs keep the
  four in step: while consented the version and 동의 시각 are set and 철회 시각 is
  empty (`accounts_hq_sharing_consent_fields`); while not consented the
  three are either all empty (never agreed) or all set (withdrawn), so a
  withdrawal never loses its time or what was agreed to
  (`accounts_hq_sharing_not_consented_fields`); a 철회 시각 needs a 동의 시각
  at or before it (`accounts_hq_sharing_withdrawn_after_agreed`). A new agreement
  overwrites the previous agreement and withdrawal (A안, 2026-10-13 재영). The
  hiring ERD got layout fixes in `_build_physical.py` (account → hold line and
  staff → retirement line) when the staff box grew.
- **Regenerating from a drifted front.** The front logical ERD has moved on
  since the generated files were last written, and no front commit reproduces
  them byte for byte. The 2026-10-20 move was generated twice against the same
  front copy — once from the unchanged model, once from the changed one — and
  only the difference between the two was applied to `schema.sql`, the table
  document and `schema.prisma`. The migrated database then matched the new
  `schema.sql` for `accounts` and `staff_members` (columns, defaults,
  constraints, comments), apart from the long-standing `accounts.status` comment.
- **도입문의 records who answered and when** (`leads.replied_by` → `admin_accounts`,
  `leads.replied_at`, both nullable; 2026-10-12 재영, Plane #274,
  `20261012110123_team3_leads_reply_tracking`). `leads` also gets `updated_at`
  (NOT NULL, default now) so a save can be rejected when another 관리자 changed
  the row since it was read. Prisma marks it `@updatedAt`, which only fires
  through Prisma — a raw `UPDATE` must set it, or the conflict check sees no
  change. `replied_by` is a 1팀 foreign key, so it exists only in the SQL.
- **도입문의 keeps the last reply mail's result and time** (`leads.reply_mail_result`
  — new enum `reply_mail_result` 성공 · 실패 — and `reply_mail_attempted_at`, both
  nullable — a time without a result means the outcome is not known yet, because
  starting a send clears the result; WHALEERP-597, 2026-10-19 재영, `20261019102805_team3_lead_reply_mail_result`). It
  is a separate enum from 1팀's `process_result` with the same values: the generator
  emits `CREATE TYPE` for every enum in `_model.ENUMS`, so reusing a 1팀 type would
  not survive regeneration. These two columns are written by raw `UPDATE` on
  purpose — the opposite of the warning above — so a mail result does not move
  `updated_at` and turn the 관리자's next save into a 409.
- **문의사항 · 도입문의 record who moved them to 처리중 and when**
  (`processing_started_by` → `admin_accounts`, `processing_started_at`, both
  nullable, after `status` on `inquiries` and `leads`; 2026-10-13, Plane #274,
  `20261013151714_team3_inquiry_lead_processing_start`). An answer may skip
  처리중, so both stay NULL then. The only CHECK is that the two are set or empty
  together (`inquiries_processing_started_pair`, `leads_processing_started_pair`);
  「`IN_PROGRESS` implies set」 is deliberately not enforced, because rows already
  in 처리중 before this migration have neither and would block the deploy. The API
  must fill both in the same `UPDATE` that sets `IN_PROGRESS`. The foreign keys
  point into 1팀, so like `replied_by` they exist only in the SQL.
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
- **임시저장 is a contract status** (`DRAFT`, first in order, 2026-10-08) —
  `20261008001000_team3_contract_status_draft` adds it with `ADD VALUE … BEFORE
  'PENDING_SEND'`. The name follows 게시 상태's 임시저장; 「초안」 is still
  `PENDING_SEND`. Readers that hide drafts from 직원 by excluding
  `PENDING_SEND` alone now let `DRAFT` through.
- **Contract terms are not JSON** (2026-10-07, not yet confirmed by 3팀). The
  logical ERD left "one JSON cell or columns" to physical design. 근무 조건 is
  `contract_work_days` — one row per working weekday (PK `contract_id` +
  `weekday`), 시업 · 종업 · 휴게 시작 · 휴게 종료 as `time`, with CHECKs for
  end after start, 30-minute steps, and a break inside the shift. Shifts past
  midnight cannot be stored; the 1차 mockup has none. 급여 조건 is
  `contracts.wage_amount` · `pay_month` (당월 · 익월) · `pay_day` (1–31, 31 =
  말일). There is no wage-type column: 정직원 is 월급 and 파트타이머 is 시급, so
  `employment_type` already says which `wage_amount` is. The migration refuses
  to run if `contracts` has rows — the old JSON had no agreed shape to copy from.

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
  재영's decision of 2026-10-06; the admin picks it since 2026-10-15), 급여 지급 방식
  `contracts.pay_method` (계좌 · 현금) and 수습 `contracts.probation_months` (1–3) ·
  `probation_wage_reduction_rate` (0–10 %, filled together — 노무사 확인
  2026-10-14), the original name of a 종이 계약 file `contract_documents.file_name` (2026-10-15), the
  admin-entered 성별 `contract_parties.entered_gender` (enum `gender`, 남 · 여) and 외국인 여부
  `contract_parties.is_foreigner` for 본인 대조 (2026-10-16), the 직원-entered 성별
  `accounts.gender` and 외국인 여부 `accounts.is_foreigner` they are compared with (직원 앱 가입,
  2026-10-20), 3.3% `payslips.is_withholding_applied`, location
  pause `location_consents.paused_at`, and `auth_sessions.refresh_token_hash` /
  `last_used_at` for multi-device logins kept 30 days after last use.
- **`notification_templates` is the source of the wording, 알림톡 included**
  (재영, 2026-10-07). The 41 default rows are inserted by migration (40 at first, `EMAIL_LEAD_REPLY` later), the same way
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
  and operators finish and may later change it; the 41 defaults start as
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
- **A session remembers whether 자동 로그인 was on** (2026-10-20 노영주).
  `auth_sessions.is_remembered` (boolean, NOT NULL, default `true`, a physical-only
  `_model.ADD` column, `20261020174901_team3_auth_session_remember_me`)[^auth-session-remember-me]
  lets refresh extend an off session by 7 days instead of 30 days. The default
  keeps every earlier session at 30 days. The `expires_at` and `last_used_at`
  comments still say 30 days; correcting them takes a `COMMENT ON COLUMN` in a
  migration (and the `_model.ADD` remark for `last_used_at`), left as is for now.
- **The e-mail change pin is its own table, ahead of the logical ERD**
  (WHALEERP-191, 2026-10-20 노영주). `email_change_pins` keeps the same rules as
  the reset pin (hash only, five misses close it, 1-minute interval, 10 a day)
  plus `new_email` — the address the pin went to, lowercase by CHECK
  (`email_change_pins_new_email_lower`) — and lives 15 minutes, as the
  `EMAIL_CHANGE_PIN` wording says.[^email-change-pins] It is a separate table so
  the reset code never has to filter "no new e-mail" out of every query. The
  front logical catalog does not have it yet: the table was generated by adding it
  to a **copy** of the catalog, running both generators before and after, and
  moving only that difference here (`20261020174900_team3_email_change_pins`,
  `_model.py`, `schema.sql`, the table document, `schema.prisma`; the header's
  CHECK count moved by three from the repository's own value). The same table
  block was sent to 재영 for front `docs/erd/README.md`; until it lands, the next
  regeneration against front drops the model — re-add the block to the copy as
  above rather than editing the generated files by hand. The logical drawing
  (front `_build.py` layout) also lacks it, which the generator's self-check
  reports as 누락 1건.
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
- **Notice attachments can be removed, so the limit of five is a partial
  unique** (WHALEERP-272, 2026-10-19 재영; 운영 정책 CNT-18 v144,
  `20261019171114_team3_post_attachments_file_type`). `post_attachments` gained
  `file_type` (the same `attachment_file_type` enum — not a second type) and
  `sort_order` lost its default 0: it is now a slot, 1–5 by CHECK, unique per
  post among rows with `is_deleted = false`. Unlike inquiry attachments these
  are added and removed when a notice is edited, and a removed one is only
  marked deleted, so a plain (`post_id`, `sort_order`) unique would block
  reusing a removed one's slot — hence the `WHERE "is_deleted" = false`. Display
  order is `post_attachment_id`, not the slot. The migration refuses to run if
  `post_attachments` already has rows (no API wrote them before; `file_type` is
  NOT NULL with nothing to fill it). FAQ attachments are refused by the api, not
  the schema. Prisma cannot express the partial unique; it is SQL-only and does
  not show in `prisma migrate diff`.
- **Notifications carry their own title** (NOTIFY-12, 2026-10-13 재영).
  `notifications.title` (NOT NULL) holds the template title as rendered when the
  notification was made, `body` the second line; the inbox list and the bell
  popover show the title (`20261013144718_team3_notification_title`). The table
  had no rows when the column was added, so it has no default.
- **The business side decides where a notification leads** (NOTIFY-16,
  2026-10-13 재영). `notifications.link` (nullable) is the 관리자 웹 path the
  caller of `notify` passes; CHECK `link_internal_path` keeps it inside the web
  (starts with `/`, not `//`, no backslash or whitespace)
  (`20261013150113_team3_notification_link`).
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
- **`notifications` points at its 업무 the same way, and is looked up by it**
  (2026-10-15). `related_type` · `related_id` have no foreign key, so deleting
  or purging a 도입문의 finds its 운영 알림 by that pair (`deleteLeadNotifications`,
  CNT-11). Index `notifications_related_type_related_id_idx`
  (`20261015104957_team3_notification_related_index`) keeps that from scanning the
  whole table. `leads_created_at_idx` (`20261015164900_team3_lead_created_at_index`)
  does the same for the 접수 확인 메일 hourly cap, which counts the last hour's
  도입문의 on every intake. Both were added to `_model.py` with only their line
  copied into the generated files. Re-running `_build_physical.py` (2026-10-15)
  rewrites `docs/raw/2026-10-06-3팀-schema.sql` with `inquiries.processing_started_*`
  twice, reorders some CHECKs and column comments, and on a Windows console dies at
  its closing Korean `print` (cp949); `_build_prisma.py` then carries the duplicate
  fields into `schema.prisma`, which fails validation. Until the duplicate is fixed
  in `_model.py`, copy lines by hand.
- **`leads.created_at` is filled by the database, not by Prisma** (2026-10-15,
  api #50 리뷰). Prisma 7 evaluates `@default(now())` in the app process
  (`new Date`) and sends the value, so the DDL's `DEFAULT CURRENT_TIMESTAMP` never
  runs for rows written through Prisma. The 도입문의 10-minute repeat check and the
  hourly mail cap count against DB `now()`, so this one column is
  `@default(dbgenerated("now()"))` — `_model.py`'s `DB_CLOCK` set, which
  `_build_prisma.py` reads. `dbgenerated` is the only way to make Prisma leave the
  column to the database, and Prisma always reads it as different from the
  database's `now()` default — whatever the string inside — so every
  `migrate diff` shows one no-op `ALTER TABLE "leads" ALTER COLUMN "created_at"
  SET DEFAULT now();`. That line is an intended difference, not drift to fix
  (api #55 재리뷰; switching the column to `transaction_timestamp()` would hide it
  at the cost of a migration, and was not taken). No migration: the column default was already
  `CURRENT_TIMESTAMP`. Every other `created_at` is still the app clock.
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
- **Templates carry their own default copy** (NOTIFY-17 · 18, 2026-10-13 재영).
  `default_title` · `default_body` · `default_variables` hold the copy the 40
  seeded templates had when nobody had edited them yet
  (`20261013153521_team3_notification_template_defaults` copied it and checks
  the count is 40; the 41st, `EMAIL_LEAD_REPLY`, fills its own in its INSERT). 「기본 문구로 되돌리기」 puts back title, body and variable
  list only — code, name, channel and on/off stay. A template an operator
  registers has no defaults and so no restore. CHECK `defaults_together`: body
  and variables are both there or both absent, and the title is absent when the
  body is.
- **The physical generator stops on a column listed twice in one table.**
  It used to pass with zero errors while emitting a `CREATE TABLE` PostgreSQL
  rejects — what happens when the logical catalog gains a column that
  `_model.ADD` was still adding. The self-check only reported it and the files
  were still written, so `transform` now exits before writing anything; move
  the physical remark to `_model.NOTE` and drop the `ADD` entry (2026-10-21:
  `post_attachments.file_type`, `inquiries` and `leads` processing · reply
  columns, `leads.updated_at`). Unique index names can be set in
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
[^prisma-schema]: Prisma 스키마 (3팀 48개 + 1팀 27개)
[^email-change-pins]: 이메일 변경 핀 테이블 (WHALEERP-191)
[^auth-session-remember-me]: 접속 상태의 자동 로그인 칸 (끄면 7일)
[^account-status-migration]: 계정 상태에 탈퇴를 더하는 마이그레이션 (2026-10-07)
