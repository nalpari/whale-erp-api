---
type: API Endpoint
title: Contracts API
description: GET /contracts (list), POST /contracts (근로계약서 초안 저장), GET · PUT /contracts/:contractId (상세 · 임시저장 이어 쓰기), DELETE /contracts/:contractId (임시저장 삭제), plus GET /stores/options for the 근무지 choice; admin tokens only, filtered by the admin scope. Status changes go through one transition table (contract-status).
tags: [api, contracts, nestjs, prisma]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-27T07:26:42Z }
sources:
  - id: contracts-controller
    resource: ../../src/contracts/contracts.controller.ts
    title: ContractsController
    last_modified: 2026-10-13T03:44:30Z
  - id: contracts-service
    resource: ../../src/contracts/contracts.service.ts
    title: ContractsService
    last_modified: 2026-10-27T07:26:42Z
  - id: contract-duplicates
    resource: ../../src/contracts/contract-duplicates.ts
    title: 계약 중복 검사 (WHALEERP-129)
    last_modified: 2026-10-15T08:30:00Z
  - id: contract-status
    resource: ../../src/contracts/contract-status.ts
    title: 계약 상태 전환 (WHALEERP-151)
    last_modified: 2026-10-23T07:22:15Z
  - id: contract-send
    resource: ../../src/contracts/contract-send.service.ts
    title: 근로계약 재발송 (WHALEERP-136 · 611)
    last_modified: 2026-10-23T07:22:15Z
  - id: contract-delivery
    resource: ../../src/contracts/contract-delivery.service.ts
    title: 근로계약 보내기 (WHALEERP-136)
    last_modified: 2026-10-23T07:22:15Z
  - id: contract-response-dto
    resource: ../../src/contracts/dto/contract.response.dto.ts
    title: 근로계약 응답 DTO — 목록 statusCounts · staffJoinState · staffRetired, 상세 칸
    last_modified: 2026-10-23T09:40:00Z
  - id: list-query
    resource: ../../src/contracts/dto/list-contracts-query.dto.ts
    title: ListContractsQueryDto
    last_modified: 2026-10-08T00:00:00Z
  - id: create-dto
    resource: ../../src/contracts/dto/create-contract.dto.ts
    title: CreateContractDto
    last_modified: 2026-10-23T09:40:00Z
  - id: stores-service
    resource: ../../src/stores/stores.service.ts
    title: StoresService (근무지 선택지)
    last_modified: 2026-10-14T08:11:55Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: AdminScopeService
    last_modified: 2026-10-26T07:41:19Z
  - id: my-contract-views
    resource: ../../src/contracts/my-contract-views.service.ts
    title: 직원 앱 근로계약 목록 · 상세 (WHALEERP-610)
    last_modified: 2026-10-22T00:21:08Z
  - id: contracts-menu
    resource: ../../src/contracts/contracts-menu.ts
    title: 근로계약 관리 메뉴 상수(CONTRACTS_MENU) — 서비스의 권한 재확인과 직원 목록 · 상세의 workDays 판정이 같이 쓴다
    last_modified: 2026-10-27T07:26:42Z
  - id: contract-terms
    resource: ../../src/contracts/contract-terms.ts
    title: 계약서 근무 조건 칸 · 변환 (관리자 · 직원 상세 공용)
    last_modified: 2026-10-27T07:06:44Z
  - id: my-contract-scope
    resource: ../../src/contracts/my-contract-scope.ts
    title: 직원 앱 「내 계약」 기준 (145 · 610 공용)
    last_modified: 2026-10-22T00:21:08Z
---

# What it is

`GET /contracts` returns `{ items, total, statusCounts }` per the list rules in
[Naming conventions](/conventions/naming.md): `page` (from 1), `pageSize`
(default 20, max 200), newest `created_at` first with `contract_id` as the
tie-breaker. Filters: `status` (repeatable — `?status=SIGNED&status=REJECTED`),
`storeName` and `staffMemberName` (case-insensitive substring), `storeIds` (picked stores — comma-separated, up
to 1000; a repeated key also works for a few, but the query parser reads only 1000 keys and drops the rest without a
400, so many ids go comma-separated as the 관리자웹 does — api #132 review; ids outside the scope drop silently) and `storeTypes` (`DIRECT` · `FRANCHISE`), all
ANDed and always inside the admin scope below. `storeIds` · `storeTypes` are what the 관리자웹 list's store filter
and the header store scope send (WHALEERP-326 · 133, 2026-10-22 — same shape as 점포 정보 관리 `GET /stores`).
An empty `storeIds=` (or an empty piece such as `storeIds=3,`) is 400, like `GET /stores`, so the 관리자웹 leaves the
parameter out for 「전체」 instead of sending it empty. Narrowing by `storeIds` · `storeTypes` never skips the ATT-30
consent condition — 본사 역할 still sees a 가맹 store's contracts only for 본사 제공 동의 staff. The condition is `hqVisibleWhere` in `src/admin-scope/hq-visible.ts`, shared with 로그인 후 홈 so both screens count the same contracts.[^contracts-service]

It also returns `statusCounts` — contracts per status (all eight, zeros included; WHALEERP-133, 2026-10-23): the same
conditions as the list with only the `status` filter dropped, so the store · store name · staff name filters apply and
the 가맹 contracts hidden from 본사 역할 (no 본사 제공 동의) are **not** counted. Counting them let a 본사 역할 narrow
to one 가맹 store with a single non-consenting 직원 and read that person's contract status from the counts, the first
leak of contracts that are otherwise treated as absent (list excluded, detail 404) — api #146 review. Whether ATT-30
(「hidden staff are counted, not listed」) allows store-level counts is waiting on 기획; if allowed, the hidden ones
come back into the counts. A contract whose status is empty (old rows) is not counted, so the counts can add up to
less than `total`. Each row also carries the 직원's current `staffJoinState` (`joinStateOf`,
the 직원 목록 rule — `draftAction` is what was decided at save and stays after the invitation expires or is
rejected) and `staffRetired` (재직 상태 퇴직; a 퇴직 예정 is false). The 관리자웹 status cell shows 「가입 대기 중」 ·
「소속 확인 중」 · 「퇴직」 from them. `renewalDate` is the 갱신 예정일 — for a 체결 완료 whose end date is today or later,
30 days before it, else null (`renewalDateOf` in `contract-renewal.ts`, the same rule as the 직원 상세 요약,
WHALEERP-156) — also null once it has a live 재계약, like the 갱신 예정 notice. `previousContractId` marks a 재계약 row.

It is the first domain module after the samples were removed, so it is the
worked example `okf/index.md` used to lack.

# Traps

- **Admin tokens only.** The controller carries `@UserTypes('admin')`; 직원 근무 앱
  tokens get 403. Tokens come from 관리자 웹 login ([Admin authentication](/api/admin-auth.md));
  `test/contracts.e2e-spec.ts` stubs the session check instead.[^contracts-controller]
  403 texts are the shared ones in `src/auth/access-messages.ts` — an account that is not
  in use gets 「사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.」.
