---
type: API
title: Store management
description: 관리자 웹 「점포 정보 관리」(MN000002) — list, register, edit, status change and delete of 1팀 stores with their floors, 사업자정보, 대표 이미지 (`PUT · DELETE /stores/:id/image`), 엑셀 바로 받기 (`GET /stores/excel`) and change history; one-way status, operating needs 사업자 인증 and coordinates, and the 국세청 check uses the same client as BP signup.
tags: [admin, store, permission, storage]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-21T01:46:17Z }
sources:
  - id: store-management-service
    resource: ../../src/stores/store-management.service.ts
    title: StoreManagementService (list · detail · histories · transitionCheck · create · update · remove · verifyBusiness · putImage · removeImage · excel)
    last_modified: 2026-10-20T06:55:00Z
  - id: stores-controller
    resource: ../../src/stores/stores.controller.ts
    title: /stores routes and the menu permission per action (`/stores`, MN000002 today)
    last_modified: 2026-10-21T01:46:17Z
  - id: store-excel
    resource: ../../src/stores/store-excel.ts
    title: 점포 목록 엑셀 — 열 · 연락처 가림 · 1만 건 · 1분 1회
    last_modified: 2026-10-20T00:28:43Z
  - id: store-format
    resource: ../../src/stores/store-format.ts
    title: 상태 전환 · 운영 조건 · 진행 중 근로계약 · 이력 보존 기한 · 라벨
    last_modified: 2026-10-21T01:46:17Z
  - id: store-business-verifier
    resource: ../../src/stores/store-business-verifier.ts
    title: STORE_BUSINESS_VERIFIER — 국세청 진위확인 slot
    last_modified: 2026-10-15T05:28:40Z
  - id: nts-store-business-verifier
    resource: ../../src/stores/nts-store-business-verifier.ts
    title: NtsStoreBusinessVerifier — 점포 값을 국세청 클라이언트 모양으로
    last_modified: 2026-10-15T06:37:12Z
  - id: save-store-dto
    resource: ../../src/stores/dto/save-store.dto.ts
    title: CreateStoreDto · UpdateStoreDto · VerifyStoreBusinessDto
    last_modified: 2026-10-15T00:24:23Z
  - id: list-stores-query
    resource: ../../src/stores/dto/list-stores-query.dto.ts
    title: ListStoresQueryDto · StoreExcelQueryDto · StoreHistoryPageDto
    last_modified: 2026-10-15T01:03:59Z
  - id: store-response
    resource: ../../src/stores/dto/store.response.dto.ts
    title: 목록 · 상세 · 이력 · 이미지 · 인증 결과 응답
    last_modified: 2026-10-15T00:24:23Z
  - id: stores-module
    resource: ../../src/stores/stores.module.ts
    title: StoresModule — StorageModule, NtsModule verifier provider
    last_modified: 2026-10-20T06:55:00Z
  - id: api-enums
    resource: ../../src/enums/api-enums.ts
    title: API 전용 enum — StoreOperationRequirement · StoreBusinessVerificationResult
    last_modified: 2026-10-15T09:12:30Z
  - id: stores-db-e2e
    resource: ../../test/stores-db.e2e-spec.ts
    title: 실제 DB e2e — 동시성은 E2E_REAL_POSTGRES=1 에서만
    last_modified: 2026-10-15T01:58:31Z
---

# What it covers

The 관리자 웹 menu MN000002 「점포 정보 관리」 (`/stores`): list S-BAYAJS, register,
detail S-AGGZZG, status change S-MNRZOM, edit S-JEPOMK and delete, plus the 대표
이미지 and the 엑셀 download. It manages 1팀's `stores` with `store_floors`,
`store_business_profiles`, `store_image_files` and
`store_change_histories`.[^store-management-service]

The source was the front repository's demo, mockups, flow chart and
`okf/stores.md` (which carries the STORE-1 – 4 decisions), plus the 1팀 physical
ERD. The Manyfast 기능명세서 itself could not be read (2026-10-14), so a rule that
exists only there is not here.

Out of the first cut, each for want of infrastructure rather than a decision:

- **엑셀 예약 생성** for 10,000 rows and more (a stored file, kept 24 hours, mailed
  as a link) — it needs a request table, a background job and a mail template.
  Until then that size is a 400.
- The 주소 검색 / 좌표 계산, which the screen does on its own.

# Who sees which stores

