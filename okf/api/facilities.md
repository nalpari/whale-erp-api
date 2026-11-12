---
type: API
title: Facilities
description: 관리자 웹 시설물 및 장비 관리(MN000022, /facilities) — 점포에 속한 시설물·장비의 목록 · 상세 · 등록 · 수정 · 논리 삭제와 문서 3종(종류마다 1개), 엑셀 일괄 등록(PL-7 — 양식 · 미리보기 · 오류 파일 · 등록, 오류가 있으면 전부 막기 · 500줄). 점포는 등록 뒤 못 바꾸고, 폐점 점포는 등록 불가 · 기존 건은 조회만. 운영상태 FACILITY_STATUS(플랫폼고정), 분류 STORE_FACILITY · STORE_EQUIPMENT 와 점검 주기 INSPECTION_CYCLE 은 점포 BP 의 행(플랫폼제공, BP 적용 꺼 둠).
tags: [admin, stores, facilities, storage, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-11-12T07:36:43Z }
sources:
  - id: facilities-service
    resource: ../../src/facilities/facilities.service.ts
    title: FacilitiesService — 범위 · 공통코드 · 담당자 · 폐점 조회만 · 문서
    last_modified: 2026-11-12T01:24:38Z
  - id: facilities-controller
    resource: ../../src/facilities/facilities.controller.ts
    title: /facilities 경로와 메뉴 권한
    last_modified: 2026-11-12T05:44:49Z
  - id: facility-caller
    resource: ../../src/facilities/facility-caller.ts
    title: 다루는 관리자 · BP 와 점포 범위(화면 경로 · 일괄 등록 공용)
    last_modified: 2026-11-12T01:24:38Z
  - id: facility-bulk
    resource: ../../src/facilities/facility-bulk.ts
    title: 일괄 등록 양식 · 파일 읽기 · 줄 검사 · 오류 파일
    last_modified: 2026-11-12T07:36:43Z
  - id: facility-bulk-reader
    resource: ../../src/facilities/facility-bulk-reader.ts
    title: 올린 xlsx 를 메모리 · 시간 상한이 걸린 worker 에서 읽고 쓰기
    last_modified: 2026-11-12T05:44:49Z
  - id: facility-bulk-service
    resource: ../../src/facilities/facility-bulk.service.ts
    title: FacilityBulkService — 점포 · 공통코드 조회와 한 번에 넣기
    last_modified: 2026-11-12T04:05:18Z
  - id: bulk-upload-dto
    resource: ../../src/common/bulk-upload.response.dto.ts
    title: 일괄 등록 공통 응답(미리보기 · 등록 건수) — 자원마다 같은 클래스
    last_modified: 2026-11-12T04:05:18Z
  - id: bulk-request
    resource: https://claude.ai/artifact/CwpeACBSKDVj6WPFvg9sS9
    title: 「일괄 등록 공통 API 요청 (시설물·장비 첫 적용)」(claude.ai 문서, 2026-11-12)
  - id: facility-format
    resource: ../../src/facilities/facility-format.ts
    title: 그룹 · 공통코드 그룹 이름 · 쪽 크기 · 총금액 · 이름표 고르기
    last_modified: 2026-11-11T09:30:00Z
  - id: save-facility-dto
    resource: ../../src/facilities/dto/save-facility.dto.ts
    title: 등록 · 수정 입력 검증
    last_modified: 2026-11-11T09:30:00Z
  - id: facilities-migration
    resource: ../../prisma/migrations/20261111153316_team1_facilities/migration.sql
    title: facilities · facility_documents · 공통코드 4그룹 13 · 메뉴 /facilities 사용 · 고정 권한 그룹
    last_modified: 2026-11-11T09:30:00Z
  - id: facilities-policy
    resource: https://claude.ai/artifact/Mo31QtdCL8fmcvFwphQGQo
    title: 「시설물·장비 관리 정책서」 · 「시설물·장비 수리 이력 정책서」(claude.ai 문서, 2026-11-10)
---

# Status

