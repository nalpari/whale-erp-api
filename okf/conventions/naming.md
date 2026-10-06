---
type: Reference
title: Naming conventions
description: One Korean term maps to one English identifier across the three repositories; per-layer casing follows from that.
tags: [naming, conventions, database, api, glossary]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-06T01:27:00Z }
verified: { by: human:jaeyoung, at: 2026-10-02T05:18:35Z }
sources:
  - id: naming-raw
    resource: ../../docs/raw/2026-09-30-네이밍-규칙.md
    title: 네이밍 규칙 원자료 (3팀 기획 세션, 2026-10-06 고침)
    last_modified: 2026-10-06T00:00:00Z
---

# Status

**Settled.** 재영 confirmed the whole document (sections 1–5) on 2026-10-01.
New tables, APIs, and types follow it, and review enforces it. The `items`
example is the one known exception — see below.

The 1팀 additions of 2026-10-02 (identifier exceptions and the 인증·계정, BP·점포,
설정·시스템관리 tables) come from 1팀's logical ERD (`docs/erd/team1/README.md`)
and its 2026-09-29·30 decisions. They are 1팀's call and not subject to 재영's
confirmation (재영, 2026-10-02) — so their absence from the confirmation line is
by design, not a gap.

# Why this exists

Three repositories name the same concepts: `whale-erp-api`, `whale-erp-front`
(관리자 웹), and `whale-erp-staff` (직원 근무 앱). The Korean side is settled in the
shared glossary (`whale-erp-v2/CLAUDE.md`); this concept holds the **English
identifier** for each 표준 표기, so one thing is not `employee` here and
`staff_member` there.[^naming-raw]

One identifier per term, and the layers share its root:

```
attendance_records  ↔  attendanceRecord  ↔  /attendance-records  ↔  AttendanceRecord
     DB 테이블              JSON·필드              URL 경로              모델·타입
```

Casing then follows each ecosystem — `snake_case` in the database, `camelCase` in
JSON and TypeScript, `kebab-case` in URLs and filenames. Prisma's `@map` /
`@@map` does the conversion, which is why the database keeps its own spelling
without leaking it into responses.

**No abbreviations.** Not `emp`, `ctr`, `att`. The only exceptions are `id`, `url`,
`bp`, `hq`, `faq`, `todo`, `rrn` (주민등록번호), `biz` (사업자), `ceo` (대표자), and `admin` (관리자).

A new concept gets its Korean 표준 표기 into the glossary first, then a row here.

# Where this repository already disagrees

The rules describe where the code is going, not where it is. Five places in
`whale-erp-api` do not match today, and `items` is the module the bundle points at
as the worked example — so copying it now propagates the mismatch.

| Rule | Code today |
|---|---|
| List response is `{ items, total }` | `GET /items` returns a bare array (`ItemResponseDto[]`) — no `total` |
| Paging is `page` · `pageSize` | `ListItemsQueryDto` uses `take` · `skip` |
| 계정 is `account`, 직원 레코드 is `staff_member` | `staff` is the template's auth subject, unrelated to 직원 레코드 |
| Primary key is `{참조 단수}_id` | `items`, `stock_movements`, `staff`, `customers` all use `id` |
| 관리자 계정 is `admin_accounts` (PK `admin_account_id`) | `customers` holds 관리자 웹 logins (`POST /auth/customer/login`) |

The `staff` row is already flagged in the source: the table is to be sorted out
when the 계정 table is built. The primary-key row is not a defect either — all
four tables are the example (`items`, `stock_movements`) and the template's auth
subject (`staff`, `customers`), not domain tables anyone has to keep. The
`customers` row is the same story from 1팀's side: the source renames it to
`admin_accounts` because the name was inherited from the boilerplate's auth
scaffold and no WHALE ERP data is tied to it yet — the same treatment 3팀 gave
`staff`. The code, routes, and `user:create customer` still say `customers`. They are
replaced or cleaned up together with the 계정 table and the first domain module,
not renamed in place: `whale-erp-front`'s `listItems` and the login routes still
use them.

