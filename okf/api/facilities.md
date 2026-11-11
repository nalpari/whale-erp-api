---
type: API
title: Facilities
description: 관리자 웹 시설물 및 장비 관리(MN000022, /facilities) — 점포에 속한 시설물·장비의 목록 · 상세 · 등록 · 수정 · 논리 삭제와 문서 3종(종류마다 1개). 점포는 등록 뒤 못 바꾸고, 폐점 점포는 등록 불가 · 기존 건은 조회만. 운영상태 FACILITY_STATUS(플랫폼고정), 분류 STORE_FACILITY · STORE_EQUIPMENT 와 점검 주기 INSPECTION_CYCLE 은 점포 BP 의 행(플랫폼제공, BP 적용 꺼 둠).
tags: [admin, stores, facilities, storage, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-11-11T09:30:00Z }
sources:
  - id: facilities-service
    resource: ../../src/facilities/facilities.service.ts
    title: FacilitiesService — 범위 · 공통코드 · 담당자 · 폐점 조회만 · 문서
    last_modified: 2026-11-11T09:30:00Z
  - id: facilities-controller
    resource: ../../src/facilities/facilities.controller.ts
    title: /facilities 경로와 메뉴 권한
    last_modified: 2026-11-11T09:30:00Z
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
user's choice: **수리 이력** (its own 정책서 PL-1 ~ PL-4, a new menu) and **PL-7 일괄 등록** (still
「제안」 in the 정책서). No excel download — the screen has none.

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