Built 2026-11-11 from 「시설물·장비 관리 정책서」 PL-1 ~ PL-6 (2026-11-10) and the front demo
(`whale-erp-new-front` `docs/demo/src/pages/stores/facilities*.mjs`). Out of this round, by the
user's choice: **수리 이력** (its own 정책서 PL-1 ~ PL-4, a new menu). No excel download — the
screen has none. **PL-7 일괄 등록** followed on 2026-11-12 from front's 「일괄 등록 공통 API 요청」
(below); its three open points were built as the 정책서 proposes.

# Routes

All under `@MenuPermission`, menu found by the controller path `/facilities` (MN000022). The BP is
the guard's target BP: BP · 가맹 계정 their own, a platform account must send `X-Bp-Code-Id`
(without it every route is 400 「시설물·장비를 볼 BP 를 골라 주세요.」, as in store management).

| 경로 | 권한 | 내용 |
|---|---|---|
| `GET /facilities` | 조회 | `storeIds[]` · `facilityStatusCode` · `facilityGroupCode` · `facilityCategoryCode`(그룹이 있어야, 없으면 400) · `keyword`(이름) · `page` · `pageSize` 50 · 100. 등록일 최신순 + id |
| `GET /facilities/store-options` | 조회 | 범위 안 점포. 등록 화면은 폐점을 빼고, 목록 필터는 `includeClosed=true` |
| `GET /facilities/manager-options?storeId=` | 조회 | 그 점포의 재직 직원(이름 · 휴대폰). 범위 밖 점포는 404 |
| `GET /facilities/:id` | 조회 | 상세. 이름표 · 「미사용」 여부 · 문서 주소 · 등록 · 최종수정 일시와 처리자 이름 |
| `POST /facilities` | 등록 | `storeId` 필수 |
| `PUT /facilities/:id` | 수정 | 화면 전체 + `updatedAt`. `storeId` 를 보내면 400 |
| `DELETE /facilities/:id` | 삭제 | 논리 삭제, 문서도 함께 |
| `PUT /facilities/:id/documents/:kind` | 등록 또는 수정 | multipart `file`, JPG · PNG · PDF 10MB. 등록 화면은 등록한 뒤 올린다. 등록 권한만이면 직접 등록한 시설물에 처음 올리는 문서만(교체 · 남의 시설물은 403) |
| `DELETE /facilities/:id/documents/:kind` | 수정 | 없어도 204 |
| `GET /facilities/bulk-template` | 등록 | 일괄 등록 양식 .xlsx(`시설물장비_일괄등록_양식.xlsx`) |
| `POST /facilities/bulk-validations` | 등록 | multipart `file` → 미리보기 JSON(200). 저장하지 않는다 |
| `POST /facilities/bulk-error-file` | 등록 | 올린 파일 끝에 「오류 사유」 열(`올린파일이름_오류.xlsx`) |
| `POST /facilities/bulk` | 등록 | 다시 검사해 모두 정상일 때만 한 트랜잭션, 201 `{ createdCount }` |

`kind` is `USER_MANUAL` · `PRECAUTION` · `WARRANTY` (사용 매뉴얼 · 주의사항 · 제품 보증서); any
other value is 404.

The menu needed a migration to be usable: it was `INACTIVE` with url `/stores/facilities`, and the
guard reads only the first path segment, so a two-segment url can never match a controller. The
migration sets `/facilities` and `ACTIVE`, and gives the fixed groups BM000001 and FM000001 all four
actions (PM000001 already had them). Other BP role groups get nothing until their admins grant it.

# Rules worth knowing

- **Scope is store management's**, not `AdminScopeService`'s: a platform account sees every store of
  the chosen BP, others their BP's stores (only mapped ones unless 전체 점포). Copied as `storeScope`
  rather than shared — the two services already keep their own `scopeOf`.
- **Store fixed after registration** (PL-1). The update DTO has no `storeId`, so the global
  whitelist pipe rejects it. Moving a unit means registering anew and setting the old one to 폐기.
- **폐점 점포**: `POST` 400; existing rows are read-only — `PUT` · `DELETE` and both document routes
  are 409 「폐점 점포의 시설물·장비는 조회만 할 수 있습니다.」. List and detail carry `isStoreClosed` /
  `store.isClosed` for the badge.