The first two are live API contract decisions, and **`/items` already has a
caller**: `whale-erp-front`'s `listItems` (`src/lib/api.ts:145`) requests
`/items?take=` and reads the response as `Item[]`, used by
`src/app/items/page.tsx`. Either change breaks that page, and the parameter
breaks it hard — the global `ValidationPipe` runs with
`forbidNonWhitelisted: true`, so dropping `take` from the DTO turns every
existing list request into a 400 rather than a quietly ignored parameter.
Aligning `/items` therefore cannot be done from this repository alone.

**Decision (2026-09-30): `items` is left as it is.** It is the example, not a
module whose correctness anything depends on, and aligning it would mean
changing `whale-erp-front` in the same breath. The first *real* domain module is
built to these rules instead, and that module becomes the new worked example.
The rows above therefore stay — they describe the example, not a defect queue.
The error-format row is gone for a different reason: the rule changed to keep
Nest's `{ statusCode, message, error }`, so the code was never wrong there.

One thing to carry when that happens: `okf/index.md` still points at
[Items API](/api/items-api.md) as the shape to copy. That pointer moves to the
new module, or the next person copies the mismatch on purpose.

What the code **does** already follow: CHECK constraint names
(`items_sku_not_blank`), index names (`stock_movements_item_id_idx`), module
folders (`src/items/`), and DTO filenames (`create-item.dto.ts`,
`item.response.dto.ts`).

# DB (PostgreSQL + Prisma)

| 대상 | 규칙 | 예 |
|---|---|---|
| 테이블 | snake_case 복수형 | `contracts`, `attendance_records`, `location_access_logs` |
| Prisma 모델 | PascalCase 단수형 + `@@map` | `model Contract { … @@map("contracts") }` |
| 컬럼 | snake_case, Prisma 필드는 camelCase + `@map` | `start_date` ↔ `startDate` |
| 기본키 · 외래키 | `{참조 단수}_id` · `{참조 단수}_id` (기본키도 같은 이름) | `contracts.contract_id`, `staff_members.staff_member_id`, 외래키 `store_id` |
| 역할 외래키 | 사람(관리자)을 가리키는 외래키는 역할을 이름으로 `{역할}_by`. 한 테이블에 관리자 외래키가 여럿일 수 있어서다 (2026-10-06 재영) | `created_by`, `reviewed_by`, `confirmed_by` |
| 시각 | `_at`, `timestamptz` | `signed_at`, `reviewed_at`, `created_at` |
| 날짜만 | `_date` | `start_date`, `birth_date` |
| 참·거짓 | `is_` · `has_` | `is_proxy_entry`, `is_premium_applied` |
| 삭제 표시 | `is_deleted boolean NOT NULL DEFAULT false`. 삭제가 가능한 테이블에만 둔다 | `contracts.is_deleted` |
| 금액 | `_amount`, 원 단위 정수 | `base_pay_amount` |
| 길이 · 단위 | 단위를 이름 끝에 | `break_minutes`, `radius_m` |
| 상태 값 | Prisma enum, 값은 UPPER_SNAKE | `ContractStatus.PENDING_SIGNATURE` |
| 이력 | 변경 전후는 `_histories`, 사건 기록은 `_logs` | `contract_status_histories`, `payslip_logs` |
| 인덱스 · 키 | `{table}_{cols}_{idx·key·fkey}` | `stock_movements_item_id_idx` |
| CHECK 제약 | `{table}_{col}_{조건}` | `items_sku_not_blank`, `payslip_items_amount_nonzero` |

CHECK constraint names matter more here than elsewhere: they only exist in
migration SQL, never in `schema.prisma`, so the name is the only handle anyone
has on them.

## Deletion is a flag, and only where deletion is allowed

