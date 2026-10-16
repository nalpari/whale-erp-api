---
type: API Endpoint
title: Contracts API
description: GET /contracts (list), POST /contracts (근로계약서 초안 저장), GET · PUT /contracts/:contractId (상세 · 임시저장 이어 쓰기), DELETE /contracts/:contractId (임시저장 삭제), plus GET /stores/options for the 근무지 choice; admin tokens only, filtered by the admin scope. Status changes go through one transition table (contract-status).
tags: [api, contracts, nestjs, prisma]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-16T06:10:00Z }
sources:
  - id: contracts-controller
    resource: ../../src/contracts/contracts.controller.ts
    title: ContractsController
    last_modified: 2026-10-13T03:44:30Z
  - id: contracts-service
    resource: ../../src/contracts/contracts.service.ts
    title: ContractsService
    last_modified: 2026-10-16T04:40:00Z
  - id: contract-duplicates
    resource: ../../src/contracts/contract-duplicates.ts
    title: 계약 중복 검사 (WHALEERP-129)
    last_modified: 2026-10-15T08:30:00Z
  - id: contract-status
    resource: ../../src/contracts/contract-status.ts
    title: 계약 상태 전환 (WHALEERP-151)
    last_modified: 2026-10-14T03:00:00Z
  - id: list-query
    resource: ../../src/contracts/dto/list-contracts-query.dto.ts
    title: ListContractsQueryDto
    last_modified: 2026-10-08T00:00:00Z
  - id: create-dto
    resource: ../../src/contracts/dto/create-contract.dto.ts
    title: CreateContractDto
    last_modified: 2026-10-14T01:00:00Z
  - id: stores-service
    resource: ../../src/stores/stores.service.ts
    title: StoresService (근무지 선택지)
    last_modified: 2026-10-14T08:11:55Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: AdminScopeService
    last_modified: 2026-10-16T06:10:00Z
---

# What it is

`GET /contracts` returns `{ items, total }` per the list rules in
[Naming conventions](/conventions/naming.md): `page` (from 1), `pageSize`
(default 20, max 200), newest `created_at` first with `contract_id` as the
tie-breaker. Filters: `status` (repeatable — `?status=SIGNED&status=REJECTED`),
`storeName` and `staffMemberName` (case-insensitive substring), always inside
the admin scope below.[^contracts-service]

It is the first domain module after the samples were removed, so it is the
worked example `okf/index.md` used to lack.

# Traps

- **Admin tokens only.** The controller carries `@UserTypes('admin')`; 직원 근무 앱
  tokens get 403. Tokens come from 관리자 웹 login ([Admin authentication](/api/admin-auth.md));
  `test/contracts.e2e-spec.ts` stubs the session check instead.[^contracts-controller]
  403 texts are the shared ones in `src/auth/access-messages.ts` — an account that is not
  in use gets 「사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.」.