- **Codes are checked by the server, not the DTO.** 운영상태 must be an active platform row of
  `FACILITY_STATUS`; 분류 an active row of the chosen group **in the target BP**; 점검 주기 likewise
  in `INSPECTION_CYCLE`. A code that exists only on the platform row (the group not yet applied to
  the BP) is refused — the same rule the code lookups use, so the screen and the server agree on
  the 선택지.
- **BP 적용 is the deploy step.** The three 플랫폼제공 groups were inserted with `is_bp_applied =
  false`. BPs that exist at deploy time get no 분류 rows until an operator turns on [BP에 적용] for
  `STORE_FACILITY` · `STORE_EQUIPMENT` (and `INSPECTION_CYCLE`) — until then they cannot register
  anything, since 분류 is required, although the menu is already open to BM · FM. BPs that sign up or
  are registered later receive every 플랫폼제공 group at signup regardless of the flag
  (`providedOriginals` in `src/code-groups/provided-code-copy.ts`).
- **Keeping an unused value** (PL-2 · PL-3 · PL-6): on update, a 운영상태 · 분류 · 점검 주기 equal to
  the current one is accepted even if it has since been set 미사용 (운영상태 by the platform), and so is
  the current 관리 담당자 after retirement. Any other value must be active / a candidate, so once
  changed it cannot be set back. The detail's `isFacilityStatusActive` · `isFacilityCategoryActive` ·
  `isInspectionCycleActive` tell the screen to show 「(미사용)」. Without the 운영상태 exception, turning
  off one status would make every facility in it unsavable.
- **A stale `updatedAt` is 409 before validation.** The "keep the current value" checks compare with
  the row as it is now; if someone else changed it after the form was loaded, comparing would answer
  「다시 선택해 주세요」 400 to a user who only needs to reload. The same condition on the `UPDATE`
  still catches an edit that lands after this check.
- **Labels never disappear**: list and detail labels read code rows regardless of status or
  deletion — the BP's renamed row first, else the platform row, else the code itself.
- **총금액 is computed on save** (`unit_price × quantity`, null without a unit price) and a CHECK
  holds it to that — written `IS NOT DISTINCT FROM`, because with `=` a row where only one side is
  NULL evaluates to NULL and passes. Amounts are `NUMERIC` (10 and 14 digits exceed int4); responses convert to
  `number` — the maximum, 99,989,999,990,001, is inside the safe integer range. `bigint` was avoided
  for the repository rule that `BigInt` must not appear.
- **Update replaces the whole form**: omitted or empty optional fields become null (관리 정보 is
  cleared by emptying fields, PL-4). Optimistic lock on `updatedAt`, as in store management.
- **Every write re-checks under a lock.** Update, delete and both document routes start their
  transaction with `lockEditable`: the facility row `FOR UPDATE`, the store row `FOR SHARE`. A delete
  that won the race is 404 (not 409 「다른 관리자가 먼저 수정했습니다」 — reloading would only find
  nothing), a store closed in between is 409 「조회만」, and only then is a zero-row `UPDATE` a
  concurrent edit. The shared lock on the store also queues the write behind a closing, which takes the
  store row `FOR NO KEY UPDATE`. Document replace and remove take the same facility lock, so they
  serialize and the last request wins. **Create does the same with the store alone**: it re-reads the
  store `FOR SHARE` in the insert's transaction, since the insert's foreign-key check takes only
  `FOR KEY SHARE`, which does not conflict with a closing's `FOR NO KEY UPDATE` and would let a facility
  land in a store closed a moment earlier.
- **관리 담당자 전화번호 may stand alone** — saved without a 관리 담당자 (an outside contact, user decision
  2026-11-11); there is no CHECK tying the two.
- **A code that went unused while the form was open** answers 「쓸 수 없는 분류입니다. 다시 선택해
  주세요.」 / 「운영상태를 다시 선택해 주세요.」 / 「점검 주기를 다시 선택해 주세요.」 — the user did pick
  one, so 「선택해 주세요」 alone would not explain the 400.
- **Phones** are digits 9–12 after stripping `-` and spaces; the messages name the field
  (「구매처 전화번호는 숫자 9~12자리입니다.」).
- **A/S센터 주소**: 우편번호 and 기본주소 come together, 상세주소 only with an address — 400 otherwise,
  and a CHECK backs it.