A row that can be deleted is never `DELETE`d; it gets `is_deleted = true`.
Deleted rows are excluded by `is_deleted = false`, not by `deleted_at IS NULL` —
there is one deletion marker, so a row cannot be half-deleted (flag set, time
missing, or the reverse). When the time of deletion becomes a real need, add
`deleted_at` alongside and tie the two with a CHECK constraint.

**The column is a statement about the table.** Tables whose rows must survive —
`stock_movements` and every `*_logs` / `*_histories` table — do not get it. They
are the evidence behind numbers already reported, and a column saying "this can
be deleted" would invite exactly that. A table without `is_deleted` is one
nothing should remove.

Two consequences come with the flag, and both bite silently:

- **Every read must filter `is_deleted = false`.** Forgetting it does not fail;
  it returns deleted rows as if they were live. List queries, lookups by id,
  `count` for `total`, and existence checks before an insert all need it.
- **Unique constraints have to ignore deleted rows.** A plain unique index on
  `sku` or `email` keeps holding the value after deletion, so re-creating the
  same `sku` fails with 409. Use a partial unique index —
  `CREATE UNIQUE INDEX … ON items (sku) WHERE NOT is_deleted` — which Prisma's
  schema language cannot express. Like CHECK constraints, it lives only in
  migration SQL and disappears from `schema.prisma` on `db:pull`.

## Primary keys are named after the table

From the first new table on, the primary key takes the same name every foreign
key to it will carry: `contracts.contract_id`, referenced as
`work_schedules.contract_id`. The column means the same thing on both sides of a
join, so it is spelled the same on both sides.

The one exception is a foreign key to a person (an 관리자 계정). It is named for
the role — `created_by`, `reviewed_by`, `confirmed_by` — because one table can
point at several 관리자 at once, and `admin_account_id` could only name one of
them. Reading such a column, the join target is `admin_accounts`, not something
named `created`.

Through the other layers this is mechanical: the Prisma field is
`contractId Int @id @default(autoincrement()) @map("contract_id")`, and the JSON
field is `contractId` by the camelCase rule above — responses for new resources
carry `contractId`, not `id`.

## Identifier exceptions (1팀)

Deliberate departures from the table above. Two of them override rules stated
there — the composite and code-named primary keys override 「기본키」, and
공통코드 values override 「상태 값」: they are `code_items` rows, not Prisma enums.

| 대상 | 1팀 규칙 | 이유 |
|---|---|---|
| 공통코드 기본키 | `code_groups`는 `group_code`, `code_items`는 (`group_code`, `item_code`, `bp_code`) 복합 PK | 코드 자체가 식별자다. 셋 다 필수이고 등록 뒤 바꾸지 않는다 |
| BP 기본키 | `bp_codes`는 PK `bp_code_id` 와 별도로 `bp_code`(BP+6자리)를 고유 식별자로 쓴다 | 외부 노출·화면 표기는 `bp_code` 다 |
| 사람이 읽는 코드 | `{자원}_code` + 접두 6자리 | `bp_code`(BP), `store_code`(ST), `menu_code`(MN), `role_code`(유형코드, 예 BM000001). 자동 채번, 변경 불가 |
| 공통코드 값 컬럼 | 논리 타입 `code`, 이름은 `{그룹 코드 소문자}_code` | `role_type_code`, `account_status_code`, `store_type_code`, `manage_owner_code` |
| 상세코드 값 | 영문 대문자·숫자·밑줄 20자, 등록 후 변경 불가 | Prisma enum이 아니라 `code_items` 행이다 — 2장의 「상태 값」 규칙을 쓰지 않는다 |

ERD names that mix singular and plural (`attendance`, `schedule_history`) get
pluralised at the next ERD regeneration.

# API (NestJS)