- **Every call is inside the 관리자 업무 범위** (PR #19 blocker, 2026-10-13 재영),
  through `AdminScopeService` — the same rules as the 직원 목록 and 퇴직 처리.
  A contract counts as out of scope when the admin does not manage its store,
  **or** the admin is 본사 역할 (BM · BA), the store is not 직영, and — for an
  existing contract — its 직원 has not given 본사 제공 동의: a contract is 직원
  개인 정보 (이름 · 번호 · 생년월일 · 임금), so it follows `hidesPersonalData`
  like the staff-level APIs (운영 정책 ATT-30). **A contract whose 직원 is known
  is judged by that 직원's consent; a store with no 직원 yet is judged per store**
  (api #21 review, 2026-10-13 재영) — so the `contract.contractId` the staff list
  hands out on a consented 직원's row opens instead of answering 404. Out of
  scope means: the list leaves those contracts out (at a masked store it keeps
  only consented 직원's contracts, ANDed with the name and status filters),
  `GET` · `PUT` · `DELETE` of such a contract is 404 (as if it did not exist),
  and `POST` to such a store is the same 404 as a missing store — even when a
  consented 직원 works there, since a new contract has no 직원 to consent yet.
  `PUT` checks the current contract by its 직원's consent and, only when the
  store changes, the new store per store. Changing the phone also needs the
  store per store — otherwise an admin who sees the draft only by consent could
  send other numbers and read, from the 409 list (name · period), contracts of
  직원 who did not consent, or close them by 대체; that is 403 「휴대전화번호를
  바꾸려면 점포 직원 관리 권한이 있어야 합니다. 번호를 바꾸지 않았다면 다른 요청이
  먼저 고친 것이니 다시 열어 주세요」 before anything is read (the wording covers a
  number another admin changed after the draft was opened, which looks the same
  here), and a phone changed between that check and the write is 409 (api #49 4th
  review). Even with the phone unchanged, such an admin cannot see or replace a
  contract of **another** staff record at the same store and phone: when the
  duplicate list holds one, it is 403 「이 점포에 같은 번호로 다른 직원의 근로계약이
  있습니다 …」 before the 409 that would show names (5th review — this path opens
  once 본사 제공 동의 is saved). Whether the store still exists and is
  not 폐점 is checked either way — a draft whose store closed after it was saved
  is 404 「근무지 점포를 찾을 수 없습니다」 even when kept at the same store, so
  it cannot move on to 발송 대기 (api #21 재리뷰). An account that is deleted, inactive or unknown gets 403
  on the list (`getManageableStores` is null). 플랫폼 관리자 (PM · PA) manage no
  customer store yet (WHALEERP-301), so they see an empty list.[^admin-scope]
- **Store names cost a second query.** `stores` is 1팀's table and has no
  Prisma relation to `contracts`, so `include` cannot reach it. A `storeName`
  filter first looks up matching `store_id`s (no match → `storeId: { in: [] }`,
  an empty page, not an error); names for the page are read in one
  `store.findMany` over the page's ids.
- **`status` arrives as a string when there is one.** The query parser only
  makes an array for repeated keys; the DTO's `@Transform` wraps a single value
  so `@IsEnum({ each: true })` sees an array.[^list-query]
- **`wageAmount` is always 시급**, whatever the `employmentType` (decided
  2026-10-12 재영). 월급 is computed from hours — see
  [Team 3 physical schema](/domain/team3-physical-schema.md).
- Dates (`startDate`, `endDate`) go out as `YYYY-MM-DD`; timestamps as ISO 8601.

# Saving a draft: POST /contracts

**성별 · 외국인 여부** (WHALEERP-125 「본인 대조」, 2026-10-16). `gender` (`MALE` · `FEMALE`)
is required from 초안 저장 on (임시저장 may leave it out) and `isForeigner` is a
boolean that defaults to `false` (내국인). They are kept in
`contract_parties.entered_gender` · `is_foreigner` (migration
`20261016133630_team3_contract_party_gender_foreigner`; rows made before it are
내국인 with no 성별 — only a 임시저장 can be edited today, so 발송 대기 · 서명 대기 contracts
keep that until the 「날인 전 근로자 정보 수정」 route (WHALEERP-125 · 126) lets the admin fill
them; 본인 대조 is not wired before that). With name · phone · 생년월일 they are what the 직원's own
sign-up values are compared with before 날인 — there is no 본인인증, and a
mismatch never rewrites the contract (ACC-22's 「본인인증 값을 쓴다」 is dropped).

It writes the contract (`PENDING_SEND`), `contract_parties` (entered name ·
phone · birth date · `gender` 남 · 여 · `isForeigner`), one `contract_work_days` row per weekday and the first
`contract_status_histories` row (`actor = ADMIN`), hung on a 직원 레코드: the
newest **not-joined** record at that store with that phone **and the same
name** (trimmed, NFC — `name` is normalized on input) if there is one (its job · 고용 형태 are overwritten with the form's),
otherwise a new
미가입 record (`join_status = DRAFT`) made in the same nested write. Reusing
keeps one record per person per store — before, every draft made another one,
and a later 가입 연결 could have tied one account to two 재직 records. A
different name means the number may have passed to someone else, so that
record is left alone — rewriting it would rename the earlier person and file
their past contracts under the new one. A record that lost its contracts to the
대체 is deleted either way, whether the new contract reuses a record or makes one. With `isTemporarySave: true`
the contract and that first row are 임시저장 (`DRAFT`) instead of 발송 대기; nothing
else differs yet, since neither sends an invitation.

**임시저장 needs only the 직원 레코드 칸 and the store.** `contractMethod` may be
left out too. `contracts` keeps NOT
NULL on its keys only, so with `isTemporarySave` every contract field may be
left out and is stored as NULL; a value that *is* sent is validated the same
way (a 만 19세 check runs once both dates are present). `name` · `phone` ·
`jobTitle` · `employmentType` · `storeId` stay required because
`staff_members` still has NOT NULL on them — and the 요건 itself (운영 정책
CTR-02, 재영 2026-10-13) lists 이름 · 휴대전화번호 · 근무지 · 직무 · 고용 형태
as the fields a 임시저장 needs, since 고용 형태 is a value of the 직원 레코드
the save creates. The list response types the
contract fields as nullable for the same reason. `workLocation` (근무 장소,
≤ 200 chars) is optional on both, and so are the api #12 칸 — 식대 ·
자가운전보조금 · 육아수당 (원, 0 이상), 월 기본시간 · 월간 연장근무 · 기본시간 중 야간 ·
휴일근무 · 월간 추가 휴일근무 (시간, 0.5 단위, ≤ 9999.5 for `numeric(5,1)`;
the two 휴일근무 칸: 화면(front #15)에서는 받지 않는다. 칸은 남아 있다 —
2026-10-14 재영) and
연차휴가 · 퇴직금 조항 (≤ 1000 chars); `GET` returns them, hours as numbers.
The 재직 확인, the duplicate checks, 초대 유형 판별 and the writes run in one
transaction under a transaction-scoped advisory lock on `contracts:{phone}`
(`lockPeople`) — per person, not per store, because the overlap check looks
at the person's other stores — so a double click or two overlapping requests
for the same person cannot both pass the checks before either writes; a
failure leaves nothing behind. `PUT` takes the same lock. `created_by` is the
token's `sub`. Returns `201 { contractId, staffMemberId }`.[^create-dto]

What it refuses, before writing:

- **400** — 만 19세 미만 on the contract start date (운영 정책 ACC-22; birthday
  counts), end before start, the same weekday twice, a shift that ends before
  it starts, a break given on one side only or outside the shift, a
  주휴일 that does not fit the week or 수습 that breaks its rules (both below),
  times off the 30-minute grid, `contractMethod: PAPER` outside 임시저장 (종이 계약 has its own route, below), a date
  that is not a real `YYYY-MM-DD` (`IsDateOnly` — `2026-W01` used to pass
  and turn the age check into NaN, a 500), an integer above 2147483647
  (`storeId`, `wageAmount`, 수당 — the column would 500).
- **404** — the store is missing, deleted, `CLOSED`, or outside the admin scope.
- **409** — someone with the same phone has **joined** (`join_status = JOINED`)
  and is `EMPLOYED` at that store (the mockup's 「이 점포 재직 중 → 차단」,
  decided from records alone). Records not joined yet are ignored: they are
  created with the schema default `EMPLOYED`, and one left behind by a rejected
  or expired contract would otherwise block that person at that store for good.
- **409 `CONTRACT_IN_PROGRESS`** — the same phone already has a contract in
  progress (임시저장 · 발송 대기 · 서명 대기) at that store. The body carries
  `code` and `contracts: [{ contractId, status, name, startDate, endDate }]` (the
  staff member's name and the period, so the 화면 shows whose contract it is); the 화면 asks 「기존 근로계약을
  대체하시겠습니까?」 and resends with `replaceContractIds` naming **all** of them (up to
  200 — 체결 완료 pile up when the same number is rehired). Then a
  임시저장 is deleted (rows, as in DELETE) and 발송 대기 · 서명 대기 are closed as
  `ENDED` with an `ADMIN` history row; a list that changed meanwhile is asked
  again. Each contract is row-locked (`FOR UPDATE`, before its child rows —
  the order `DELETE` uses, so the two cannot deadlock) and read again; if its
  status, store or phone changed after the list was made (a `PUT` moved it to
  another number, a `DELETE`), or the conditional delete · close touches 0
  rows, it is a 409 and nothing is written. Records left with no contract are
  deleted.[^contract-duplicates]
- **409 `WORK_TIME_OVERLAP`** — 초안 저장 only (not 임시저장): a contract of the
  same phone at **another** store (발송 대기 · 서명 대기 · 체결 완료, periods
  overlapping; no end date = open-ended) works the same weekday at overlapping
  times. Touching ends (16:00 종업 · 16:00 시업) do not count; breaks are not
  subtracted. A record that has retired counts only up to its `retired_date`
  — 퇴직 처리 does not close a 체결 완료 contract, which would otherwise block
  other stores for good. The body is only `code` and the message 「다른 점포
  근로계약과 근무 시간이 겹칩니다」 — no store, contract, weekday or time: the other
  store may belong to another BP, and the overlapping times would let anyone
  with a phone number map someone else's 근무 패턴 (운영 정책 CTR-26, 재영
  2026-10-13).

**주휴일 is chosen by the admin** (노무사 확인 2026-10-14, 질문 4 — 주휴일은 특정
요일로 정해야 한다; until then it was always NULL, 2026-10-08). `weeklyHoliday` is
one weekday. When 주 소정근로시간 — end − start − break, summed
(`weeklyMinutesOf`) — is 15 hours or more it is required (400 「주휴일을 골라야
합니다」, not on 임시저장) and must be a day that is not worked (400); under 15
hours 주휴 does not apply (운영 정책 PAY-02) and sending one is a 400. Working all
seven days with 15 hours or more therefore cannot be saved as 초안 — no day is
left for it.

**급여 지급 방식 and 수습** (데모 확인 2026-10-15). `payMethod` is `ACCOUNT`
(계좌) or `CASH` (현금), required unless 임시저장. `probationMonths` (1–3) and
`probationWageReductionRate` (%, 0–10) go together or not at all (the DB CHECK
`contracts_probation_pair` too). 수습 is only for 정직원 whose contract runs a
year or more (end ≥ start + 1 year − 1 day) or has no end date (노무사 확인
2026-10-14, 질문 19). The 90%-of-minimum-wage floor is checked by the 화면 only,
until the minimum wage is managed in the system like a 공통코드 (2026-10-15).
`GET` returns all three.

**초대 유형 is decided, not sent.** On 초안 저장 (a new `POST`, or a `PUT` that
leaves 임시저장) the newest account with that phone decides it: none → 가입 초대
(`SIGNUP_INVITE`); one with no record at this store → 소속 추가 확인; one with a
retired record there → 복귀 확인 — both put the account in
`staff_members.candidate_account_id`; one still employed there → 409. The result
is `contracts.draft_action` (also in the list response). **No `invitations` row,
token or `join_status = INVITED` is written on save**: those mean "sent" (`sent_at`
is NOT NULL, status starts at `SENT`) and are written by `POST …/send` below. 재초대 is not decided
here — an unjoined record with the same phone is already a 409; it belongs to
the 「초대 재발송」 action.

**종이 계약** (CTR-23, 2026-10-15). `POST /contracts/paper` is multipart: `data` is
the same body as `POST /contracts` as a JSON string (validated by the same
`ValidationPipe` rules — an unknown field is a 400, and a `data` that is not a
JSON object is 400 「data 칸에 …」), `employmentContract` is the 근로계약서 that
both parties signed (required) and `wageContract` a separately signed 임금계약서
(optional), one file each, PDF · JPG · PNG by content, 10MB
(`AttachmentFieldsInterceptor` · `assertUpload`). `contractMethod` must be
`PAPER`; the contract is saved straight to 체결 완료 (`SIGNED`) with an `ADMIN`
history row — no 발송, no 날인 기한 — after every check 초안 저장 does
(대체 · 다른 점포 겹침 · 초대 유형 판별: 종이 계약 직원에게도 가입 초대를 보낸다).
For a 종이 계약 the duplicate check also counts 체결 완료 at the same store and phone,
so pressing 등록 twice cannot make two signed contracts: it is the same 409
`CONTRACT_IN_PROGRESS` (the list may hold `SIGNED`), and a confirmed
`replaceContractIds` closes the old 체결 완료 as `ENDED` like 발송 대기. Every 체결 완료 at the
same store and phone counts, whatever its name, end date or 재직 — narrowing by name
lets a re-registration that fixes a typo in the name, and narrowing by end date lets
a late paper registration of a finished contract pressed twice, make two signed
contracts (api #49 3rd review). The 409 body's name and period let the admin see
whose contract would be closed. 전자계약 saves do not count 체결 완료 (a 재계약 is a new
contract beside it).
`PUT /contracts/:contractId/paper` does the same from a 임시저장
(`DRAFT → SIGNED`, a transition in the table). Through the JSON routes a
`PAPER` contract can only be 임시저장 (400 「…근로계약서 파일과 함께 등록합니다」), and
files with an 전자계약 or a 임시저장 are a 400.

Each file goes to the bucket as `contracts/{contractId}/{uuid}.{ext}` and a
`contract_documents` row keeps the kind (`PAPER_EMPLOYMENT_CONTRACT` ·
`WAGE_CONTRACT`), `storage_key`, a sha256 `checksum` and the original
`file_name`. The upload happens inside the write transaction, after the
contract row exists; if anything later fails, the uploaded keys are deleted
— originals only (날인본 have no thumbnail) and all at once, so a stalled S3
waits one delete deadline — before the error is returned (a failed delete is a
warning in the log). A storage
error on upload is logged and answered 503 「날인본을 저장하지 못했습니다 …」 —
the SDK message never reaches the client. The upload stays inside the
transaction because the key needs the `contractId`; with documents the
transaction gets 60 seconds (`PAPER_TRANSACTION_TIMEOUT_MS`) instead of the
default 5. Writes of the same phone queue on its advisory lock meanwhile; a write
transaction that runs out of time (P2028, the upload itself or one waiting behind
it) is a 503 「저장이 몰렸습니다. 잠시 뒤 다시 저장해 주세요」 instead of a 500. Without
`AWS_S3_*` the paper routes are a 503 and nothing is written; 전자계약 saves never
touch the storage. `GET /contracts/:contractId` lists `documents` (`contractDocumentId`,
`kind`, `fileName`), and `GET /contracts/:contractId/documents/:contractDocumentId/download-url`
returns a 300-second signed URL under the original name, after the same scope
check as the detail — a document of another contract is a 404, decided before
the storage check (so a missing `AWS_S3_*` does not hide it behind a 503).

발송 is `POST /contracts/:contractId/send` (below).

**Dates and times cross as UTC.** `start_date` · `birth_date` are sent as UTC
midnight and `time` columns as `1970-01-01T HH:mm Z`; a local-time `Date`
would shift them by the server's offset. Checked against PostgreSQL (PGlite
with every migration): rows come back `09:00:00`, `1998-07-12`.

# Resuming a 임시저장: GET · PUT /contracts/:contractId

`GET` returns what the 작성 form needs to reopen — name · phone from `contract_parties` (the
contract's own values, which 본인 대조 compares; a joined 직원's record holds account values, and
old contracts without a party row fall back to the record), the rest of the 직원 칸 from `staff_members`
(고용 형태 included: the record is the source, the contract holds a copy),
생년월일 · 성별 · 외국인 여부 from `contract_parties`, the contract fields, and the work days as
`HH:mm` in weekday order. `PUT` takes the same body as `POST` and replaces the
whole form: contract fields not sent become NULL, work days are deleted and
re-created, the party row is upserted. **Only `DRAFT` and `CORRECTION_REQUESTED`
(수정 요청) can be edited**; anything else is 409 「임시저장 · 수정 요청 근로계약서만 고칠 수
있습니다」. A 수정 요청 must be saved as a full 초안 (임시저장 and 종이 계약 are 400) and goes
back to 발송 대기 with `sign_deadline_at` cleared, so the next 발송 sets a new deadline. A 수정
요청 was already sent, so (api #58 review, 2026-10-16) it keeps its 근무지 (another store is 400 —
write a new contract) and its 초대 유형 (`draft_action` · `candidate_account_id` are not
re-decided: a joined 직원's own record is 재직, so 판별 would always say 「이미 재직 중」). For a
가입 완료 (`JOINED`) 직원 the record's name · phone · 생년월일 stay account values — only 직무 ·
고용 형태 follow — and a different phone is 400 (the account's number is the identity). The write is one transaction and the contract update is
conditional on `status = 'DRAFT'`, so a draft submitted by someone else between
the read and the write is not overwritten (zero rows → 409). Out of scope
(current or new store) is 404. The same duplicate checks run, leaving the
contract itself out (`replaceContractIds` works the same way).

**Scope is checked before the transaction.** `AdminScopeService` queries on
its own connection; inside a transaction every 이어 쓰기 · 삭제 would hold two
connections and a burst could drain the pool. The transaction then locks the
row (`FOR UPDATE`, after the person lock — the order 저장 · 대체 use too) and
re-reads it: gone → 404, moved to another store meanwhile → 409. The row lock
also ends the deadlock (a 500) when 삭제 and 이어 쓰기 hit the same 임시저장 at
once: the later one waits and reads the new state. Sending without
`isTemporarySave` moves it to 발송 대기 and adds a `DRAFT → PENDING_SEND` history
row. The path id goes through `ContractIdPipe`: anything but 1..2147483647 is a
404 before the database is asked.

`GET` also feeds the 상세 screen: `storeName` (read from `stores` separately —
it is a 1팀 table with no Prisma relation; a deleted store still shows its
name), `draftAction`, and `histories` (newest first, ties broken by the later
row id, `changedAt` as ISO 8601).

# Sending: POST /contracts/:contractId/send

WHALEERP-136 (2026-10-16 김민식 결정). `ContractSendService` (`ContractSendController`, same
path and admin rule as the rest). **This round sends 가입 초대 only** — a 직원 with no
account gets the 알림톡 `TALK_STAFF_INVITATION` (근무지 · 링크). 초대 유형 is decided
again at send time (an account may have appeared since the save); 소속 추가 확인 · 복귀 확인
go to existing accounts by 앱 알림, which does not exist yet, so they are 409
`SEND_CHANNEL_NOT_READY` (body carries `draftAction`).

- **발송 대기 → 서명 대기** (`ADMIN` history) with `sent_at = now` and `sign_deadline_at =
  now + 30 days`. From **서명 대기** it is a 재발송: the status stays, a new link and a new
  30-day deadline. Other statuses are 409 `CONTRACT_STATUS_CONFLICT`.
- An `invitations` row: `SIGNUP` the first time for that 직원 레코드, `REINVITE` after;
  channel `ALIMTALK`, `expires_at` 30 days, status `SENT`. Earlier `SENT` rows of the record
  become `EXPIRED` — only the newest link is live. **The token is 32 random bytes
  (base64url) in the link and only its sha256 is stored** in `invitation_token`, so a leaked
  row cannot make a link (`hashInvitationToken`). The record goes 초안 → 초대 발송
  (`join_status = INVITED`).
- The link is `STAFF_APP_URL`'s origin + `/invite/{token}` (the 직원 앱 checks it,
  WHALEERP-141). Without `STAFF_APP_URL`, or with the template missing or off, it is 503
  before anything is written.
- **Writes commit first, the 알림톡 goes after** (it cannot be rolled back). If Bizppurio
  rejects it with a code, the writes are undone (new row deleted, earlier rows back to
  `SENT`, contract back to the previous status · `sent_at` · deadline, record back to 초안)
  and it is 502 `SEND_FAILED` with `retryable: true`. If the answer is lost (no code — it
  may have been accepted) nothing is undone and it is 502 `SEND_UNCONFIRMED`,
  `retryable: false`: sending again could deliver twice.
- The 알림톡 has **no button yet** — the common module does not send `at.button` and the
  Kakao button name of `WHALE_INVITE_01` is not recorded (left out on 2026-10-16). Until
  then the link reaches the 직원 only through the SMS fallback (`BIZPPURIO_SMS_FROM`).
- `ContractsModule` imports `AlimtalkModule`, so **the api does not start without
  `BIZPPURIO_*`** (2026-10-16 김민식 결정: required). e2e (`test/e2e-env.ts`) and
  `openapi:export` fill format-only values when they are empty.

# Fixing the 근로자 before 날인: PATCH /contracts/:contractId/worker

WHALEERP-125 「본인 대조」 · 126 (2026-10-16). For a contract in 발송 대기, 서명 대기 or
수정 요청 it replaces name · phone · 생년월일 · 성별 · 외국인 여부 (`UpdateWorkerDto`, the same
field rules as `POST` — all required, `isForeigner` defaults to false). Other statuses are
409 `CONTRACT_STATUS_CONFLICT`. It is how the admin fixes a number after a phone call
(「링크를 못 받았어요」) or answers a 수정 요청. A 가입 완료 직원's phone cannot change here
either (400, as in `PUT`).

- 서명 대기 · 수정 요청 go back to **발송 대기** with `sign_deadline_at` cleared and an
  `ADMIN` history row — the next 발송 (WHALEERP-136) sends again with a new deadline. 발송
  대기 stays.
- A **new phone** re-runs, for the new number: 재직 확인, the same-store duplicate check
  (409 `CONTRACT_IN_PROGRESS`, confirmed with `replaceContractIds`), the other-store
  근무 시간 겹침, and 초대 유형 판별 (`draft_action`, `candidate_account_id`). Both numbers are
  locked. Changing the phone needs the store per store (403 otherwise), as in `PUT`.
- `contract_parties` gets the new values; the 직원 레코드's name and phone follow unless it
  is 가입 완료 (`JOINED`) — then the record carries account values and is left alone.
- 만 19세 미만 on the contract's start date is 400.

# Deleting a 임시저장: DELETE /contracts/:contractId

Hard delete, decided 2026-10-12: a 임시저장 was never sent, so there is no
record worth keeping. One transaction removes the work days, the party row, the
status history and the contract, then the staff record **only if** no other
contract points at it and it is still `join_status = DRAFT`. Only `DRAFT` can be
deleted (409 otherwise); the contract delete is conditional on `status =
'DRAFT'`, so a draft submitted between the read and the delete rolls the whole
transaction back as 409. 204 on success, 404 for an unknown id or one outside
the admin scope.

# Status transitions (WHALEERP-151)

Every status change of a contract goes through `contract-status.ts`: a
table of allowed moves, a conditional `UPDATE` and a history row
(`from_status` · `to_status` · `actor` · `changed_at`) in the same
transaction.[^contract-status]

| from | to |
|---|---|
| 임시저장 `DRAFT` | 발송 대기 (초안 저장) · 체결 완료 (종이 계약 등록) · 종료 (대체 · 퇴직) |
| 발송 대기 `PENDING_SEND` | 서명 대기 (발송) · 종료 |
| 서명 대기 `PENDING_SIGNATURE` | 체결 완료 (날인) · 거부 · 수정 요청 (직원) · 발송 대기 (근로자 정보 수정) · 만료 · 종료 |
| 수정 요청 `CORRECTION_REQUESTED` | 발송 대기 (관리자가 고침) · 종료 (대체 · 퇴직) — never 만료: the deadline does not run |
| 체결 완료 `SIGNED` | 종료 (계약 기간 끝 · 재계약 · 퇴직) |
| 거부 · 만료 · 종료 | — (재발송 WHALEERP-153 is not decided yet) |

A contract's first status (임시저장, 발송 대기, or 체결 완료 for a 종이 계약)
is set when it is created, and deleting a 임시저장 removes rows — neither is a
transition. 체결 완료 contracts are never edited (`PUT` takes `DRAFT` only);
a change means a new contract that replaces it.

- `transition(tx, contractId, to, actor, { from?, data? })` locks the
  contract row (`FOR UPDATE`, the same lock as `PUT` · `DELETE` · 대체),
  reads the status, and refuses a move the table does not allow — or one
  outside `from` — with **409 `CONTRACT_STATUS_CONFLICT`** carrying the
  current `status` and 「…입니다. 화면을 새로 고쳐 지금 상태를 확인해 주세요」.
  Nothing is written, so the previous status stays. `data` is written with
  the status (거부 사유 · 발송 일시 …).
- `transitionMany(tx, where, from, to, actor)` is the batch form
  (`updateManyAndReturn` + one history row each); the 서명 기한 만료 batch
  uses it.
- `signContract` — 서명 대기 → 체결 완료 (`STAFF`). An already 체결 완료
  contract is not touched and answers 409 with `status: SIGNED`. Past
  `sign_deadline_at` it answers **409 `SIGN_DEADLINE_PASSED`** even before the
  만료 batch runs; turning it into 만료 stays the batch's job.
- `requestCorrection` — 서명 대기 → 수정 요청 (`STAFF`), nothing else carried (2026-10-16).
  Past `sign_deadline_at` it is **409 `SIGN_DEADLINE_PASSED`**, like 날인 — an expired
  invitation is not revived by a 수정 요청 before the batch runs (api #58 review).
  The 직원 앱 route and the five-value 본인 대조 come with WHALEERP-145.
- `rejectContract` — 서명 대기 → 거부 (`STAFF`) with `reject_reason`
  (trimmed, 1–500 chars, else 400).
- No HTTP route yet: 날인 · 거부 need the 직원 앱 token and the signature image,
  which come with [API] 날인 · 거부 처리 (WHALEERP-145).
- Moved onto it: `PUT` 임시저장 → 발송 대기, 대체 (발송 대기 · 서명 대기 →
  종료), the 만료 batch. 퇴직 처리 (`staff-members/retirement.service.ts`)
  still writes the same rule (진행 중 → 종료 + history) itself.

# GET /stores/options

The 근무지 dropdown's source: `{ items: [{ storeId, name }], total }`,
undeleted and not `CLOSED`, by name, and only the stores the admin may write
contracts for — managed, and for 본사 역할 직영 only (the per-store half of the
contract rule above: a new contract has no 직원 whose consent could open it).
403 for an account that is not in use. It moved from `GET /stores` on 2026-10-14,
when that path became the 점포 정보 관리 list ([Store management](/api/stores.md));
the two answer different questions — this one is "where may I write a contract",
that one is "what may I manage" — so they stay separate.[^stores-service]

[^create-dto]: CreateContractDto
[^stores-service]: StoresService (근무지 선택지)
[^contracts-controller]: ContractsController
[^contracts-service]: ContractsService
[^contract-duplicates]: 계약 중복 검사 (WHALEERP-129)
[^contract-status]: 계약 상태 전환 (WHALEERP-151)
[^list-query]: ListContractsQueryDto
[^admin-scope]: AdminScopeService