- **Who may upload.** The guard admits 등록 or 수정 because the 등록 화면 uploads right after
  creating. The service narrows it (`assertDocumentWritable`, the contract-continuation pattern of
  WHALEERP-592): with 수정 permission anything goes; with only 등록 permission, only the first document
  of a kind on a facility the caller registered (`created_by`). Replacing an existing document or
  uploading to someone else's facility changes an existing facility and is 403 — otherwise a role
  barred from removing a document (`DELETE` needs 수정) could still overwrite it. The screen never
  offers it; the check is for direct API calls.
- **Documents**: one live row per kind (partial unique index), one row per stored file
  (`facility_documents_storage_key_key`). Replacing re-checks under the lock above (the upload's
  storage round trip is the widest window), marks the old row deleted and inserts the new one;
  files are never deleted, matching store images. If the insert fails — including a 404 · 409 from the
  re-check — the uploaded file is removed only when no row points at it (the COMMIT may have landed
  before the connection dropped). Images get a thumbnail (`thumbnailUrl`, long side 320px), PDFs
  `null`.
- **관리 담당자 candidates are 재직 · 가입 완료 (`JOINED`) staff of that store** — options and the save
  check share `managerCandidateWhere`. Records before signup are excluded because the contract code
  physically deletes them (deleting a 임시저장 contract, `dropOrphanRecords` on replacement); the
  manager foreign key is `RESTRICT`, so a draft record chosen as manager would turn those deletions
  into a 500.
- **본사 역할 masking (ATT-30) applies here.** For BM · BA in a franchise store, candidates are only
  staff with 본사 제공 동의 (none if the franchise store is closed) — the same `hiddenStoreStaffWhere`
  as 직원 정보 관리 — so the phone list cannot leak people that screen hides. A manager someone else
  chose (a 가맹 계정 may pick anyone) shows to 본사 as `manager.name = null`, `managerPhone = null`,
  `isManagerHidden = true`; when 본사 then saves the form with that manager unchanged and the phone
  empty (it never saw it), the stored phone is kept.
- **`manager-options` returns 직원 휴대폰** to anyone with 조회 on this menu, for the candidates above —
  PL-6 pre-fills the 관리 담당자 phone from it. No 직원 정보 관리 permission is required.
- **Code and manager validation runs outside the write transaction.** A 분류 set 미사용, or a manager
  retired, between the check and the `UPDATE` is not caught; the window is one request long and was
  left as is (deletion and closing are re-checked, above).

# Bulk registration (PL-7)

front asked for one shape for every resource — `/{자원}/bulk-template` · `bulk-validations` ·
`bulk-error-file` · `bulk` — so a single popup can serve any screen; facilities is the first. The
preview carries its own `columns`, and the four routes are declared before `:id`. The response
classes live in `src/common/bulk-upload.response.dto.ts`: the next resource imports them, because
OpenAPI keys schemas by class name and a second class of the same name would silently replace the
first in front's generated types.

- **The server keeps no file.** Preview, error file and registration each receive the same upload
  again and re-run the whole check; there is no upload table. A store closed or deleted, or a code set
  미사용, after the preview therefore shows up at registration as a row error (400 「오류를 고친 파일을
  다시 올려 주세요.」). Registration then locks the stores `FOR SHARE` in id order and re-checks
  삭제 · 폐점 — a store that changed between that check and the lock is 400 「미리보기 뒤 폐점되거나
  삭제된 점포가 있습니다. …」. Codes and admin store mappings are not locked: the one-request window
  is left open, as in single create. The race itself is not proven by e2e — the PGlite e2e runs on a
  single backend, so a second transaction cannot hold the store row; only the sequential cases are.
- **All or nothing** (PL-7 제안): one error row blocks the whole file. Rows go in with one
  `createMany` (typed `satisfies Prisma.FacilityCreateManyInput`), `created_by` the caller; 총금액 is
  computed as in single create. A row result is a discriminated union — `isValid` true carries the
  data, false carries the reasons — and preview and registration read the same flag.