| 대상 | 규칙 | 예 |
|---|---|---|
| 경로 | kebab-case 복수 명사, 동사 금지 | `GET /staff-members/:id/contracts` |
| 상태를 바꾸는 동작 | 하위 경로 + POST | `POST /contracts/:id/resend`, `POST /payslips/:id/cancel-confirmation` |
| 쿼리 파라미터 | camelCase | `?storeId=3&from=2026-09-01` |
| JSON 필드 | camelCase, DB 컬럼명을 그대로 노출하지 않음 | `{ startDate, isProxyEntry }` |
| 모듈 폴더 | 자원 복수 kebab | `src/payslips/`, `src/staff-members/` |
| 파일 | `{자원}.{역할}.ts` | `payslips.service.ts` |
| DTO | 파일 `create-payslip.dto.ts` · 클래스 `CreatePayslipDto` | 응답 `payslip.response.dto.ts` · `PayslipResponseDto` |

The DTO filename rule is not cosmetic: the Swagger CLI plugin only reads files
ending `.dto.ts` or `.entity.ts`, so a response class named anything else gets no
schema at all.

<a id="api-list-responses"></a>

## API list responses

The one part of this document 재영 has confirmed (2026-10-01).

| 항목 | 규칙 |
|---|---|
| 목록 응답 | `{ items, total }` |
| total 구하기 | `findMany` + `count` — 같은 `where`, `$transaction` 으로 묶는다 |
| 페이지 파라미터 | `page`(1부터), `pageSize`(기본 20, 최대 200) |
| 정렬 | 기본 정렬 + 마지막에 `id` |
| 빈 결과 · 마지막 페이지를 넘긴 요청 | `{ items: [], total }` |
| 오류 응답 | Nest 기본 `{ statusCode, message, error }` 유지 |

Three of these carry a trap worth naming.

**`$transaction` does not pin a snapshot.** It sends both queries over one
connection, but under PostgreSQL's default READ COMMITTED each statement still
reads its own snapshot, so a row inserted or deleted between them can leave the
page and `total` off by one. List screens accept that; pinning both to one
snapshot would need `isolationLevel: 'RepeatableRead'`, which this rule does not
ask for. What does matter is the same `where` on both, or `total` counts a
different set than the page shows.

**`id` last in the sort order** is what makes paging stable. Ordering by a
non-unique column alone (a date, a name) leaves rows with equal values in an
undefined order, so the same row can appear on page 1 and again on page 2 while
another is never shown. Appending `id` breaks every tie the same way each time.

**Going past the last page returns `{ items: [], total }`, not a 404.** An empty
page is a valid answer to a valid question, and `total` is the only thing telling
the caller how far it overshot.

The source adds the exception directly: 기존 items 예제(`take`·`skip`, 배열 응답)는
front 가 지금 형식으로 부르고 있어 바꾸지 않고, 새로 만드는 목록 API 부터 적용한다.

# FRONT (Next.js)

Recorded here because the API's route and resource names are what the two
frontends mirror; the frontends are not this repository's code.

| 대상 | 규칙 | 예 |
|---|---|---|
| 라우트 폴더 | kebab-case 영문, API 자원 이름과 같게 | `app/staff-members/[id]/contracts/new/` |
| 파일 | kebab-case | `contract-form.tsx`, `use-payslips.ts` |
| 컴포넌트 | PascalCase | `ContractForm`, `PayslipStatusBadge` |
| 훅 | `use` + 명사 | `usePayslips`, `useStoreScope` |
| API 함수 · 서버 액션 | 동사 + 자원 | `getPayslips`, `createContract`, `resendContract` |
| 이벤트 핸들러 | `handle` 접두 | `handleSubmit`, `handleProxyEntryClick` |
| 쿼리 키 | `[자원, 범위, 조건]` | `['payslips', 'list', { storeId, month }]` |
| 타입 | 자원 PascalCase 단수, enum은 API 값 그대로 | `Payslip`, `PayslipStatus` |
| 화면 문구 | enum → 한글 대응표 한 곳에 | `PAYSLIP_STATUS_LABEL.CONFIRMED = '확정'` |

