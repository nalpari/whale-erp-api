---
type: API
title: Store management
description: 관리자 웹 「점포 정보 관리」(MN000002) — list, register, edit, status change and delete of 1팀 stores with their floors, 사업자정보 and change history; one-way status, operating needs 사업자 인증 and coordinates, and the 국세청 check is an empty slot for now.
tags: [admin, store, permission]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-14T06:00:00Z }
sources:
  - id: store-management-service
    resource: ../../src/stores/store-management.service.ts
    title: StoreManagementService (list · detail · histories · transitionCheck · create · update · remove · verifyBusiness)
    last_modified: 2026-10-14T06:00:00Z
  - id: stores-controller
    resource: ../../src/stores/stores.controller.ts
    title: /stores routes and the MN000002 permission per action
    last_modified: 2026-10-14T06:00:00Z
  - id: store-format
    resource: ../../src/stores/store-format.ts
    title: 상태 전환 · 운영 조건 · 진행 중 근로계약 · 이력 보존 기한
    last_modified: 2026-10-14T06:00:00Z
  - id: store-business-verifier
    resource: ../../src/stores/store-business-verifier.ts
    title: STORE_BUSINESS_VERIFIER — 국세청 진위확인 slot (null today)
    last_modified: 2026-10-14T06:00:00Z
  - id: save-store-dto
    resource: ../../src/stores/dto/save-store.dto.ts
    title: CreateStoreDto · UpdateStoreDto · VerifyStoreBusinessDto
    last_modified: 2026-10-14T06:00:00Z
---

# What it covers

The 관리자 웹 menu MN000002 「점포 정보 관리」 (`/stores`): list S-BAYAJS, register,
detail S-AGGZZG, status change S-MNRZOM, edit S-JEPOMK and delete. It manages 1팀's
`stores` with `store_floors`, `store_business_profiles` and
`store_change_histories`.[^store-management-service]

The source was the front repository's demo, mockups, flow chart and
`okf/stores.md` (which carries the STORE-1 – 4 decisions), plus the 1팀 physical
ERD. The Manyfast 기능명세서 itself could not be read (2026-10-14), so a rule that
exists only there is not here.

Out of the first cut, each for want of infrastructure rather than a decision:

- **국세청 사업자 진위확인.** `STORE_BUSINESS_VERIFIER` is `null`, so anything
  that asks for verification is a 503 — and since operating needs a verified
  number, **no store can become 운영 until the integration exists.**[^store-business-verifier]
- **대표 이미지.** There is no file storage; `store_image_files` is untouched.
- **엑셀 다운로드** (immediate under 10,000 rows, scheduled with a mailed link
  above), and the 주소 검색 / 좌표 계산, which the screen does on its own.

# Who sees which stores

Every route checks the menu permission for its action first (read · create ·
update · delete), then the scope:[^stores-controller]

- **플랫폼 계정 (PM · PA)** see every BP's stores. Registering needs `bpCodeId` in
  the body (400 without it); the platform BP itself cannot get stores.
- **BP · 가맹 계정** see their own BP's stores — all of them with
  `is_all_stores`, otherwise only the mapped ones. Sending another `bpCodeId` is a
  400.
- **가맹 역할 (FM · FA) cannot register**, whatever the permission flags say
  (F-MOQKGY). Status changes need only the update permission, for every role
  (STORE-1).
- An account with only some stores mapped is **mapped to the store it registers**;
  without that it could not see what it just made. 전체 점포 accounts need no row.

This scope is the store screen's own. `AdminScopeService` still keeps platform
accounts out of customer stores (WHALEERP-301), and its `hidesPersonalData` is for
staff personal data — a BM manages franchise stores even though it may not see
their staff.

`GET /stores/options`, the 근로계약서 근무지 dropdown, is a different question
("where may I write a contract") and stays with its own rules — see
[Contracts API](/api/contracts-api.md).

# Status moves one way

`NOT_OPERATING` (미운영) → `OPERATING` (운영) → `CLOSED` (폐점), and 미운영 may go
straight to 폐점. Nothing goes back; reopening is a new store. Registration always
creates 미운영. The status travels in the same `PUT` as the rest of the form, so a
status change and other edits commit together.[^store-format]