- **File checks are 400.** Not a zip, a broken zip, a first sheet that is not the template (wrong
  header, or the sheets reordered) → 「내려받은 양식으로 작성한 파일만 올릴 수 있습니다.」; over 500
  rows → 「한 번에 500건까지 …」; nothing in it → 「등록할 시설물·장비가 없습니다.」 (those three are the
  정책서 wording). A zip that exceljs cannot read (tables, charts, broken XML) is logged as a warning
  and answers 「파일을 읽지 못했습니다. 표 · 차트 · 그림 없이 …」. Over 5MB or two files is the upload
  interceptor's message. A row is not counted when every cell is empty text or spaces (rows with only
  formatting or a dropdown are skipped by `eachRow` already). A trailing 「오류 사유」 column is
  accepted, so a fixed error file can be uploaded as is. The error file of a file with no error rows
  is 400 「오류가 있는 줄이 없습니다.」.
- **Missing codes are a setup problem, not a row error.** If the platform's 운영상태 rows are gone, or
  neither group has an active 분류 in the caller's BP (BP 적용 not done, group 미사용), every route
  logs a warning with the BP code and answers 400 「시설물 공통코드(운영상태 · 분류)가 설정되지 않아 …
  플랫폼 관리자에게 문의해 주세요.」 instead of failing every row. A group that is 미사용 or deleted is
  dropped from the template and cannot be chosen; its rows say 「그룹: 목록에 있는 값을 골라 주세요.」.
- **An uploaded xlsx is opened only in a worker thread with a memory and time cap**
  (`facility-bulk-reader.ts`, PR #276 re-review). exceljs builds an object per cell of every merged
  range, per address of every data-validation range and every defined name (`definedName`), per
  column up to `<col max>`, and per empty `<c/>` — a 7KB file killed the process several ways, and a
  pre-scan of the XML with regular expressions was bypassed by a path prefix on the entry name
  (exceljs matches `xl/worksheets/sheetN.xml` unanchored), a character reference (`&#58;`) and
  spaces around `=`. So nothing tries to enumerate those any more:
  - every read (preview, error file, registration) and the error-file write run exceljs in a
    `worker_threads` worker with `maxOldGenerationSizeMb` 192 and a 15 s timeout; out of memory or
    time is logged and answers 400 「파일을 읽는 데 자원이 너무 많이 듭니다. …」, and the API process
    keeps serving. A load error is logged and answers 「파일을 읽지 못했습니다. …」; a crash inside the
    worker is a 500. The row checks run in the API process as before;
  - **what the worker sends back is bounded too** (third review). Cells pointing at one shared string
    are a single string inside the worker but a copy per cell after structured clone — an 11KB file
    put 2.4GB on the API heap, outside the worker's cap. So the worker reduces each cell to text,
    number, boolean, date, `{ error }` or `{ formula, result }` (rich text and hyperlinks joined to
    text), sends `{ tooLong }` instead of any cell over 1,000 characters (that column's reason
    becomes 「글자가 너무 깁니다(1,000자 초과). …」), answers `too-large` (400 「파일 내용이 너무 큽니다.
    …」) when the text it would send passes 4,000,000 characters, and sends no rows at all when the
    visited rows overflow;
  - **worker slots** (`WorkerSlots`): two run at once, up to eight wait, a wait longer than 30 s or a
    full queue is 503 「일괄 등록 파일을 읽는 요청이 몰려 있습니다. 잠시 뒤 다시 시도해 주세요.」 — every
    waiting request holds its upload (up to 5MB) in the API process, so the queue cannot be endless.
    A slot is returned on the worker's `exit`, not when its answer arrives, so a terminated worker
    still freeing 192MB does not overlap a new one. **The 503 body carries `code: 'BULK_BUSY'`**
    (`BULK_BUSY_CODE`, 2026-11-12 front 요청) — a gateway or load balancer in front can answer 503
    too, possibly after the rows were saved, so front treats only a 503 with this code as 「not
    saved, register again」 and a code-less 503 as 「check the list first」, never the wording. A bulk
    upload added to another resource uses the same code;
  - the worker is source text with `eval: true` and loads exceljs by its resolved path, so the same
    code runs from `dist` and under ts-jest. Each read costs about a second to start the worker (more
    when the whole unit suite runs in parallel — the two bulk specs set `jest.setTimeout(60_000)`).
    Dates come back as another realm's `Date`, so cells test the `[object Date]` tag, not
    `instanceof`;
  - before the worker, `assertZipWithinLimit` still inflates each entry with `maxOutputLength` and
    stops at 16MB (`BULK_MAX_UNCOMPRESSED_BYTES`) — that now bounds what the API thread inflates; it
    was 4MB until the 「점포 목록」 sheet of a BP with 20,000 open stores made the downloaded template
    itself too big. It also requires the central directory to end exactly at the end record (JSZip
    shifts offsets by any bytes before it) and treats zip64, more than 1,000 entries, a method other
    than stored (0) or deflate (8), or a zlib data error (`Z_*`) as the template message. **Local
    entries must not overlap** — sorted by offset, each starts after the previous one's data (seventh
    review): counting only the inflated output let one local entry of empty deflate blocks (about
    4.8MB that inflates to 0 bytes) be pointed at by all 1,000 central entries, and the API thread
    inflated the same 5MB a thousand times — 33 s with every other request stalled. With no overlap,
    what the API thread inflates is at most the upload itself once;
  - nothing scans the XML on the API thread. A regular-expression pre-check of merged and
    validation ranges was tried and removed: it was bypassed, and its `[^>]*?` was quadratic — a
    2.4KB upload of unclosed `<mergeCell ` tags froze the event loop for 16.5 s (third review). A
    validation laid on whole columns now ends in the worker's resource message, which names it.

  Rows are walked with `eachRow`, never `1..rowCount`: `rowCount` is the last row number ever
  written, so one space in row 1,048,576 of a 6KB file made the old loop build a million rows.
  `eachRow` still visits a row whose only value is a space, so the walk stops at 1,000 visited rows
  (the header not counted) with the 500-row message.