# 영문 식별자 대응표

새 테이블·API·타입은 이 이름을 쓴다.

DB 테이블은 복수형, 모델·타입은 PascalCase 단수형으로 바꿔 쓴다.

## 사람 · 조직

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 플랫폼 마스터 / 플랫폼 관리자 | `PM` / `PA` | 공통코드 `ROLE_TYPE` 의 상세코드. DB 저장값이자 화면 표시값이고, `role_groups.role_code` 의 2글자 접두로도 쓴다(`PM000001`). `role_code` CHECK 제약이 `^[A-Z]{2}[0-9]{6}$` 라 2글자가 아니면 저장되지 않는다 |
| BP 마스터 / BP 관리자 | `BM` / `BA` | 같은 공통코드. `BM000001` · `BA000001` |
| 가맹마스터 / 가맹관리자 | `FM` / `FA` | 같은 공통코드. `FM000001` · `FA000001` |
| BP | `bp` | |
| 관리자 계정 | `admin_account` | 관리자 웹 로그인 주체. 아래 「인증 · 계정」 참고 |
| 본사 | `hq` | |
| 점포 · 근무지 | `store` | 근무지는 직원 레코드의 `store_id` |
| 직영 / 가맹 | `DIRECT` / `FRANCHISE` | `store_type` |
| 계정 | `account` | 로그인 주체. 기존 `staff` 테이블과 다른 것 — 계정 테이블을 만들 때 `staff`를 정리한다 |
| 직원 레코드 | `staff_member` | 계정 1 : 레코드 N |
| 직무 | `job_title` | 직원 레코드 칸. 근로계약서 초안 필수 |
| 정직원 / 파트타이머 | `FULL_TIME` / `PART_TIME` | `employment_type` |
| 업무 범위 · 범위 선택기 | `scope` · `ScopeSelector` | |

## 채용 · 계약

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 근로계약(서) | `contract` | 초안은 상태 `PENDING_SEND`인 계약 |
| 근로계약 상태 6종 | `PENDING_SEND` · `PENDING_SIGNATURE` · `SIGNED` · `REJECTED` · `EXPIRED` · `ENDED` | 발송 대기 · 서명 대기 · 체결 완료 · 거부 · 만료 · 종료 |
| 전자계약 / 종이 계약 | `ELECTRONIC` / `PAPER` | `contract_method` |
| 임금계약서 | `wage_contract` | 종이 계약에서 따로 날인한 임금 약정 문서 |
| 계약서 파일 구분 | `SENT_ORIGINAL` · `SIGNED_COPY` · `PAPER_EMPLOYMENT_CONTRACT` · `WAGE_CONTRACT` | `contract_documents.kind` — 발송 원본 · 날인 완료본 · 종이 계약 근로계약서 · 임금계약서 |
| 4대보험 가입 여부 | `is_health_pension_insured` · `is_employment_injury_insured` | 근로계약 칸 두 개 — 건강보험·국민연금 / 고용보험·산재보험 |
| 날인 · 필기 서명 · 날인 기한 | `sign` · `handwritten_signature` · `sign_deadline_at` | |
| 재발송 | `resend` | |
| 초대 · 초대 토큰 | `invitation` · `invitation_token` | |
| 초대 유형 4종 | `SIGNUP` · `REINVITE` · `AFFILIATION_CONFIRM` · `RETURN_CONFIRM` | 가입 초대 · 재초대 · 소속 추가 확인 · 복귀 확인 |
| 가입 불가(만 19세 미만) | `REJECTED_UNDER_AGE` | 초대 상태 값 |
| 연결 보류 · 가입 연결 확인 | `link_hold` · `approve_link` | |
| 본인인증 | `identity_verification` | |
| 신고 정보 | `tax_profile` | |
| 주민등록번호 · 급여 계좌 | `rrn` · `payroll_account` | |
| 주휴일 | `weekly_holiday` | 요일 값 |