Every MN000002 route carries `@MenuPermission(action)` for its action
(read · create · update · delete; `auth/menu-permission.guard.ts`, which also adds
`@UserTypes('admin')`) — the guard finds the menu by the controller path `/stores`,
MN000002's URL, so sub-paths such as `/stores/:id/image` are judged by it too (since
2026-10-21; before that each route named `MN000002`) — then the service applies the scope.[^stores-controller] Until
2026-10-20 only the image upload used the guard and every other handler called
`MenuPermissionsService.assert` itself; 1팀 moved them all to the guard, like the other
관리자 웹 screens ([admin authentication](/api/admin-auth.md)).

**The permission now comes first on every route.** A guard runs before pipes and the
handler, so an admin without the right — or an account no longer in use — gets 403
even for a malformed request (which used to be the validation pipe's 400) or an id
outside `1..2147483647` (which used to be 404). An admin with the right sees the same
answers as before. For the upload this was already so, and it is why the upload used
the guard first: a Nest interceptor runs after the guards, so the 403 comes before
`AttachmentsInterceptor` buffers up to 5MB of multipart. The multipart size and count
(400) come after the guard, and the file kind is checked in the service.

**The controller hands the service only `user.id`.** `loadCaller` reads the account
once — role type, role group, 소속 BP, `is_all_stores`, `bpCode.isPlatform` — and
refuses (「사용할 수 없는 계정」 403) an account that stopped being usable after the
guard passed. It does **not** re-check the menu right: the upload's old second
in-handler check, which also caught a permission withdrawn while the multipart was
being read, is gone, so such an upload now completes. On `POST /stores` that read now
happens before the coordinate-pair check, so an unusable account gets its 403 ahead
of that 400.

- **플랫폼 계정** see every BP's stores. A platform account is **PM or PA _and_
  belongs to the platform BP** (`bp_codes.is_platform`) — the same test as
  `AdminScopeService.isPlatformAdmin` and the guard's `platformOnly` (`isPlatformRole`),
  though this screen takes no `platformOnly`. `loadCaller` reads `bpCode.isPlatform` with
  the account and puts `isPlatform` on the caller; the role type alone is not
  enough, or a PM · PA row filed under a customer BP would open every BP's stores.
  Registering needs `bpCodeId` in the body (400 without it); the platform BP itself,
  or an unknown or deleted BP, is a 400.
- **Every other account** sees its own BP's stores — all of them with
  `is_all_stores`, otherwise only the mapped ones. Registering into another BP is a
  400; a list or excel filter on another `bpCodeId` just matches nothing. **A PM · PA
  in a customer BP is treated exactly like this** — own BP, mapped stores when not
  전체 점포, registering without `bpCodeId` goes into its own BP — rather than being
  refused outright: the menu permission it holds is still honoured, and only the
  cross-BP reach is withheld. Such a row is a data mistake (platform roles belong to
  the platform BP), so the safe reading is the narrower scope, not a 403 that would
  also lock it out of its own stores.
- **가맹 역할 (FM · FA) cannot register**, whatever the permission flags say
  (F-MOQKGY). Status changes need only the update permission, for every role
  (STORE-1).
- An account with only some stores mapped is **mapped to the store it registers**;
  without that it could not see what it just made. 전체 점포 accounts need no row.
- 403s use the shared admin wording (`auth/access-messages`) — the 관리자 웹 branches
  on it, so this module coins none of its own.

This scope is the store screen's own. `AdminScopeService` still keeps platform
accounts out of customer stores (WHALEERP-301), and its `hidesPersonalData` is for
staff personal data — a BM manages franchise stores even though it may not see
their staff.

`GET /stores/options`, the 근로계약서 근무지 dropdown, is a different question
("where may I write a contract"), takes no menu permission and stays with its own
rules — see [Contracts API](/api/contracts-api.md).

# Status moves one way

`NOT_OPERATING` (미운영) → `OPERATING` (운영) → `CLOSED` (폐점), and 미운영 may go
straight to 폐점. Nothing goes back; reopening is a new store. Registration always
creates 미운영. The status travels in the same `PUT` as the rest of the form, so a
status change and other edits commit together.[^store-format]

- **운영 needs** a 사업자등록번호 (having one *is* being verified — there is no
  separate flag), both coordinates, and an active BP. **It is checked only on the move
  into 운영**, not on every save of a store that is already 운영: such stores exist
  without a number (11 on the shared development DB, 2026-10-15, entered before this
  API, with no verification behind them), so
  checking every save would leave them editable only by closing them. The one thing
  refused on an operating store is removing coordinates it has (400 — attendance
  checks location against them). A verification sent in the same `PUT` counts. Phone and address may be empty, and
  휴업 · 폐업 is not looked at (STORE-2). What is missing is listed in the detail's
  `transitions` and in `transition-check` as the API enum `StoreOperationRequirement`
  (Korean in `GET /enums`); the `PUT` that falls short is a 400 naming the same items
  in Korean — an inactive BP is a 409 before that.
- **폐점 and 삭제 need no contract in progress**: `DRAFT`, `PENDING_SEND`,
  `PENDING_SIGNATURE`, `CORRECTION_REQUESTED` (3팀 수정 요청, 2026-10-16) or `SIGNED` at that store. 구독 · 정산 are outside the first
  phase and reported as unchecked (`isSubscriptionChecked: false`). 폐점 sets
  `closed_date` to today in Korea and takes no reason; admin mappings stay.
- **삭제** is 미운영 only and a flag (`is_deleted`). A 폐점 store is kept, read-only.
- **A 소속 BP that is not `ACTIVE`** leaves the store readable and nothing else:
  register, edit, status change, delete and the image routes are 409, and the
  store's status stays as it was (STORE-3). The 사업자 인증 preview
  (`POST /stores/business-verifications`) does not look at the BP — it only answers.

The detail carries `transitions` (what 운영 still needs, the in-progress contract
count, `canClose`, `canDelete`) so the screen can enable its buttons, and
`GET /stores/:id/transition-check` answers the same when the edit screen picks 폐점.
The save checks again; the screen's answer is advice.

# 엑셀 다운로드

`GET /stores/excel` takes the list's filters without paging and returns every
matching store as one xlsx sheet, in the list's order, named
`점포목록_YYYYMMDD.xlsx` (Korean date). It needs the **read** permission — the menu
has no separate download action.[^store-excel]

- Columns are the list's items followed by the 사업자정보: 점포코드 through
  등록일시 (Korean time), then 사업자 인증 · 사업자등록번호 (3-2-5) · 상호명 · 대표자명 ·
  대표자 연락처 · 개업일자 · 사업자주소 · 업태 · 종목. **Only 대표자 연락처 is masked**,
  its middle group starred; the screen shows it whole and the file has no password
  (front okf, S-BAYAJS). The image is not in the file. Cells are plain strings and
  numbers, so a name starting with `=` stays text.
- **10,000 rows or more is a 400** asking to narrow the search — that size is meant
  for 예약 생성, which does not exist yet. It is counted with the same `where` first,
  so nothing is read.
- **One download a minute per admin** (429 with the seconds left). The time is set
  before the file is built, so a double click yields one file. A 4xx (too many rows)
  does not use the minute; a server error does, so retrying a failing export cannot
  read up to 10,000 rows again and again. It is counted in process memory, like the
  login limits — more instances multiply it.
- The query takes the list's filters only. `page` · `pageSize` are a 400 (the global
  validation pipe forbids unknown keys), so the screen must not forward the list's
  query string as is.