- **Row checks mirror `POST /facilities`** (`SaveFacilityDto` lengths, phone 9–12 digits after
  dropping `-` and spaces, 단가 10 digits and 수량 1–9,999 both with thousands commas, Y/N, real
  `YYYY-MM-DD`, 설치일 ≥ 구매일, store in scope and not closed, 분류 an active code of the chosen
  group in the caller's BP), but every message is 「칸 이름: 사유」 and all of a row's errors are
  listed in column order. Lengths count code points as `char_length` does (an astral character such
  as 🧊 is one); class-validator's `MaxLength` also drops variation selectors, so for a character
  like ❤️ bulk is one stricter than the screen. 운영상태 · 그룹 · 분류 · 점검 주기 accept the Korean
  label or the code — the label wins when a label equals another item's code. If the group is wrong,
  a written 분류 is not checked against it (an empty 분류 still gets its required error). Defaults:
  수량 1, 부가세 Y, 점검 주기 none. Duplicate rows in one file are not errors (PL-7 제안 — a store may
  own several identical machines).
- **Excel rewrites values, and a cell that cannot be read is an error, not a blank.** Cells are read
  as text whatever their type — dates as `YYYY-MM-DD`, formulas by their cached result, rich text
  joined. An error value (`#N/A`), a formula with no cached result (a file saved by a library, not
  Excel) or an unknown cell shape becomes that column's only reason (「셀 값이 오류(#N/A)입니다. …」,
  「수식의 결과가 저장되지 않았습니다. …」) — left blank, an optional 단가 would have been stored as
  null without a word. A Serial number that arrives as a number of 16 digits or more (`>= 1e15`) or in
  exponent form is refused the same way — Excel keeps only 15 significant digits, so a 16-digit
  number is stored with its last digit already changed even though it is far inside JavaScript's safe
  integer range (2^53 was the first boundary and let 16-digit numbers through, fourth review). A phone that arrives as a
  number — directly or as a formula result — has lost its leading 0, which is put back only when that
  makes a Korean number: 9–11 digits, or 8 starting with 2 (서울); a 대표번호 such as 15881234 is left
  as is and fails the length check instead of being stored wrong. The template sets every input cell
  to text format (`@`) so this rarely happens.