## 근무 · 출퇴근

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 근무스케줄 | `work_schedule` | |
| 출퇴근 기록 · 출퇴근 현황 | `attendance_record` · `attendance` | 현황은 화면·경로 이름 |
| 출근 / 퇴근 | `CHECK_IN` / `CHECK_OUT` | |
| 보정 | `correction` | |
| 대신 등록 | `proxy_entry` | `entry_method = PROXY` |
| 확인 필요 · 사유 | `needs_review` · `review_reason` | |
| 사유 3종 | `ACCURACY_EXCEEDED` · `OUT_OF_RADIUS_CHECKOUT` · `MOCK_LOCATION` | 위치 오차 초과 · 반경 밖 퇴근 · 위치 조작 감지 |
| 이상 없음 | `mark_reviewed` | 검토만 마치고 값은 그대로 |
| 근무지 반경 | `radius_m` | |
| 위치정보 동의 · 일시 중지 | `location_consent` · `paused_at` | |
| 확인자료 | `location_access_log` | |
| 본사 제공 동의 | `hq_sharing_consent` | |
| 약관·동의 문구 버전 | `terms_version` · `consent_version` | |
| TO-DO | `todo` | |
| 배정 대상 · 수행 방식 | `assignee` · `execution_mode` (`EACH` / `ANY_ONE`) | 각자 수행 / 한 명 수행 |
| 수행 예정 일시 · 긴급 | `due_date` · `due_time` · `is_urgent` | |
| TO-DO 상태 | `PENDING` · `IN_PROGRESS` · `DONE` | 대기 · 진행 중 · 완료 |

## 급여

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 급여명세서 | `payslip` | |
| 상태 4종 | `DRAFTING` · `REVIEWING` · `CONFIRMED` · `SENT` | 작성 중 · 검토 중 · 확정 · 발송 완료 |
| 확정 취소 · 처리 이력 | `cancel_confirmation` · `payslip_log` | |
| 검토 대기 사유 4종 | `MISSING_ATTENDANCE` · `AFTER_CONTRACT_END` · `CONTRACT_CHANGED` · `DEDUCTION_MISSING` | |
| 지급 항목 / 공제 항목 | `earning` / `deduction` | 줄 하나는 `payslip_item` |
| 기본 공제 / 추가 공제 | `BASIC` / `ADDITIONAL` | |
| 비과세 | `is_tax_free` | |
| 3.3% 원천징수 | `business_income_withholding` | 적용 여부 `is_withholding_applied` |
| 연장·야간·휴일 가산 적용 여부 | `is_premium_applied` | |
| 주휴수당 · 연장수당 | `weekly_holiday_pay` · `overtime_pay` | 항목 코드 |
| 일괄 저장 | `bulk_export` | |

## 고객지원 · 알림

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 공지사항 · FAQ · 문의사항 · 도입문의 | `notice` · `faq` · `inquiry` · `lead` | |
| 노출 대상 | `audience` | |
| 게시 상태 | `PUBLISHED` · `DRAFT` · `PRIVATE` | 게시 · 임시저장 · 비공개 |
| 문의 답변 상태 | `RECEIVED` · `IN_PROGRESS` · `ANSWERED` | 접수 · 처리중 · 답변완료 |
| 운영 알림 · 앱 푸시 | `notification` · `push` | |