# 대표 이미지

One per store, optional, JPG · PNG up to 5MB (the DB CHECK says the same). It goes
through the shared [attachment storage](/api/storage.md), not the store form.[^store-management-service]

- `PUT /stores/:id/image` takes multipart field `file` (one file) and answers 200
  with `{ fileId, fileName, fileType, sizeBytes, url }`. `DELETE /stores/:id/image`
  is 204, also when there is no image. Both need the **update** permission and follow
  the edit rules: 폐점 or 소속 BP 미사용 is 409. **Registering with an image is two
  calls** — `POST /stores`, then `PUT /stores/:id/image` — so a role with 등록 but
  not 수정 cannot attach one.
- The kind is read from the content (`StoreImageFileType` is the allowed list) and
  the key is `stores/{storeId}/{uuid}.{ext}`. The file name loses control characters
  and is cut to 255 characters (a display limit — the column is `TEXT`).
- **Every store image is put with a thumbnail** (`STORE_IMAGE_THUMBNAIL`, the
  storage default of 320px on the long side), always — `thumbnailUrl` signs the
  `.thumb.jpg` key without checking it exists, so the option must not vary. An image
  the thumbnail step cannot read, or one over the pixel limit, is the storage's 400
  (`이미지를 읽을 수 없습니다.` · `이미지가 너무 큽니다.`), passed through rather than
  turned into a 503. A missing storage is a 503 only after the input, scope and state
  checks, so it never hides a 404 or 409.