- **The store column shows 「점포명 [점포코드]」** (user's choice, 2026-11-12). A dropdown cell stores
  exactly the text picked, so Excel cannot show a name and keep a code; the header is 「점포*」 and the
  dropdown value carries both. The row check takes, in order: the code in a trailing `[…]` when it
  is a store in scope (the name in front is ignored); a bare store code (a code wins over a store
  named the same text); a store name — one open store of that name is taken, two open stores answer
  「이름이 같은 점포가 여럿입니다. 목록에서 「점포명 [점포코드]」로 골라 주세요.」, only closed ones answer
  the closed-store reason. A name that itself contains brackets is found by that last step. Not found
  is 「점포: 관리하는 점포가 아닙니다.」. The 정책서 lists the column as 점포코드; front's request doc and
  정책서 need the new header.
- **The common-code columns show 「코드명 [코드값]」 too** (운영상태 · 그룹 · 분류 · 점검 주기, user's
  choice after the fifth review, 2026-11-12). `code_items.label` is unique nowhere — not in the
  database and not in the code-group services — so two codes of one group can share a name, and the
  old dropdown of names (deduplicated with `Set`) plus a first-match lookup stored every such row
  as the first code without a word. The row check (`pick`) now takes: the code in a trailing `[…]`
  when the list has that code **and** the text before the brackets is that code's name; a name — one code of that name is taken, two or more answer 「이름이 같은 값이
  여럿입니다. 목록에서 「코드명 [코드값]」으로 골라 주세요.」 (a name still wins over a code spelled the
  same, and a name containing brackets is found here); a bare code. The preview shows the name only.
  The 화면 등록 takes code values and never had the problem. The name check on the bracket is what
  keeps groups apart (sixth review): `item_code` is unique only per group and the 분류 dropdown merges
  both groups, so a code-only match turned 「기타 장비 [ETC]」 under 점포 시설물 into that group's own
  `ETC` (「기타 시설」) without a word — it now falls through to 「「점포 시설물」에 없는 분류입니다.」. The
  cost: a code renamed after the template was downloaded no longer matches its old 「코드명 [코드값]」
  and answers the list reason until the user picks again from a fresh template.
- **The template**: sheet 1 has the 24 columns and list validations on rows 2–501 for 운영상태 ·
  그룹 · 분류 · 점검 주기 · 부가세 and 점포 — 점포 has no error alert, so a bare code or name can be
  typed without any prompt. Sheet 2 「점포 목록」 lists open stores in scope by name — 점포(the dropdown
  value) · 점포코드 · 점포명. The lists live in a hidden sheet 「선택값」 because an inline list is capped
  at 255 characters; an empty list gets no validation (an empty range makes Excel repair the file).
  The 분류 list is both groups' categories together — Excel cannot narrow it by group, so the row
  check does. 관리 담당자 · A/S센터 주소 · 문서 are not in the template (PL-7); they are added on the
  edit screen.
- **The caller and scope code moved to `facility-caller.ts`** so the bulk service needs no storage
  dependency; `FacilitiesService` delegates to it unchanged.

# Not yet

- **Delete is not blocked by 수리 이력 · 점검 결과** (PL-4) — neither table exists. The 수리 이력 work
  must add the check in `FacilitiesService.remove` and the 409 「운영상태를 폐기로 바꿔 주세요」.
- **수리비 결제 수단** goes in with 수리 이력. The proposed `REPAIR_PAYMENT_METHOD` is 21 characters
  and `code_groups_group_code_format` allows 20 — the same reason 점검 주기 became
  `INSPECTION_CYCLE` instead of the proposed `FACILITY_INSPECTION_CYCLE`.
- **Deleting a store leaves its facilities.** A 미운영 store can hold facilities and can be deleted,
  and store deletion does not look at them; they drop out of every scope but stay as rows. Whether
  store deletion should be blocked by facilities or mark them deleted is a policy question not yet
  asked.
- **1팀 ERD**: the tables are not in front's `docs/erd/team1` generator yet; the migration came first.
- **Names**: the rows are in [Naming conventions](/conventions/naming.md) and its source
  `docs/raw/2026-09-30-네이밍-규칙.md` here only; the front and staff copies of that file still need
  the same 「고침」 line. `sales_representative_*` is spelled out (no `rep`); `is_vat_included` keeps
  `vat` by the user's choice, pending the 기획 세션.