## 인증 · 계정

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 관리자 계정 | `admin_account` · 테이블 `admin_accounts` | 관리자 웹 로그인 주체. 3팀 `accounts`(직원 앱 계정)·`staff_members`(직원 레코드)와 다른 테이블이다. PK·FK 는 `admin_account_id` — 3팀 ERD 가 쓰던 `admin_id` 도 같이 맞췄다 |
| 관리자 로그인ID | `login_id` | 영문·숫자 4~20자, 탈퇴·삭제 포함 고유, 변경 불가 |
| 권한 유형 | `role_type_code` | 공통코드 `ROLE_TYPE` 6종. 등록 뒤 변경 불가 |
| 계정 상태 | `account_status_code` | 공통코드 `ACCOUNT_STATUS`(사용 · 미사용 · 탈퇴) |
| 가입경로 | `join_path_code` | 공통코드 `JOIN_PATH`(회원가입 · 플랫폼등록). 모든 계정 필수, 변경 불가 |
| 탈퇴 사유 | `withdraw_reason_code` · `withdraw_reason_detail` | 공통코드 `WITHDRAW_REASON`(`WD_CLOSE` 등). 직접입력은 500자 |
| 관리 점포 범위 | `is_all_stores` | true면 소속 BP 전체 점포, false면 `admin_store_mappings` 의 점포 |
| 관리자 점포 매핑 | `admin_store_mapping` | (`admin_account_id`, `store_id`) 복합 PK |
| 약관 버전 · 약관 유형 | `terms_version` · `terms_type_code` | 공통코드 `TERMS_TYPE` 6종(`TERMS_SERVICE` · `PRIVACY_COLLECT` BP 회원가입용, `STAFF_TERMS_SERVICE` · `STAFF_PRIVACY` 직원 앱 회원가입용, `MARKETING` · `LOCATION`) |
| 약관 동의 이력 | `terms_agreement_log` | 동의 경로 `channel`(회원가입 · 최초 로그인 · 재동의 · 약관변경) |
| 관리자 접속 상태 | `admin_session` | 접근 토큰 1시간, 갱신 토큰은 마지막 사용 후 1시간 |
| 임시 비밀번호 | `temp_password` | 발급 용도 `purpose`(임시비밀번호 · 초기비밀번호 · 비밀번호초기화), 모두 1시간 만료 |
| 관리자 로그인 이력 | `admin_login_log` | 실패 사유 `failure_reason`(불일치 · 잠금 · 미사용 · 탈퇴). 보존 1년 |
| 메일 발송 이력 · 메일 유형 | `mail_send_log` · `mail_type_code` | 공통코드 `MAIL_TYPE` 8종. 보존 1년 |
| 관리자 변경 이력 | `admin_change_history` | 보존 5년 |

The `admin_session` lifetimes above (access 1 hour, refresh 1 hour after last
use) are not what the api issues today: `src/auth/auth.service.ts` signs access
tokens for 15 minutes and refresh tokens for 7 days, for both clients. 직원 근무 앱
keeps a login for 30 days after last use (2026-09-17). **The three stay
different — not something to align (재영, 2026-10-02).** Do not "fix" one to
match another.

## BP · 점포

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| BP | `bp_code` · 테이블 `bp_codes` | PK는 `bp_code_id`, 외부 식별자는 `bp_code`(BP+6자리). 3팀은 참조만 한다 |
| 플랫폼 BP | `is_platform` | `bp_codes` 에 한 행(BP000000)만. 고객 BP 대상 조회·배포·배치·중복검사에서 빠진다 |
| BP 상태 | `account_status_code` | 공통코드 `ACCOUNT_STATUS`. BP 마스터 계정 상태와 같은 트랜잭션에서 함께 바뀐다 |
| 사업자정보 | `biz_` 접두 | `biz_registration_number`, `biz_ceo_name`, `biz_open_date`, `biz_category`, `biz_item`, `biz_verified_at` 등 |
| BP 변경 이력 | `bp_change_history` | 보존 5년 |
| 점포 | `store` · `store_code` | 점포코드는 ST+6자리, 자동 채번, 변경 불가 |
| 점포 유형 | `store_type_code` | 공통코드 `STORE_TYPE`(`DIRECT` 직영점포 · `FRANCHISE` 가맹점포), 변경 불가 |
| 점포 상태 | `store_status_code` | 공통코드 `STORE_STATUS`(미운영 · 운영 · 폐점) |
| 점포 층별정보 · 층수 구분 | `store_floor` · `floor_type_code` | 공통코드 `FLOOR_TYPE`(`GROUND` 지상 · `BASEMENT` 지하) |
| 점포 대표 이미지 | `store_image_file` | |
| 점포 사업자정보 | `store_business_profile` | 테이블 이름은 `info` 로 줄이지 않는다. 컬럼은 BP 사업자정보와 같은 `biz_` 접두 |
| 점포 변경 이력 | `store_change_history` | 보존 5년 |