- **운영 needs** a 사업자등록번호 (having one *is* being verified — there is no
  separate flag), both coordinates, and an active BP. This is checked on every save
  of an operating store too, so clearing the coordinates of a 운영 store is a 400.
  Phone and address may be empty, and 휴업 · 폐업 is not looked at (STORE-2).
- **폐점 and 삭제 need no contract in progress**: `DRAFT`, `PENDING_SEND`,
  `PENDING_SIGNATURE` or `SIGNED` at that store. 구독 · 정산 are outside the first
  phase and reported as unchecked (`isSubscriptionChecked: false`). 폐점 sets
  `closed_date` to today in Korea and takes no reason; admin mappings stay.
- **삭제** is 미운영 only and a flag (`is_deleted`). A 폐점 store is kept, read-only.
- **A 소속 BP that is not `ACTIVE`** leaves the store readable and nothing else:
  register, edit, status change and delete are 409, and the store's status stays
  as it was (STORE-3).

The detail carries `transitions` (what 운영 still needs, the in-progress contract
count, `canClose`, `canDelete`) so the screen can enable its buttons, and
`GET /stores/:id/transition-check` answers the same when the edit screen picks 폐점.
The save checks again; the screen's answer is advice.

# 사업자등록번호

Unique **among undeleted 미운영 · 운영 stores**, across all BPs; a 폐점 or deleted
store's number is free again. The rule cannot be a partial unique index — the status
lives in `stores`, the number in `store_business_profiles` — so the save takes
`pg_advisory_xact_lock` on the number and counts again inside the transaction. Two
stores verifying the same number at once leave one.

The number, 대표자명 and 개업일자 are written **only from a verification the server
itself made during the save**; `businessVerification` in the body is re-checked with
국세청, never trusted from the screen. The duplicate check runs before 국세청 is asked,
and a duplicate does not say who holds the number. Once saved, the number and
개업일자 are fixed: re-verification sends the same two (400 otherwise) and changes
only the 대표자명 and 인증일시. A failed re-verification changes nothing.
`POST /stores/business-verifications` is the screen's preview of that check
(`VERIFIED` · `UNVERIFIABLE` · `DUPLICATE`, 503 when the integration is missing or
fails); it needs the create or the update permission.

The 상호명, 대표자 연락처, 사업자주소, 업태 and 종목 are typed by hand and saved whether
or not the store is verified. Numbers are compared and stored as digits only, so a
hyphenated search matches.

# Saving

`PUT` is the whole form: an optional field left out is cleared. It carries the
`updatedAt` from the detail and is a 409 if anyone saved in between (compared within
the millisecond, `sameMillisecond`). Floors are replaced as a set when they differ —
old rows flagged deleted, new rows inserted.

Every changed item becomes one `store_change_histories` row with the Korean label
the demo shows (점포명, 점포 연락처, 주소, 위도 · 경도, 위치 적용 여부, 점포상태, 층별 정보,
상호명, 대표자 연락처, 사업자주소, 업태, 종목, 사업자등록번호, 대표자명, 개업일자), plus 등록
and 삭제. `retain_end_date` is the Korean date plus five years, and the history list
shows only rows still inside it.

**점포코드** is `ST` + six digits, the one after the highest code ever issued —
deleted stores included, so a code is never reused — taken under an advisory lock
so two registrations cannot pick the same one. There is no sequence in the schema
to lean on.

# Traps

- `GET /stores` was the 근무지 dropdown until 2026-10-14. That moved to
  `/stores/options`, and front's `contracts/new/load-form-data.ts` has to follow.
- The 업태 · 종목 limit is 50 (DB CHECK, ERD); the demo's 30 was not followed.
- Contracts have no deletion flag; the in-progress count is by status alone.

[^store-management-service]: StoreManagementService (list · detail · histories · transitionCheck · create · update · remove · verifyBusiness)
[^stores-controller]: /stores routes and the MN000002 permission per action
[^store-format]: 상태 전환 · 운영 조건 · 진행 중 근로계약 · 이력 보존 기한
[^store-business-verifier]: STORE_BUSINESS_VERIFIER — 국세청 진위확인 slot (null today)