- The object is put first; then, with the `stores` row locked `FOR UPDATE`, the live
  image row is flagged deleted and the new one inserted, so two replacements queue
  and the last one stays (the partial unique index allows one live image). If the
  store was deleted or closed meanwhile, or the DB write fails, the object just put is
  deleted again (original and thumbnail) — unless a row already points at it, which
  happens when the connection drops after the commit. If that delete fails, its key
  is logged so it can be found.
- A replaced or removed image keeps its object in S3 — the row is flagged, not
  removed, and the file stays with it. Each change is a 「대표 이미지」 history row
  with the old and new file names. It does not touch `stores.updated_at`, so
  uploading on the edit screen does not make that screen's save a 409.
- The list's `imageUrl` is the **thumbnail**'s 5-minute signed URL, so a 100-row page
  does not pull 100 originals of up to 5MB; the detail's `image.url` and the upload
  response sign the original. Without `AWS_S3_*`, or when signing fails, they are null
  and the read still succeeds; only an upload is 503. A signing failure is logged as a
  warning — one line per list page with the count and the first cause, since broken
  credentials fail every row — and a missing storage is warned about at boot.

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

The check is `NtsStoreBusinessVerifier` over the same `NtsBusinessClient` that BP
signup uses (`NtsModule`), so the key, the 5-second timeout and the rule that only
`valid` 01 / 02 count as an answer are shared. The adapter only reshapes the values —
`ceoName` → `bizCeoName`, `openDate` (UTC midnight) → `YYYY-MM-DD`. Without
`NTS_SERVICE_KEY` the api still boots (in production too — it logs an error at boot), but the verifier is `null`
rather than the client: every check is the 503 「연동이 아직 없어」 and the service
warns once at boot, instead of a 「잠시 뒤 다시」 503 with an error stack on every
click that would read as an outage.[^store-business-verifier][^nts-store-business-verifier]

`POST /stores/business-verifications` is the screen's preview of that check (API
enum `StoreBusinessVerificationResult`: `VERIFIED` · `UNVERIFIABLE` · `DUPLICATE`,
503 when 국세청 cannot answer); it needs the create **or** the update permission —
`@MenuPermission(['create', 'update'])`, one guard query that passes on
either (the 등록 and 수정 screens share the route). It replaced a handler that asked
for create and, only on a denial, asked again for update; an unusable account was and
is a 「사용할 수 없는 계정」 403, not a second try. An integration failure is logged with the number, never the 대표자명.
**It takes 10 an hour per IP and per signed-in account** (`signedInUserTracker`, 429
past that) — the same bar as signup's verification, since both spend one 국세청 key and
its daily quota: an admin calling it in a loop would otherwise turn every BP's signup
and store verification into 503 for the rest of the day. On top of that,
**every actual 국세청 call is counted per admin, 10 an hour, across this route and the
verification inside a store save** (`POST` · `PUT /stores`, `countNtsCall`) — otherwise a
`PUT` that re-verifies a store, changing only the 대표자명, would call 국세청 every time
with no duplicate check in the way. Only calls that reach 국세청 count: a duplicate number,
a refused permission or a missing key does not, and an ordinary save without a
verification is never limited. Past it the request is a 429 before anything is written.
The screen asks once with 「인증하기」 and the save would ask again, which would make a
verified store cost two calls (five stores an hour). So **a save does not ask 국세청 again
for the same three values the same admin got a match for in the last 10 minutes**
(`VERIFIED_REUSE_MS`) — the server remembers only results it received from 국세청 itself,
never the screen's word, and a mismatch is never remembered (2026-10-15).
The count lives in process memory, so each instance counts on its own. Separately,
without `TRUST_PROXY` naming 관리자 웹's server (or behind one office NAT) the admins
share the verification route's IP bucket.

The 상호명, 대표자 연락처, 사업자주소, 업태 and 종목 are typed by hand and saved whether
or not the store is verified. Numbers are compared and stored as digits only, so a
hyphenated search matches.

# Saving

`PUT` is the whole form: an optional field left out is cleared — except the verified
번호 · 대표자명 · 개업일자, which only a verification changes. `null` on a field with a
default (`floors`, `isLocationApplied`, `business`) is a 400, not a reset; leave the
key out to get the default. Latitude and longitude come together or not at all
(400). It carries the `updatedAt` from the detail and is a 409 if anyone saved in
between (compared within the millisecond, `sameMillisecond`). Floors are replaced as
a set when they differ — old rows flagged deleted, new rows inserted; a floor row
with every field empty is dropped.