- **「근로계약 관리」 menu permission comes first** (WHALEERP-592, 2026-10-21): every route carries
  `@MenuPermission`, path style — the menu is `/contracts` (MN000006). Reads (`GET` list · detail ·
  document URL) need read; `POST` · `POST /paper` need create; `PUT /:id` · `PUT /:id/paper` pass the
  guard with create **or** update, and the service asks again once it has read the status
  (`adminHasMenuAction`, 2026-10-21 김민식): finishing a 임시저장 needs create, re-sending a 수정 요청
  contract needs update. A save that **replaces** (closes) other contracts of the same 직원 needs update
  as well, on `POST` too — it changes existing contracts — and delete when one of them is a 임시저장,
  since 대체 deletes that row (`PATCH /:id/worker` as well; api #97 review, 2026-10-21 김민식). Without it
  대체 would be a way round `DELETE`. Replacing only 임시저장 closes nothing, so it needs delete alone — the
  same as `DELETE` then save (code-review). These are asked before the 409 `CONTRACT_IN_PROGRESS`, so an admin
  who could not replace never sees the other contracts' names · periods. Their 403 says why instead of the shared
  text — 「…기존 계약을 대체하려면 근로계약 관리 수정 권한이 필요합니다」(「체결 완료되었거나 진행 중인」 when a 종이 계약
  등록 would end a 체결 완료, as the 409 says), and for a 임시저장 「…삭제 권한이 필요합니다 — 기존 임시저장을 이어 써
  주세요」(`PUT` · `PATCH /:id/worker`: 「삭제 권한이 있는 관리자에게 맡겨 주세요」 — they are already editing another contract) —
  since the 관리자 웹 shows the 작성 button to them. All are 403 before anything is written;
  `PATCH /:id/worker` and `POST /:id/send` (재발송) need update; `DELETE` needs delete. No permission is
  403 before the service runs. The 관리자 웹 hides the same buttons (`ContractPermission`), mapping in
  `src/contracts/contracts-menu-permission.spec.ts`. On the shared DB (2026-10-21) 플랫폼 마스터 · BP 마스터
  have all four, 가맹 마스터 all but delete (so it cannot delete a 임시저장 any more). Being a path-form
  guard also makes `/contracts` an API permission address: 플랫폼 메뉴 관리 can no longer change
  MN000006's URL or give `/contracts` to another menu (409, [Platform menus](/api/platform-menus.md)) —
  moving it takes the controller path and a migration together. `src/auth/menu-permission-urls.spec.ts`
  pins both contract controllers to `/contracts`.
- **Every call is inside the 관리자 업무 범위** (PR #19 blocker, 2026-10-13 재영),
  through `AdminScopeService` — the same rules as the 직원 목록 and 퇴직 처리.
  A contract counts as out of scope when the admin does not manage its store,
  **or** the admin is 본사 역할 (BM · BA), the store is not 직영, and — for an
  existing contract — its 직원 has not given 본사 제공 동의: a contract is 직원
  개인 정보 (이름 · 번호 · 생년월일 · 임금), so it follows `hidesPersonalData`
  like the staff-level APIs (운영 정책 ATT-30). **A contract whose 직원 is known
  is judged by that 직원's consent; a store with no 직원 yet is judged per store**
(the consent is the 직원's account value — one per person since 2026-10-20 — and
a 직원 not yet joined has no account, so counts as not consented)
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
  customer store until this module passes the tab BP (`@TargetBp()`, WHALEERP-618), so
  they see an empty list.[^admin-scope]
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

It writes the contract (in its sent status — see Sending: `PENDING_SEND` for a 가입 초대,
`PENDING_SIGNATURE` when the number has an account), `contract_parties` (entered name ·
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
their past contracts under the new one. A record that has retired or is due to retire is never reused either — someone who comes back after leaving gets a new record and a new 근로계약서, whatever the old record and its contracts hold (2026-10-19 김민식, api #65 review). A record that lost its contracts to the
대체 is deleted either way, whether the new contract reuses a record or makes one. With `isTemporarySave: true`
the contract and that first row are 임시저장 (`DRAFT`) and nothing is sent.

**재계약** (WHALEERP-156, 2026-10-26 김민식): `POST /contracts` with `previousContractId` — the contract it follows,
in the 관리자's scope (404 · 403), 체결 완료 or 종료 by the daily batch from 체결 완료 (`SIGNED_ONCE` — not one closed by 대체; else 409), with no 재계약 that went through 체결 yet
(else 409, so one contract never gets two signed successors — a 재계약 still in progress is asked about by the
duplicate check like any other in-progress contract, `CONTRACT_IN_PROGRESS` with `replaceContractIds`), at the same store and phone
(else 400). It is stored in `contracts.previous_contract_id`. The previous contract's 직원 row is locked before its
재직 is read, so a 퇴직 확정 cannot slip in between.
- **연장** — the 직원 is 재직 (not 퇴직, no 퇴직일 set): the new contract goes on **that same record**, even a 가입 완료
  재직 직원 (the 409 「이 점포에 같은 번호로 재직 중인 직원이 있습니다」 skips that record). A 가입 완료 record is not
  run through 초대 유형 판별 (it would always be 「이미 재직 중」) and its name and phone are not overwritten — only
  직무 · 고용 형태 follow the contract, like 이어 쓰기; 초안 저장 sends it to the app (서명 대기). Continuing such a 임시저장
  (`PUT`) skips 판별 the same way.
- **The previous contract must be the record's latest 체결** — a 체결 완료 on that record starting after it is 409
  (「더 최근에 체결한 근로계약」): otherwise the batch would close only the old one and the current 체결 완료 would stay
  beside the new contract (api #157 self-review). When the previous contract has no 시작일 (old row), only a 체결 완료
  that has one counts as later — two old rows without dates do not block each other (api #157 review).
- **Without `previousContractId`** — sending a new contract to a 가입 완료 재직 직원 at that store is itself a 재계약
  (WHALEERP-130, 2026-10-26 재영): the save picks the latest contract that went through 체결 (`SIGNED_ONCE`, latest
  시작일 · id, an empty 시작일 last — `employedRenewalOf`) of the 재직 record at that store and phone — a 가입 완료 one,
  or a 가입 전 one with the same name (a 종이 계약 signed before 가입; the name rule of reusing a 가입 전 record) — and
  continues as above. A record with a 퇴직일 set is not linked this way (api #157 review). A 가입 완료 record with no such contract (only an in-progress one) stays 409 「이 점포에 같은
  번호로 재직 중인 직원이 있습니다」.
- **재입사** — the 직원 is 퇴직 (or a 가입 전 직원 with a 퇴직일 set): a new record as below, linked to the old one, and
  the contract still stores `previousContractId`. A 가입 완료 직원 who is only 퇴직 예정 is still 재직 on that record, so
  it stays 409 until the 퇴직 is final.
- A 재계약 keeps its phone on `PATCH …/worker` too (400), like `PUT`.
- A 재계약 임시저장 keeps its store and phone on `PUT` (400 otherwise — the link would point at someone else's
  contract), and sending it is 409 once the 직원 has a 퇴직일 (임시저장 is still allowed).
- The detail carries `renewedBy` (the 재계약 of this contract that went through 체결, else null — the screen hides 「새
  계약」; a 재계약 still in progress is not counted, a new one asks to replace it on save) and
  `staffJoined` (whether a 거부 · 만료 재발송 goes to the app or as a 가입 초대).
- **직무 · 고용 형태 move when the contract starts** (2026-10-27 김민식). Each contract keeps its own 직무
  (`contracts.job_title`, migration `20261027153411_team3_contract_job_title` — existing rows filled from the record)
  and 고용 형태 (`employment_type`); the 직원 레코드 holds the current ones. Saving a 재계약 (임시저장 · 발송, `POST` or
  `PUT`) does not touch them on the record (a 가입 전 record still gets name and phone) — before, the 직원 목록 · 상세
  switched to the next contract's values at once and kept them after a 거부 · 만료. Saving any other contract writes
them only to a record with no contract that went through 체결 (`recordTermsFree` — otherwise the daily batch would put
the effective contract's values back every night; api #157 code-review). When a contract becomes 체결 완료
  (날인 · 종이 계약 등록) and has already started, `applyStartedTerms` copies them to the record — unless a 체결 완료
  that started later is already in force (an old 종이 계약 uploaded late does not overwrite current terms). The daily
  batch keeps the record on the latest started contract of that record that went through 체결 (`SIGNED`, or `ENDED` by
  the batch — any contract, not only 재계약; a tie on 시작일 goes to the larger id, the same rule as
  `applyStartedTerms`), so a 재계약
  signed ahead of its 시작일 is copied on that day. The detail and the 직원 앱 contract show the contract's own 직무 ·
  고용 형태 (the record's only for old rows with an empty column).
- The 직원 목록 · 상세 「latest contract」 skips an extension 재계약 (previous contract on a 재직 record with no 퇴직일)
  that is 임시저장, 거부, 만료 or 종료 without 체결 (`NOT_IDLE_RENEWAL`), so the running previous contract and its 갱신
  예정일 stay visible (api #157 review). A 재입사 재계약 (previous contract on a retired record) is never skipped — it is
  the new record's only contract.
- The previous contract is not replaced (it is left out of the duplicate check, also when a 재계약 임시저장 is
  registered as a 종이 계약 through `PUT`) and not changed: once the new
  contract is 체결 완료 and its 시작일 has come, the daily batch moves the previous one to 종료 — its end date is kept
  ([Employment contract batch](/api/employment-contract-batch.md)).
- **시작일** (2026-10-26 김민식 · 재영 확인): a 재계약's 시작일 must be at least a day after the previous contract's
  시작일 (400 「재계약 시작일은 직전 계약 시작일(…) 다음 날부터입니다」, on `POST` and on `PUT` of a 재계약 임시저장; not
  checked while 시작일 is empty). Past that it may overlap the previous contract — a 기간의 정함이 없는 contract whose
  시급 changes, or a mid-term change — since the batch closes the previous one on the new 시작일. This is what tells a
  재계약 apart from the same contract sent again. Without `previousContractId`, a **종이 계약** for a **가입 전**
  record that does not start after the contract `employedRenewalOf` found is not taken as a 재계약 but as the same
  paper uploaded again: it falls through to the 체결 완료 overlap check below (a 가입 완료 record only gets new
  contracts as 재계약, so it is 400).

**A 재입사 record points at the one before it** (WHALEERP-615, 2026-10-22 김민식). Every save that writes a
가입 전 record — `POST`, `PUT` (이어 쓰기 · 종이 계약 등록), `PATCH …/worker` — sets
`staff_members.previous_staff_member_id` (`previousRecordOf`) to the same person's latest-retired record at
this store: one with `retired_date` set (퇴직 or 퇴직 예정) and **the same name** that is either the account's record
when the number has an account (looked up here the same way as 초대 유형 판별 — a 임시저장 does not run 판별) or a
가입 전 record with the same number. A different name may be someone who took over the number, so it is not linked —
the same rule as reusing a 가입 전 record (api #136 review). None found → null. A record being re-saved never links to
itself or to any record that already leads back to it (`linkedRecords`, one recursive query), and a record that is
itself 퇴직 or 퇴직 예정 keeps its link (it is a past 재직 기간). It is looked up again on every save because 이어 쓰기 and
근로자 정보 수정 change name and phone; a 가입 완료 record is left alone (its name and phone are account values). The
old record keeps its own 입사일 · 퇴직일 · contracts · 명세서 — each 재직 기간 stays on its own record, and the
직원 상세 walks the link ([Staff members](/api/staff-members.md)). A 계약 기간 end without 퇴직 is a 연장 on the same
record; to treat a gap as 재입사 the admin retires the record first — the system does not judge gaps. Records made
before the column are not back-filled.
A 퇴직 예정 record counts as a previous record. If its 퇴직 is later cancelled, the new record still points at it
— left as is (2026-10-23 김민식): it only happens to a 가입 전 직원 (a joined one cannot get a new contract while still
재직), and the admin has to clean up the second record anyway.

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
token's `sub`. Returns `201 { contractId, staffMemberId, status, draftAction }` — the status after saving and what
the system actually did, so the 관리자웹 can say it (WHALEERP-132): `null` when nothing was sent (임시저장, 종이 계약
등록). When it sent, the channel is the same `channelOf` the send used: the 가입 초대 알림톡 is `SIGNUP_INVITE`; the
app path is `IMMEDIATE_SEND` for a joined 직원 (app notice, whatever 초대 유형 the contract was first sent with),
otherwise 소속 추가 확인 · 복귀 확인 (nothing reaches the 직원 until they confirm) — or `null` for an old contract with
no 초대 유형 and a 가입 전 직원 (no account to notify, nothing went out). If `dispatch` reports it sent nothing (another request —
발송 대기 종료, 재발송 — expired the invitation between the commit and the send), the save reads the contract's
status again and answers it with `null`; when it sent, nothing is read again. If that re-read fails it answers 502
`SEND_UNCONFIRMED` (the save is done — the screen reads the 상세 again instead of saving again; answering the
computed status could call an 종료 contract 서명 대기, api #146 re-review). It can differ from the `draftAction` stored on the contract (a 종이 계약 keeps its 판별 value; a joined
직원 keeps the first one). `PUT` (이어 쓰기) and `PATCH …/worker` answer the same shape.[^create-dto]

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
  again. The `SENT` invitations of the replaced contracts' records become `EXPIRED` — a link
  must not lead to an ended contract, and a retiring or differently named record is not
  reused, so the next send would not close them (api #65 re-review). Each contract is row-locked (`FOR UPDATE`, before its child rows —
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
is `contracts.draft_action` (also in the list response). It also decides how the 직원 receives
the contract — a 가입 초대 for `SIGNUP_INVITE`, the 앱 for an account — and the save sends it
right away (Sending, below): the `invitations` row, token and `join_status = INVITED` are written
then, never for a 임시저장.

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
**A 종이 계약 does not replace 체결 완료** (WHALEERP-156, 2026-10-26 김민식 · 재영 확인 — it used to, api #49, which
left a gap when a 재계약 was registered early: a 1/1 contract uploaded on 12/10 closed the one running to 12/31 that
day). The previous contract of a 재계약 is closed by the batch on the new 시작일 instead. To keep 등록 pressed twice
from making two signed contracts, a 종이 계약 whose period overlaps a 체결 완료 at the same store and phone — other
than the 재계약's previous contract and the contract being continued — is 409 **`SIGNED_CONTRACT_OVERLAP`**
(`hasOverlappingSigned`; an empty 시작일 counts from the beginning, an empty 종료일 runs on). Nothing is uploaded.
Its `contracts` list is what 바로잡기 would replace — contracts in progress and only the 체결 완료 whose period overlaps
the new one (`overlappingReplaceable`, api #157 review: closing a non-overlapping 체결 완료 such as a running previous
contract by 대체 drops it from 「signed」 counts for the rest of its term); the 대체 권한 is asked first (403 without
it), and a 동의로만 보는 관리자 gets the 403 for another record's contract, as with `CONTRACT_IN_PROGRESS`. When the 종이 계약 is a **재계약** (`previousContractId`, or one `employedRenewalOf` found), the overlap is with a 체결 완료 that is not its previous contract and 바로잡기 cannot be used with a 재계약, so it is 409 **`RENEWAL_SIGNED_OVERLAP`** instead — blocked, no 바로잡기 offered and no 대체 권한 asked (nothing is
replaced) (offering it led a 가입 완료 직원 to 「재직 중」 409 and closed a 가입 전 직원's previous contract by 대체, api #157 self-review).
**잘못 올린 계약 바로잡기** — the only way a 체결 완료 is closed at once: send the 종이 계약 again with
`correctSignedContracts: true` and every id of that list in `replaceContractIds`. The duplicate check then counts
the 체결 완료 at the same store and phone whose period overlaps (409 `CONTRACT_IN_PROGRESS`, the list may hold
`SIGNED`), and closes it as `ENDED` like 발송 대기 (수정 권한 — WHALEERP-592) — whatever its name or 재직, so a
re-registration that fixes a typo in the name still replaces it (api #49 3rd review). The 409 body's name and period let the admin see whose contract would be closed. No reason is taken (재영
suggested one; 2026-10-26 김민식 declined it) — the `ADMIN` 체결 완료 → 종료 history row and the contract registered
right after it tell what happened. **A wrongly uploaded 재계약 is corrected the same way** (2026-10-27 김민식, api #157
review): the 재계약 being replaced is closed, but its previous contract is left out of the list (`correctionTargets` — a
재계약 starts inside its previous contract's term, so it always overlaps it) and the contract uploaded again takes over
that previous contract (`correctedRenewalOf` — the batch closes it on the new 시작일). In a chain C1 → C2 → C3 only the
end of the chain is replaced (`replacedRenewals` — a 재계약 that another overlapping 재계약 continues is the one in force),
every earlier contract of the chain stays, and the contract uploaded again continues C2 (api #157 re-review 3 · 4). This
works for a 가입 완료 재직 직원 too: re-uploading the same 계약서 without `previousContractId` is treated as a re-upload
(409 `SIGNED_CONTRACT_OVERLAP`, checked before the 「재직 중」 409), so 바로잡기 can be offered; a 바로잡기 that is not a
재계약 (their first contract) goes onto the same 가입 record when every replaced 체결 완료 is that record's
(`correctedJoinedRecordOf` — before, it stopped at the 「재직 중」 409). When 바로잡기 closes a 체결 완료 of the record it
writes to, the record's 직무 · 고용 형태 go back to the contract in force (`resyncStartedTerms`, the batch's rule) so
the closed contract's values do not stay until the next batch. Two replaced 재계약 continuing different contracts are
409. Continuing a 임시저장 as 바로잡기 (`PUT`) checks the inherited previous contract like `POST`, after the permission checks: same 직원 레코드 for an 연장
(409 otherwise; a 재입사 재계약 whose previous record is retired is allowed; either way the replaced 재계약 must be on the
record being continued), 시작일 after the previous contract's, no
later 체결 (api #157 code-review). `previousContractId` itself
still cannot be sent with 바로잡기 (400), nor on a `PUT` of a 재계약 임시저장, and 바로잡기
outside a 종이 계약 등록 is 400. 전자계약 saves do not
count 체결 완료 (a 재계약 is a new contract beside it).
**입사일** (WHALEERP-613): whenever a contract becomes 체결 완료 — 날인, `POST /contracts/paper`, or
`PUT /contracts/:contractId/paper` — `fillHiredDate` (`contract-status.ts`) copies its 시작일 into the 직원
record's `hired_date` **only when that is empty**. A 직원 record is per store, so the store's first 체결 완료
sets it and a 갱신 · 재계약 on the same record leaves it (2026-10-21 재영); a 재입사 after 퇴직 is a new record,
so it gets the new contract's 시작일. 임시저장 · 발송 · 거부 · 만료 never touch it — an empty 입사일 still means
"not hired yet". Records signed before this were filled once by migration
`20261022142048_team3_staff_hired_date_backfill` (the 시작일 of each record's earliest `SIGNED` history row).
Every caller already holds the 직원 row for writing: `PUT …/paper` through `lockStaffMember`, a
`POST /contracts/paper` that reuses a 가입 전 record through the `UPDATE` it runs on that record just
before (a new record is the transaction's own row), 날인 through the lock above.
A record whose 퇴직일 is before the contract's 시작일 is **not** filled (a 퇴직 scheduled before a later-starting
contract is signed — the work ends before it starts, and filling it would make 퇴직일 < 입사일 so the 퇴직일
could no longer be changed); the backfill skips the same contracts — before picking each record's first one, so
the next signed contract is taken instead (api #124 review) — and its `DO` block only raises a NOTICE for
any 퇴직일 < 입사일 left (hand-entered 입사일), so it never blocks a deploy (api #124 code-review). Such a record
gets its 입사일 later if the 퇴직 is cancelled or moved on or after a skipped contract's 시작일: 퇴직 취소 ·
퇴직일 변경 call `refillHiredDate` (the first signed contract starting no later than the new 퇴직일), so the
record does not stay without an 입사일 (api #124 review).
Decided 2026-10-22 (김민식): a 직원 who leaves **before the 입사일** may be retired with an earlier 퇴직일 —
퇴직's 「퇴직일은 입사일보다 앞설 수 없다」 (`retirement.service`) only applies once the 입사일 has come, since it
protects days actually worked ([Staff retirement](/api/staff-retirement.md)). A wrong 시작일 is fixed **before**
체결 완료 — the 직원 asks for a 수정 요청 before signing and the 관리자 corrects the contract — so no API rewrites
`hired_date` afterwards. **Known limit**: a 종이 계약 has no such step (it is 체결 완료 on registration), so a
wrong 시작일 on the first one stays in the 입사일 even if it is replaced (the backfill likewise takes a replaced,
now 종료 contract if it was signed first).
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
the storage check (so a missing `AWS_S3_*` does not hide it behind a 503). The 직원's handwritten
signature (`SIGNATURE`, WHALEERP-145) is left out of both.

초안 저장 sends right away (2026-10-19 재영) — see Sending below. `POST /contracts/:contractId/send`
is the 재발송 only.

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
있습니다」. A 수정 요청 must be saved as a full 초안 (임시저장 and 종이 계약 are 400) and is
sent again right away (2026-10-19 재영): **서명 대기** with a new 30-day deadline, never through
발송 대기 — unless the new phone has no account, which makes it a 가입 초대 (발송 대기). A 수정
요청 was already sent, so (api #58 review, 2026-10-16) it keeps its 근무지 (another store is 400 —
write a new contract) and its 초대 유형 (`draft_action` · `candidate_account_id` are not
re-decided while the phone stays: a joined 직원's own record is 재직, so 판별 would always say
「이미 재직 중」). A new phone — only possible before 가입 — is decided again for that number,
as in `PATCH /worker`, so the old number's candidate account is not left behind. For a
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
once: the later one waits and reads the new state. Saving without
`isTemporarySave` moves it to its sent status (발송 대기 or 서명 대기) with an `ADMIN` history
row and sends, as `POST` does. The path id goes through `ContractIdPipe`: anything but 1..2147483647 is a
404 before the database is asked.

`GET` also feeds the 상세 screen: `storeName` (read from `stores` separately —
it is a 1팀 table with no Prisma relation; a deleted store still shows its
name), `draftAction`, and `histories` (newest first, ties broken by the later
row id, `changedAt` as ISO 8601).

It also carries the 발송 · 처리 정보 the 상세 shows (WHALEERP-328, 2026-10-23), all ISO 8601 or null:
- `firstSentAt` — the first history row into 발송 대기 or 서명 대기 (its DB time, so a few ms off the request time);
  `lastSentAt` — `contracts.sent_at`, rewritten on every send; `signDeadlineAt`; `lastProcessedAt` — the newest
  history row.
- `rejectReason` — only when the contract is 거부 (the column is kept on other statuses but not shown).
- `resendCount` — `contracts.resend_count`, counted in `ContractDeliveryService.prepare` when a contract that had
  been sent is sent again (재발송, 수정 요청 고침, 근로자 정보 수정) and taken back by `undo` when the 알림톡 did not go
  out. A resend that only set a new deadline with no notice (joined 직원 with a switched-off template or a withdrawn
  account) is counted too. A failed send that overlapped another request, or a send `dispatch` skipped because another
  request expired its invitation, is not taken back, so the count can be higher than real in those rare cases. Resends before this column
  was counted are not in it. Use `resendCount`, not `firstSentAt !== lastSentAt`, to tell whether it was resent — the
  two times come from different clocks.
- `previousContractId` — the 재계약 link (WHALEERP-156, set by `POST /contracts` with `previousContractId`); null
  for a contract that is not a 재계약.
- 종이 계약 only: `registeredAt` — when it became 체결 완료 (a 임시저장 can be registered later, so not `created_at`),
  `registeredBy` — the creating admin's name (login id if no name), read from `admin_accounts` separately (1팀 table).
  Both null for a 종이 임시저장 not registered yet, or one ended (대체 · 퇴직) before it was. Only an old 체결 완료 ·
  종료 contract with no history rows at all falls back to `created_at`.
  A 임시저장 continued by another admin still shows the creator — history rows do not record which admin.
- `canResend` — whether policy allows `POST …/send`: 발송 대기 or 서명 대기, and the 직원 is 가입 완료 (app notice) or the
  number has no account (가입 초대). A number with an account but no 가입 here (소속 추가 확인 · 복귀 확인) is 409
  `SEND_CHANNEL_NOT_READY`, so the 상세 hides the button. The staff list's `invitation.canResend` follows the same rule
  for the 가입 초대 case only (a joined 직원 is false there, true here — the app notice).
  Policy only: a landline (409 `SEND_PHONE_NOT_MOBILE`) or missing send settings (503) still fail when sent.

# Sending: on save, and POST /contracts/:contractId/send (재발송)

WHALEERP-136. **Saving sends** (2026-10-19 재영 정정 — the admin no longer presses 「발송」):
초안 저장 (`POST` · `PUT` from 임시저장), a 수정 요청 fixed with `PUT`, and every
`PATCH /worker` send the contract in the same request. `POST /contracts/:contractId/send` is
only the 재발송. All of them go through `ContractDeliveryService`.[^contract-delivery]

- **How the 직원 receives it** (`channelOf`): not 가입 완료 and no account for the number
  (`draft_action = SIGNUP_INVITE`) → a **가입 초대** 알림톡 `TALK_STAFF_INVITATION` (근무지 · 초대코드 · 링크)
  and the contract is **발송 대기** — "the invitation went out, waiting for 가입". 가입 완료, or an
  account for the number (소속 추가 · 복귀) → the **앱**, and the contract is **서명 대기** at once.
  앱 알림 does not exist yet, so nothing is sent on that path today (2026-10-19 김민식 — it is
  added with 앱 알림); the status and deadline are set all the same.
- **Every send** sets `sent_at = now` and `sign_deadline_at = now + 30 days` and makes every
  earlier `SENT` invitation of the record `EXPIRED` — only the newest 초대 코드 · 링크 is live, and
  after a number is fixed the old number's code and link are dead. A 가입 초대 adds an `invitations` row: `SIGNUP`
  the first time for that 직원 레코드, `REINVITE` after; channel `ALIMTALK`, `expires_at` 30 days,
  status `SENT`. Each 가입 초대 carries **two keys** (JOIN-7, 2026-10-19 재영 — 진입 · 가입 화면 가이드):
  - **초대 링크 토큰** — 32 random bytes (base64url, 43 characters, `newInvitationToken`); only its
    sha256 is stored in `invitation_token`, like the refresh token and the reset link.
  - **초대 코드** — **8 characters of upper-case letters and digits without 0 · O · 1 · I**
    (`newInvitationCode` — `crypto.randomInt`), typed together with the phone by a 직원 who opens
    the app directly. Only its **HMAC-SHA256 with `JWT_SECRET`** is stored in
    `invitation_code_hash` (`hashInvitationCode`, input upper-cased, indexed): 32⁸ ≈ 1.1 trillion is
    small enough that a plain hash would fall to brute force once a row leaks, and nobody — the admin
    included — needs to read the code back. Invitations sent before the column have no code.

  The record goes 초안 → 초대 발송 (`join_status = INVITED`).
- The link is `STAFF_APP_URL`'s origin + `/invite#token=…` (`inviteLinkOf` — the token in the
  fragment never reaches a server log, like the reset link); opening it skips the code. The code is
  in the 알림톡 **body**. Both are masked in the send log (`maskedVariables: ['초대코드', '링크']`).
  How the 직원 앱 checks them (phone + code with a 5-wrong-tries lock, or the token) is [Staff signup](/api/staff-signup.md), WHALEERP-141 ·
  601. For a 가입 초대, missing `STAFF_APP_URL` or a missing ·
  switched-off template is 503, and a phone that is not a mobile number
  (the contract takes 유선번호 too) is 409 `SEND_PHONE_NOT_MOBILE` — checked inside the save's
  transaction, so **the save itself is refused** and nothing is written.
- **Writes commit first, the 알림톡 goes after** (it cannot be rolled back). When it surely did
  not go out — Bizppurio rejected it with a code, the token step failed (`path /v1/token`), or
  the common module threw before any request — the send is undone: the new invitation and this
  save's history row are deleted, the earlier invitations come back to `SENT` (unless the phone
  changed), and the contract · record return to just before the send. The edits themselves
  (name · phone · contract fields) stay. It is 502 `SEND_FAILED` with `retryable: true` and the
  body carries `contractId` and the `status` it went back to. If the message request went out and
  the answer is lost, nothing is undone and it is 502 `SEND_UNCONFIRMED`, `retryable: false`,
  with `contractId`: sending again could deliver twice. A failed undo is `SEND_UNCONFIRMED` too.
- **Where the undo lands** (`restoredStatusOf`): a new contract or one coming from 임시저장 →
  임시저장 (the creation history row is turned into 임시저장); 수정 요청 → 수정 요청. 발송 대기 · 서명
  대기 go back only while the phone is the same and the 직원 can still be reached — a live
  invitation, or an 앱 직원 in 서명 대기 — otherwise 임시저장 with a `SYSTEM` history row:
  발송 대기 · 서명 대기 mean "it went out", so they are not left behind with nothing out (api #59
  re-review A).
- **What the undo does not bring back** (api #65 review): after a save that changed the phone, the
  old number's invitations, 초대 유형 and candidate account stay gone — the contract keeps what was
  decided for the new number, so the next save does not skip 판별 and land in 서명 대기 with nothing
  sent. After a save that replaced (ended) another contract, the invitations it made `EXPIRED` stay
  expired — some went out for the ended contract.
- Right before sending, `dispatch` reads its invitation again and sends nothing if it is no longer `SENT` — a 발송
  대기 종료 or another send expired it between the commit and the 알림톡, so the code and link would not work (that
  request decided the status). It still runs `undo` for its own unsent invitation (deleted with its unlock row) —
  left behind, a later failed send's undo would revive it as an 「앞 초대」 that never went out (api #144 review).
  `dispatch` then returns false and 재발송 answers 409 (no code) so the screen reads the
  contract again; a save that skipped it already lands on the 상세. The short gap between that read and the send stays.
- The undo only acts while this request's send is still the latest: its invitation still
  `SENT` and the contract's `sent_at` its own. If another request sent or changed the contract
  meanwhile, it deletes only its own (never delivered) invitation and leaves the rest.
- **재발송** (`POST …/send`)[^contract-send]: from 발송 대기 or 서명 대기, with a new 30-day deadline.
  - 가입 전 and no live account for the number: the 가입 초대 again — the status stays, a new code.
  - **가입 완료 (JOINED)**: the same 앱 알림 as the first send (WHALEERP-611) — `prepare` with
    `joined: true` writes the new `sent_at` · `sign_deadline_at` and one `PUSH_CONTRACT_SENT`
    notice (알림함 row + 푸시 대기 row; the push itself is still #261 · #321). No 알림톡, so nothing
    to undo — `dispatch(null)`. No 판별: the 직원's own record is 재직, so `decideInvitation`
    would say 「이미 재직 중」; `draftAction` stays what it was sent with. A 발송 대기 contract of a
    joined 직원 (signup moves them all to 서명 대기, so only odd data) is moved to 서명 대기 with an
    `ADMIN` history row first — the app does not show 발송 대기 contracts. A withdrawn account (no
    path writes `WITHDRAWN` yet) or a JOINED record without `account_id` (signup sets both at once)
    gets the new deadline and no notice, as on the first send (NTF-25) — the missing account is
    logged as an error (broken data), the withdrawn one as a warning. A switched-off or unusable
    `PUSH_CONTRACT_SENT` template also means 200 with no notice (`noticeStaff` skips). The notice is
    an 알림함 row; no app push goes out until #261. 502 · 503 only come from the 가입 초대 알림톡. The 직원 app's
    open sign screen then answers 409 `CONTRACT_RESENT` (its `sentAt` is old) — on purpose.
  - An account but not 가입 at this 점포 (소속 추가 확인 · 복귀 확인): 409 `SEND_CHANNEL_NOT_READY`
    (body carries `draftAction`) — the 직원 app shows no contract to a 후보 계정
    (`my-contract-scope.ts`) and has no 소속 확인 yet, so there is nowhere to receive it.
  - Other statuses are 409 `CONTRACT_STATUS_CONFLICT`. Locks stay 번호 (`lockPeople`) → 직원 행 →
    계약 행 (`lockContractWithStaff`).
  - 직원 목록 `invitation.canResend` mirrors this for the 가입 초대 case — see
    [Staff members](/api/staff-members.md). `RESENDABLE_STATUSES` (`contract-status.ts`) is shared.
- The 알림톡 has **no button yet** — the common module does not send `at.button` and the
  Kakao button name of `WHALE_INVITE_01` is not recorded. The 초대 링크 reaches the 직원 only
  through the SMS fallback (`BIZPPURIO_SMS_FROM`). The new body also waits for Kakao to re-approve
  it, and a rejected 알림톡 is only seen in the result report — so **a 가입 초대 without
  `BIZPPURIO_SMS_FROM` is 503 before anything is written**, until the button is sent and the
  text is approved (api #74 review; the fallback then carries the body with the code and the link).
- Template `TALK_STAFF_INVITATION` moved to 근무지 · 초대코드 · 링크 (초대 링크),
  `invitations.invitation_code_hash` was added, and every `SENT` 가입 초대 without a code (sent
  before; the old `/invite/{token}` link) was made `EXPIRED` — the 관리자 sends again — with migration
  `20261020144028_team3_staff_invitation_code` — deploy right after the merge (the code passes `초대코드`; before the
  migration every 가입 초대 fails as an unknown variable and the save is undone). The Kakao
  template text has to be re-approved to match.
- `ContractsModule` imports `AlimtalkModule`, so **the api does not start without
  `BIZPPURIO_*`** (2026-10-16 김민식 결정: required). e2e (`test/e2e-env.ts`) and
  `openapi:export` fill format-only values when they are empty.
- 발송 대기 does **not** expire: an unanswered 가입 초대 past its 30 days only has its invitation made `EXPIRED` by the
  daily batch, and the contract stays 발송 대기 so 직원 목록 「초대 만료 → 재발송」 still works. A 만료 contract has no
  way back until 재발송 (WHALEERP-153) is decided (api #150 review — see
  [Employment contract batch](/api/employment-contract-batch.md)).

# Telling the 사업자 관리자: 날인 · 거부 · 만료 · 갱신 예정

WHALEERP-154 · 152. `ContractNoticeService` sends an 운영 알림 (`notify`) and a mail (`MailService.send`) separately
to the 관리자 who run the 직원's store (`storeManagers` — a 가맹 store's 본사 역할 only for 본사 제공 동의 staff); one
failing does not stop the other, and the 운영 알림 carries no mail (NTF-03). Templates are `NTF_CONTRACT_*` /
`EMAIL_CONTRACT_*` (SIGNED · REJECTED · EXPIRED · RENEWAL_DUE). The mail button goes straight to the 계약 상세
(`ADMIN_WEB_URL` + `/contracts/:id`), so reading the mail does not mark the 알림함 row read. Mail results go to
`mail_send_logs` (MailService); 관리자 without an email are skipped, and no `MAIL_*` or `ADMIN_WEB_URL` skips the
mail only (`optionalMailServiceProvider`, like 문의 답변).

- **날인 · 거부** (직원 앱): after the commit, keyed by that 상태 이력 ID — the response does not wait for it (an SMTP
  stall must not look like a failed 날인).
- **만료**: the daily batch, after its commit, keyed by the 만료 이력 ID (`transitionManyWithHistory`).
- **갱신 예정**: the daily batch picks 체결 완료 contracts ending within 30 days that have no `renewal_notified_at`,
  skipping those where 「make a new contract」 is not needed — judged against **that contract's own end date**: the
  직원 is 퇴직 or has a 퇴직일 on or before it (a later 퇴직일 still counts: they keep working after the contract ends),
  or the same 직원 already has a contract in progress or a 체결 완료 one that ends after it (or has no end date) —
  even if that one also ends inside the 30 days (`needsRenewal`, api #150 review),
  stamps it in the same transaction, and notifies after the commit, keyed by the contract ID — once per contract,
  even if sending then fails (mail logs have no contract column to dedupe on).
- The 거부 운영 알림 template has no 근무지; passing a variable the template lacks throws in the renderer, so the
  service builds each template's variables separately. An empty 거부 사유 is sent as 「없음」 (the renderer would leave
  「사유 · 」 blank). Nothing here throws — failures are
  logged.

# Fixing the 근로자 before 날인: PATCH /contracts/:contractId/worker

WHALEERP-125 「본인 대조」 · 126 (2026-10-16). For a contract in 발송 대기, 서명 대기 or
수정 요청 it replaces name · phone · 생년월일 · 성별 · 외국인 여부 (`UpdateWorkerDto`, the same
field rules as `POST` — all required, `isForeigner` defaults to false). Other statuses are
409 `CONTRACT_STATUS_CONFLICT`. It is how the admin fixes a number after a phone call
(「링크를 못 받았어요」) or answers a 수정 요청. A 가입 완료 직원's phone cannot change here
either (400, as in `PUT`).

- **Saving sends again** (2026-10-19 재영): a new 30-day deadline and the earlier links dead. A
  가입 초대 stays 발송 대기 (a new invitation goes out), an 앱 직원 stays or becomes **서명 대기** — a
  수정 요청 goes straight to 서명 대기 (`ADMIN` history), never through 발송 대기. A new phone with
  no account turns 서명 대기 into a 가입 초대 (발송 대기).
- A **new phone** re-runs, for the new number: 재직 확인, the same-store duplicate check
  (409 `CONTRACT_IN_PROGRESS`, confirmed with `replaceContractIds`), the other-store
  근무 시간 겹침, and 초대 유형 판별 (`draft_action`, `candidate_account_id`). Both numbers are
  locked. Changing the phone needs the store per store (403 otherwise), as in `PUT`.
- `contract_parties` gets the new values; the 직원 레코드's name and phone follow unless it
  is 가입 완료 (`JOINED`) — then the record carries account values and is left alone.
- 만 19세 미만 on the contract's start date is 400.

# Ending a 발송 대기: POST /contracts/:contractId/end

WHALEERP-327 · 155, 2026-10-21 재영 A안 (운영 정책 CTR-19). When hiring is called off the admin closes a 발송 대기
contract as 종료: an `ADMIN` history row, and every `SENT` invitation of that 직원 레코드 becomes `EXPIRED` so the code
and link stop working — otherwise a later 가입 would move the contract on to 서명 대기. The row stays (it was sent, so
there is a record to keep; a 임시저장 is deleted instead). The leftover 가입 전 직원 레코드 is cleaned up with 퇴직
처리 (CTR-25). Any other status is 409 `CONTRACT_STATUS_CONFLICT` with the current status. 수정 permission
(`@MenuPermission('update')`), same scope and locks as 재발송 (`ContractSendService.end`).

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
| 임시저장 `DRAFT` | 발송 대기 (초안 저장 — 가입 초대) · 서명 대기 (초안 저장 — 앱 직원) · 체결 완료 (종이 계약 등록) · 종료 (대체 · 퇴직) |
| 발송 대기 `PENDING_SEND` | 서명 대기 (가입 · 당사자 정보 수정으로 앱 직원이 됨) · 종료 (대체 · 퇴직 · 관리자 종료 `POST …/end`) — never 만료: only the 초대 expires, so it can be resent |
| 서명 대기 `PENDING_SIGNATURE` | 체결 완료 (날인) · 거부 · 수정 요청 (직원) · 발송 대기 (계정 없는 번호로 고침) · 만료 · 종료 |
| 수정 요청 `CORRECTION_REQUESTED` | 서명 대기 (관리자가 고침) · 발송 대기 (계정 없는 번호로 고침) · 종료 (대체 · 퇴직) — never 만료: the deadline does not run |
| 체결 완료 `SIGNED` | 종료 (계약 기간 끝 · 재계약으로 이어지는 계약의 시작일 — 하루 배치, 대체 · 퇴직) |
| 거부 · 만료 · 종료 | — (재발송 WHALEERP-153 is not decided yet) |

A contract's first status (임시저장, 발송 대기 · 서명 대기 when saved, or 체결 완료 for a 종이 계약)
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
- `rejectContract` — 서명 대기 → 거부 (`STAFF`). `reject_reason` is optional (WHALEERP-145, 2026-10-21):
  trimmed, empty is NULL, over 500 chars 400. Past `sign_deadline_at` it is 409 `SIGN_DEADLINE_PASSED`
  like the other two.
- The 직원 앱 routes are [Staff app: 날인 · 거부 · 수정 요청](#staff-app-날인--거부--수정-요청) below.
- Moved onto it: `PUT` 임시저장 → 발송 대기 · 서명 대기, 대체 (발송 대기 · 서명 대기 →
  종료), the 만료 batch. 퇴직 처리 (`staff-members/retirement.service.ts`)
  still writes the same rule (진행 중 → 종료 + history) itself.

# Staff app: 날인 · 거부 · 수정 요청

WHALEERP-145 (2026-10-21). `MyContractsController`, `me/contracts`, account tokens only (admin 403),
20 calls per account per 10 minutes **per route**. Reading the contract for the app is WHALEERP-610 — see
「Staff app: 내 계약 목록 · 상세」 below.

- **Mine** (`my-contract-scope.ts`, shared with the read API below) means the contract's 직원 레코드 is
  linked to this account (`staff_members.account_id`) and the contract is in 서명 대기 or later — a
  임시저장 or 발송 대기 is not the 직원's yet. Someone else's contract and one waiting for 소속 추가 확인 ·
  복귀 확인 (only `candidate_account_id` points at the account) are the same 404 「근로계약을 찾을 수
  없습니다」 (before api #115 a 발송 대기 got 409 here while the read API said 404, which leaked that it
  existed).
- All three need 서명 대기 within `sign_deadline_at`: otherwise 409 `CONTRACT_STATUS_CONFLICT` with the
  current `status` (a double tap gets `status: SIGNED` — the app treats that as done) or 409
  `SIGN_DEADLINE_PASSED`. A 직원 who is 퇴직 or past the 퇴직일 (from the day after, before the
  `retireDue` batch closes the contract) gets 409 `STAFF_RETIRED` (CTR-25 — no 날인 after 퇴직).
- **Locks**: each write locks the 직원 row — `FOR SHARE` for 거부 · 수정 요청, `FOR NO KEY UPDATE` for 날인 because it
  writes the 입사일 (below; taking `FOR SHARE` and then writing could deadlock with another `FOR SHARE` holder, both
  waiting to upgrade) — then the contract row `FOR UPDATE`, then reads
  again — the same order as 퇴직 확정 (직원 row `FOR UPDATE`, then it closes the pending contracts). With
  only the contract row locked, a 날인 could commit first and 퇴직 확정's `UPDATE … WHERE status` would
  skip it, leaving a 퇴직 직원 with a 체결 완료 contract (api #101 review). **Every writer of a 가입
  직원's row takes it before any contract row** (`lockStaffMember` in `contract-status.ts`): 이어 쓰기
  (`PUT`, it writes `employmentType` · `jobTitle`) locks the 직원 row `FOR NO KEY UPDATE` right after the
  phone lock and before its own contract and the contracts it replaces, and 409s if the contract's 직원
  changed in between (api #104 — before, contract → 직원 row deadlocked with 날인 · 거부 · 수정 요청,
  40P01 → 500). `FOR NO KEY UPDATE`, not `FOR UPDATE`: it still waits for 날인 · 거부 · 수정 요청 and 퇴직's
  `FOR UPDATE`, but does not block rows that reference the 직원 (초대 · 근무스케줄 · TO-DO 배정).
  Among the 관리자 근로계약 paths only 이어 쓰기 writes a 가입 직원 row; 퇴직 처리 and 가입 also write
  직원 rows but take the 직원 row first.
  The other 관리자 paths that write or delete a 직원 row while changing a contract take the same order
  through `lockContractWithStaff` (read the contract's 직원, lock it `FOR NO KEY UPDATE`, then the contract):
  근로자 정보 수정, 삭제, 재발송, 대체 (`replaceContracts` — it may delete the replaced contract's 가입 전
  record), and 발송 되돌리기 (`undo`, it already knows the 직원). With some still contract-first, 이어 쓰기 ×
  삭제 or 이어 쓰기 × 발송 되돌리기 deadlocked, and a lost 발송 되돌리기 left an un-sent contract looking
  sent (api #104 re-review).
  **Several 직원 rows go in id order, all at once.** A save that may replace contracts (저장, 이어 쓰기, 근로자
  정보 수정) locks, right after the phone lock, its own 직원 row together with every 직원 row holding a contract at
  that store under that phone — `lockStaffForReplace` (`contract-duplicates.ts`), one `ORDER BY staff_member_id
  FOR NO KEY UPDATE`. Taking its own row and then the replaced ones one by one in contract id order deadlocked with
  the daily batch, which locks its 직원 rows in id order (api #150 review). The phone lock keeps the set from growing
  meanwhile; `replaceContracts` then finds those rows already held.
  **Known limit**: 종이 계약 이어 쓰기 uploads inside its transaction (up to 60s) while holding the 직원 row,
  so anything that locks that 직원 row waits and may time out (P2028 → 500) during a slow upload — the
  직원's app actions, 근무스케줄 저장, and TO-DO 생성 for the whole store (`todos.service` locks the store's
  직원 rows `FOR SHARE`). Moving the upload out of the transaction is left for later.
  Deadline and 퇴직일 are checked against the time after the locks, not the request time.
- **`POST /me/contracts/:contractId/sign`** — multipart: `signature` (PNG by content, ≤ 1MB, must decode),
  **required** `sentAt` (the 발송 일시 the 직원 saw, as the app received it; missing · not a date · no time
  zone offset → 400 — without it a re-sent contract could be signed unseen, and an offset-less value would be
  read in the server's zone and turn the same 발송 into 409, 2026-10-21 김민식). The PNG must be at most 4096px each
  side and **decode in full** (`sharp` `stats`, not only the header) — the 처리 완료본 merge (131) runs after
  체결 완료 and could not undo a bad image. Checks before any upload: mine · status · deadline ·
  `sentAt` (differs → 409 `CONTRACT_RESENT`, the 관리자 fixed and re-sent meanwhile) · **본인 대조**
  (`identity-match.ts`): 이름 (spaces removed, upper-cased), 휴대전화번호 (digits), 생년월일, 성별, 외국인
  여부 of the contract party against the account — any difference is 409 `IDENTITY_MISMATCH` with
  `mismatches` and the 직원 sends a 수정 요청. An empty contract value is a mismatch, and so is an empty
  account 성별 — signup requires 성별 (api #107, 운영 정책 ACC-23 · JOI-10, 2026-10-21 재영), so all five are
  always compared. An account made before that (signup with 성별 optional, migration
  `20261021103042_team3_staff_signup` added the column with no default) has none and **cannot sign** — there
  is no API to fill it: 성별 is an identity value, read-only after signup (내 정보 has no 성별, 2026-10-19), and
  관리자 APIs never write `accounts.gender`. This is acceptable only because such accounts exist **only in the
  shared dev DB** (2026-10-21: one, `test.staff01`, no contract yet; the 운영 DB starts with 성별 required) — fill
  them in the DB directly (재영 owns that test data). Do not add a skip for an empty account 성별 (재영 2026-10-21
  rejected it). The check reads inside a transaction only so Prisma sends the relation queries one after another on one
  connection (no lock); consistency comes from the re-check after the lock. Then the PNG is uploaded outside
  the transaction (`contracts/{id}/…png`, no thumbnail; storage not configured → 503), and one
  transaction takes the locks above, reads again and re-checks everything (a 관리자 may have changed the
  근로자 or finished a 퇴직 meanwhile), runs `signContract` (which also fills the 입사일, below), adds a `contract_documents` row
  `kind = SIGNATURE` (`서명-{id}.png`, sha256) and **copies the account's address into
  `contract_parties` (`zip_code` · `address` · `address_detail`, `filled_at` now)** so the signed contract
  does not change with later address edits (`filled_at` is set here — the column note 「가입 완료 시」 is
  the logical ERD's older wording). On a failure the uploaded key is deleted only when no
  `contract_documents` row points at it (the commit may have gone through with only the reply lost —
  deleting would leave a 체결 완료 contract whose 처리 완료본 can never be made); if that lookup fails
  too, the key is kept and logged. A failed upload also tries a delete (a timeout may have stored it). 200
  `{ contractId, status: SIGNED, signedAt }` — `signedAt` is the history row's `changed_at` (DB clock).
- The `SIGNATURE` document is **not shown to the 관리자**: `GET /contracts/:id` leaves it out of
  `documents` and its download URL is 404 — it is the material the 처리 완료본 (131) merges.
- **`POST …/reject`** — JSON `{ reason? }` (≤ 500 after trimming, `null` is 400). 200 `{ contractId, status: REJECTED }`.
- **`POST …/correction-request`** — no body. Taken whatever the 대조 says (a wrong wage is a reason too —
  WHALEERP-125 「계약서가 틀렸으면」). 200 `{ contractId, status: CORRECTION_REQUESTED }`.
- The 처리 완료본 (signature merged into a PDF, `SIGNED_COPY`) is WHALEERP-131; 날인 · 거부 알림 is
  WHALEERP-154. The 처리 시각 and actor are the history row (`STAFF`); the 직원 is the account linked to
  the record (1:1), so no extra column.

# Staff app: 내 계약 목록 · 상세

WHALEERP-610 (2026-10-21). `MyContractViewsController`, `me/contracts`, account tokens only (admin 403). Same
path as 날인 · 거부 · 수정 요청 but a separate controller so the per-account request limit there does not
apply to reading.

- **Visible**: the same 「내 계약」 as 날인 (`myContractWhere`): contracts of the 직원 레코드 linked to this
  account (`staff_members.account_id`) in 서명 대기 or later (`PENDING_SIGNATURE` · `CORRECTION_REQUESTED` · `SIGNED` · `REJECTED` · `EXPIRED` · `ENDED`).
  임시저장 and 발송 대기 are not the 직원's yet (mockup: 발송 대기 is not in the list); someone else's
  contract and one waiting for 소속 추가 확인 (only `candidate_account_id`) are absent too — the detail
  is the same 404 「근로계약을 찾을 수 없습니다」 for all of them. A 퇴직 직원 still sees their contracts.
- **`GET /me/contracts`** — all of them, not paged (a 직원 has a handful): `{ items, total }`. A row is
  `contractId` · `status` · `storeId` · `storeName` (근무지 — the app groups by it) · `employmentType`
  (the contract's copy; the 직원 레코드's when empty, as in the 관리자 detail) · `contractMethod` · `startDate` · `endDate` · `sentAt` · `signDeadlineAt` ·
  `processedAt` · `awaitingSignature`. `processedAt` is the last status-history row's `changed_at` when it
  is the current status (날인 일자, a 종이 계약's 등록일, 거부 · 만료 · 종료 일자), else null; for 서명 대기
  it is `sentAt` (re-sending while still 서명 대기 adds no history row, only a new `sent_at`).
  `awaitingSignature` = 서명 대기 · before `sign_deadline_at` · 재직 중 (the same checks 날인 makes, not the
  본인 대조) — the 날인 요청 팝업 (WHALEERP-148) picks these. Order: awaiting first by nearest deadline, then
  the rest by `processedAt` newest, then `contractId` desc. A 날인 대기 with no deadline goes after the
  dated ones; a row with no `processedAt` (state restored without history) sorts by `sentAt`.
- **`GET /me/contracts/:contractId`** — the list row plus the contract terms (`ContractTermsDto`, the same
  fields and conversion as the 관리자 detail via `contract-terms.ts`: dates, 근무장소, 주휴일, 시급 · 수당,
  hours, 연차 · 퇴직금 문구, 지급, 수습, 4대보험 두 칸, `workDays`), and:
  - `worker` — the contract's 근로자 칸 (관리자 entered 이름 · 번호 · 생년월일 · 성별 · 외국인 여부, the
    직원 레코드's 직무, and the address fixed at 날인 — empty before). An old contract with no party row
    shows the 직원 레코드's 이름 · 번호 like the 관리자 detail; the 대조 still uses an empty contract.
  - `employer` — the 사용자 칸: the store's name · phone · address and its `store_business_profiles` 상호 ·
    사업자등록번호 · 대표자 · 사업장 주소 (null until registered). A missing store row is broken data → 500.
  - `account` — 「본인인증으로 확인된 정보」: the account's 이름 · 번호 · 생년월일 · 성별 · 외국인 여부 ·
    주소.
  - `mismatches` — `identityMismatches` against the account, exactly what 날인 would 409 with
    (`EMPTY_CONTRACT_IDENTITY` when there is no party row); `signable` = `awaitingSignature` and no
    mismatches.
  - `documents` — `{ contractDocumentId, kind, fileName }`, without the 직원 필기 서명 (`SIGNATURE`).
    There is no download route for the 직원 yet — it comes with the 처리 완료본 (WHALEERP-131).
  - `sentAt` is what the app sends back on 날인 (a different value is 409 `CONTRACT_RESENT`).
- **Clause text** is not built here: there is no clause template yet (노무사 검토 중, mockup
  `contract.html`), so the API gives values and the app lays out 제1~10조; the template moves to
  WHALEERP-131.
- Reads run in one transaction only so Prisma sends the relation queries one after another (PGlite e2e).

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
[^contract-delivery]: 근로계약 보내기 (WHALEERP-136)
[^contract-send]: 근로계약 재발송 (WHALEERP-136 · 611)
[^list-query]: ListContractsQueryDto
[^admin-scope]: AdminScopeService
