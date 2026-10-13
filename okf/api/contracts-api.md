---
type: API Endpoint
title: Contracts API
description: GET /contracts (list), POST /contracts (근로계약서 초안 저장), GET · PUT /contracts/:contractId (상세 · 임시저장 이어 쓰기), DELETE /contracts/:contractId (임시저장 삭제), plus GET /stores for the 근무지 choice; admin tokens only.
tags: [api, contracts, nestjs, prisma]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-08T02:00:00Z }
sources:
  - id: contracts-controller
    resource: ../../src/contracts/contracts.controller.ts
    title: ContractsController
    last_modified: 2026-10-08T00:00:00Z
  - id: contracts-service
    resource: ../../src/contracts/contracts.service.ts
    title: ContractsService
    last_modified: 2026-10-08T00:00:00Z
  - id: list-query
    resource: ../../src/contracts/dto/list-contracts-query.dto.ts
    title: ListContractsQueryDto
    last_modified: 2026-10-08T00:00:00Z
  - id: create-dto
    resource: ../../src/contracts/dto/create-contract.dto.ts
    title: CreateContractDto
    last_modified: 2026-10-08T02:00:00Z
  - id: stores-service
    resource: ../../src/stores/stores.service.ts
    title: StoresService (근무지 선택지)
    last_modified: 2026-10-08T02:00:00Z
---

# What it is

`GET /contracts` returns `{ items, total }` per the list rules in
[Naming conventions](/conventions/naming.md): `page` (from 1), `pageSize`
(default 20, max 200), newest `created_at` first with `contract_id` as the
tie-breaker. Filters: `status` (repeatable — `?status=SIGNED&status=REJECTED`),
`storeName` and `staffMemberName` (case-insensitive substring).[^contracts-service]

It is the first domain module after the samples were removed, so it is the
worked example `okf/index.md` used to lack.

# Traps

- **Admin tokens only, and nobody can get one yet.** The controller carries
  `@UserTypes('admin')`; 직원 근무 앱 tokens get 403. Until 1팀's login lands
  every call is 401 — `test/contracts.e2e-spec.ts` signs its own tokens.
  The 관리자 업무 범위 (BP · 점포) is **not** applied: any admin token sees every
  BP's contracts. Add the scope filter together with the login.[^contracts-controller]
- **Store names cost a second query.** `stores` is 1팀's table and has no
  Prisma relation to `contracts`, so `include` cannot reach it. A `storeName`
  filter first looks up matching `store_id`s (no match → `storeId: { in: [] }`,
  an empty page, not an error); names for the page are read in one
  `store.findMany` over the page's ids.
- **`status` arrives as a string when there is one.** The query parser only
  makes an array for repeated keys; the DTO's `@Transform` wraps a single value
  so `@IsEnum({ each: true })` sees an array.[^list-query]
- **`wageAmount` means 월급 or 시급 by `employmentType`.** There is no wage-type
  column — see [Team 3 physical schema](/domain/team3-physical-schema.md).
- Dates (`startDate`, `endDate`) go out as `YYYY-MM-DD`; timestamps as ISO 8601.

# Saving a draft: POST /contracts

One nested `staffMember.create` writes the 미가입 직원 레코드 (`join_status =
DRAFT`), the contract (`PENDING_SEND`), `contract_parties` (entered name ·
phone · birth date), one `contract_work_days` row per weekday, and the first
`contract_status_histories` row (`actor = ADMIN`). With `isTemporarySave: true`
the contract and that first row are 임시저장 (`DRAFT`) instead of 발송 대기; nothing
else differs yet, since neither sends an invitation.

**임시저장 needs only the 직원 레코드 칸 and the store.** `contracts` keeps NOT
NULL on its keys only, so with `isTemporarySave` every contract field may be
left out and is stored as NULL; a value that *is* sent is validated the same
way (a 만 19세 check runs once both dates are present). `name` · `phone` ·
`jobTitle` · `employmentType` · `storeId` stay required because
`staff_members` still has NOT NULL on them. The list response types the
contract fields as nullable for the same reason. `workLocation` (근무 장소,
≤ 200 chars) is optional on both. A nested write is one
statement batch, so a failure leaves nothing behind. `created_by` is the
token's `sub`. Returns `201 { contractId, staffMemberId }`.[^create-dto]

What it refuses, before writing:

- **400** — 만 19세 미만 on the contract start date (운영 정책 ACC-22; birthday
  counts), end before start, the same weekday twice, a shift that ends before
  it starts, a break given on one side only or outside the shift, 주휴일 on a
  working day, times off the 30-minute grid, `contractMethod: PAPER`.