Every changed item becomes one `store_change_histories` row with the Korean label
the demo shows (점포명, 점포 연락처, 주소, 위도 · 경도, 위치 적용 여부, 점포상태, 층별 정보,
상호명, 대표자 연락처, 사업자주소, 업태, 종목, 사업자등록번호, 대표자명, 개업일자), plus 등록,
삭제 and 대표 이미지 (written by the image routes, with the old and new file names).
`retain_end_date` is the Korean date plus five years, and the history list shows
only rows still inside it.

**점포코드** is `ST` + six digits, the one after the highest code ever issued —
deleted stores included, so a code is never reused — taken under an advisory lock
so two registrations cannot pick the same one. There is no sequence in the schema
to lean on. An insert that bypassed the lock and took the same code turns the
unique violation into a 409 rather than a 500. Since every registration queues on
that lock, the transaction gets more room than Prisma's default (wait 5s, run 15s),
and running out of it is a 503 「잠시 뒤 다시 등록」, not a 500.

# Traps

- `GET /stores` was the 근무지 dropdown until 2026-10-14. That moved to
  `/stores/options`, and front's `contracts/new/load-form-data.ts` has to follow —
  deploy the two together, or the 근로계약 screen's 근무지 list goes empty.
- The 업태 · 종목 limit is 50 (DB CHECK, ERD); the demo's 30 was not followed.
- The list and excel `keyword` goes through `containsText`: Prisma's `contains`
  passes `%` · `_` · `\` to LIKE as wildcards, so a raw `_` would match every store.
  A NUL in it is a 400 — PostgreSQL refuses NUL in text, which would otherwise be a
  500.
- Contracts have no deletion flag; the in-progress count is by status alone.
- **폐점 · 삭제 vs a new contract is only half closed.** The store side counts the
  in-progress contracts again inside its transaction, after locking the `stores` row
  `FOR UPDATE`. The contract side (`ContractsService.checkStoreOpen`) still reads the
  store's status without a lock, so a contract created in the gap between that read
  and its insert can land on a store that has just closed. Closing it needs the
  contract create / 이어 쓰기 transaction to take `FOR SHARE` on the same row and
  re-check — a 근로계약 change, left for its owner.
- The store scope (`scopeOf`) differs from `AdminScopeService` on purpose: platform
  accounts manage every BP's stores here but see no customer staff there.
  Do not merge the two.
- **Nothing in the database limits the status, type and floor codes.** The three
  columns have no CHECK or foreign key, so the constants in `store-format.ts` are the
  only guard; labels fall back to the raw value rather than printing `undefined`.
  A CHECK on the values, and one tying `closed_date` to `CLOSED`, would be 1팀
  migrations to propose.
- The signed image URL carries `Content-Disposition: attachment`: it renders in an
  `<img>`, but opened in a new tab it downloads instead of showing.
- Only a real database proves the locks: concurrent registrations getting distinct
  codes, two verifications of one number leaving one, and concurrent image
  replacement against the partial unique index. They are in
  `test/stores-db.e2e-spec.ts` but **skipped unless `E2E_REAL_POSTGRES=1`** — PGlite,
  which the other DB e2e suites use, has one session, so its connections never wait
  on each other's locks. The rest of that file (code numbering, the `updatedAt` round
  trip, number reuse after 폐점, the image row, mapping scope, excel rows) runs on any
  throwaway database. The unit tests check that the locks are taken, in order, inside
  the transaction, and that every write goes through it — not that they serialize.
- The 국세청 integration must not put request values (the 대표자명 above all) in the
  messages it throws: the service logs that stack. The number itself is logged, and a
  개인사업자 number identifies a person — keep that in mind for log retention.

[^store-management-service]: StoreManagementService (list · detail · histories · transitionCheck · create · update · remove · verifyBusiness · putImage · removeImage · excel)
[^store-excel]: 점포 목록 엑셀 — 열 · 연락처 가림 · 1만 건 · 1분 1회
[^stores-controller]: /stores routes and the menu permission per action (`/stores`, MN000002 today)
[^store-format]: 상태 전환 · 운영 조건 · 진행 중 근로계약 · 이력 보존 기한 · 라벨
[^store-business-verifier]: STORE_BUSINESS_VERIFIER — 국세청 진위확인 slot
[^nts-store-business-verifier]: NtsStoreBusinessVerifier — 점포 값을 국세청 클라이언트 모양으로