## 설정 · 시스템관리

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 권한 그룹 · 권한 코드 | `role_group` · `role_code` | 유형코드+6자리(`BM000001` 등), 고유, 변경 불가 |
| 권한 메뉴 | `role_group_menu` | 메뉴별 CRUD 권한 |
| 공통코드 그룹 | `code_group` · `group_code` | 대문자 밑줄(예 `EMP_TYPE`). 삭제한 그룹의 코드도 다시 쓰지 않는다 |
| 상세 코드 | `code_item` · `item_code` · `label` | 플랫폼 원본 행과 BP별 행을 한 테이블에 담는다 |
| 관리 주체 | `manage_owner_code` | 공통코드 `MANAGE_OWNER`(플랫폼고정 · 플랫폼제공 · BP전용). 등록 뒤 변경 불가 |
| BP 적용 여부 | `is_bp_applied` | 플랫폼제공 그룹만. 적용으로 바꾸면 사용 중 모든 BP에 복사되고 되돌릴 수 없다 |
| 메뉴 · 메뉴 코드 | `menu` · `menu_code` | MN+6자리, 자동 채번, 변경 불가. 최대 3단계(`parent_menu_id`, `depth`) |
| 서비스 | `service_code` | 공통코드 `SERVICE`. 플랫폼고정 그룹이다 |
| BP 휴일 | `bp_holiday` | 규칙을 한 줄로 저장하고 실제 날짜는 볼 때 계산한다 |
| 휴일 유형 | `holiday_type_code` | 공통코드 `HOLIDAY_TYPE`(`DAY` 하루 · `PERIOD` 기간 · `REPEAT` 반복) |
| 휴일 반복 유형 | `holiday_repeat_type_code` | 공통코드 `HOLIDAY_REPEAT_TYPE`(`DAILY` · `WEEKLY` · `MONTHLY` · `YEARLY`) |
| 반복 종료 조건 | `repeat_end_type` · `repeat_end_date` · `repeat_count` | 없음 · 날짜 · 횟수 |
| 휴일 적용 범위 | `is_all_stores` | 관리자 계정의 관리 점포 범위와 같은 이름을 쓴다 |
| 휴일 점포 매핑 · 예외 점포 | `holiday_store_mapping` · `holiday_excluded_store` | 예외는 `effective_start_date` 부터 적용해 지난 날짜를 보존한다 |
| 플랫폼 공식 휴일 | `public_holiday` | 출처 `source`(규칙 계산 · 공식 API) |
| 공식 휴일 동기화 이력 | `public_holiday_synchronization_log` | |
| BP 휴일 변경 이력 | `bp_holiday_change_history` | 보존 5년 |

# Changing it

The source of this document is the 기획 세션's, and it is **one file edited in
place**: `docs/raw/2026-09-30-네이밍-규칙.md`, kept identical in all three
repositories. The date in its name is when it was created, not its version — each
change adds a 「고침」 line to its header instead. When it changes, each repository
re-runs `/okf-ingest`, and this concept's `sources[].last_modified` moves with it.

Because the file keeps its name, a concept that has not been re-ingested looks
current from the file listing alone. Compare the source's 「고침」 lines with
`okf/log.md` rather than trusting that the filename is the latest.

[^naming-raw]: 네이밍 규칙 원자료 (3팀 기획 세션, 2026-10-06 고침)