- **404** — the store is missing, deleted, or `CLOSED`.
- **409** — someone with the same phone is already `EMPLOYED` at that store
  (the mockup's 「이 점포 재직 중 → 차단」, decided from records alone).

**주휴일 is not saved for now** (2026-10-08): `weekly_holiday` is always NULL
until 7-day work is agreed, and the 화면 hides the field. The body has no
`weeklyHoliday` (sending one is a 400). The rule to use afterwards is kept in
`weeklyHolidayOf`, tested but not called: 주 소정근로시간 — end − start −
break, summed — of 15 hours or more gives the last weekday in Mon → Sun order
that is not worked (Mon–Fri → 일, through Sunday → 토); under 15 hours it is
NULL, since 주휴 does not apply (운영 정책 PAY-02). 15 hours or more on all seven
days leaves no day for it — the open question.

**초대 유형 is decided, not sent.** On 초안 저장 (a new `POST`, or a `PUT` that
leaves 임시저장) the newest account with that phone decides it: none → 가입 초대
(`SIGNUP_INVITE`); one with no record at this store → 소속 추가 확인; one with a
retired record there → 복귀 확인 — both put the account in
`staff_members.candidate_account_id`; one still employed there → 409. The result
is `contracts.draft_action` (also in the list response). **No `invitations` row,
token or `join_status = INVITED` is written yet**: those mean "sent" (`sent_at`
is NOT NULL, status starts at `SENT`), and nothing is sent until the 직원 앱
has an accept screen and 알림톡 can carry the link button. 재초대 is not decided
here — an unjoined record with the same phone is already a 409; it belongs to
the 「초대 재발송」 action.

Not done yet, deliberately: 초대 발송, 종이 계약 (needs file storage), 임시저장 (the schema
has no state for it), and 근무 장소 text (no column — the store stands in).

**Dates and times cross as UTC.** `start_date` · `birth_date` are sent as UTC
midnight and `time` columns as `1970-01-01T HH:mm Z`; a local-time `Date`
would shift them by the server's offset. Checked against PostgreSQL (PGlite
with every migration): rows come back `09:00:00`, `1998-07-12`.

# Resuming a 임시저장: GET · PUT /contracts/:contractId

`GET` returns what the 작성 form needs to reopen — 직원 칸 from `staff_members`
(고용 형태 included: the record is the source, the contract holds a copy),
생년월일 from `contract_parties`, the contract fields, and the work days as
`HH:mm` in weekday order. `PUT` takes the same body as `POST` and replaces the
whole form: contract fields not sent become NULL, work days are deleted and
re-created, the party row is upserted. **Only `DRAFT` can be edited**; anything
else is 409. The write is one transaction and the contract update is
conditional on `status = 'DRAFT'`, so a draft submitted by someone else between
the read and the write is not overwritten (zero rows → 409). Sending without
`isTemporarySave` moves it to 발송 대기 and adds a `DRAFT → PENDING_SEND` history
row. The path id goes through `ContractIdPipe`: anything but 1..2147483647 is a
404 before the database is asked.

`GET` also feeds the 상세 screen: `storeName` (read from `stores` separately —
it is a 1팀 table with no Prisma relation; a deleted store still shows its
name), `draftAction`, and `histories` (newest first, ties broken by the later
row id, `changedAt` as ISO 8601).

# Deleting a 임시저장: DELETE /contracts/:contractId

Hard delete, decided 2026-10-12: a 임시저장 was never sent, so there is no
record worth keeping. One transaction removes the work days, the party row, the
status history and the contract, then the staff record **only if** no other
contract points at it and it is still `join_status = DRAFT`. Only `DRAFT` can be
deleted (409 otherwise); the contract delete is conditional on `status =
'DRAFT'`, so a draft submitted between the read and the delete rolls the whole
transaction back as 409. 204 on success, 404 for an unknown id.

# GET /stores

The 근무지 dropdown's source: `{ items: [{ storeId, name }], total }`,
undeleted and not `CLOSED`, by name. Stores are 1팀's; this is a read-only
stand-in to fold into 1팀's store API when it exists, and it has the same
missing-scope gap as the contract list.[^stores-service]

[^create-dto]: CreateContractDto
[^stores-service]: StoresService (근무지 선택지)
[^contracts-controller]: ContractsController
[^contracts-service]: ContractsService
[^list-query]: ListContractsQueryDto
