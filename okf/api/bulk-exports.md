---
type: API
title: Bulk exports (직원 자료 일괄 저장)
description: BP 마스터 · 가맹마스터가 업무 범위 직원의 근로계약서 · 출퇴근 기록 · 급여명세서 · 근무스케줄을 zip 하나로 받는다 — 1분 배치가 만들고 7일 보관, 같은 BP · 같은 권한 유형 · 점포를 모두 관리하는 마스터가 목록 · 내려받기를 쓰고, 알림은 없다.
tags: [admin, staff, batch, storage, zip, team3]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-29T03:05:33Z }
sources:
  - id: bulk-exports-service
    resource: ../../src/bulk-exports/bulk-exports.service.ts
    title: BulkExportsService — preview · request · list · download · processPending · purgeExpiredFiles · buildArchive
    last_modified: 2026-10-29T03:05:33Z
  - id: bulk-export-policy
    resource: ../../src/bulk-exports/bulk-export-policy.ts
    title: 담을 직원 · 범위 · 볼 수 있는가 · 파일 이름
    last_modified: 2026-10-29T03:05:33Z
  - id: bulk-export-archive
    resource: ../../src/bulk-exports/bulk-export-archive.ts
    title: zip 구성 · CSV(BOM · CRLF) · fflate
    last_modified: 2026-10-29T03:05:33Z
  - id: bulk-exports-controller
    resource: ../../src/bulk-exports/bulk-exports.controller.ts
    title: /staff-members/bulk-exports
    last_modified: 2026-10-29T03:05:33Z
  - id: bulk-exports-scheduler
    resource: ../../src/bulk-exports/bulk-exports.scheduler.ts
    title: bulk-export(1분) · bulk-export-file-purge(매일 04:40)
    last_modified: 2026-10-29T03:05:33Z
  - id: bulk-exports-migration
    resource: ../../prisma/migrations/20261029134408_team3_bulk_exports/migration.sql
    title: bulk_exports · bulk_export_download_logs
    last_modified: 2026-10-29T03:05:33Z
  - id: plan
    resource: ../../docs/plans/2026-10-29-staff-records-export.md
    title: 계획 (WHALEERP-336)
    last_modified: 2026-10-29T03:05:33Z
---

# What it is

Plane 336. The source rules are 운영 정책 RET-09 · ATT-30 · NTF-01, and the plan is the spec.[^plan] It is a
separate module from 1팀's `excel-exports`. The two keep files for different times (7 days here, 24 hours
there), notify differently (screen status here, mail there) and make different files (zip here, xlsx there).
The mechanics are the same: a 1-minute cron claims with `FOR UPDATE SKIP LOCKED`, stuck jobs are recovered,
the attempt count guards the final update, and a partial unique index allows one job in progress.

| Route | Does |
|---|---|
| `GET /staff-members/bulk-exports/preview?storeIds=` | `{ storeCount, staffCount, employedCount, retiredCount, inProgress }` |
| `POST /staff-members/bulk-exports` `{ storeIds? }` | 201 item · 400 out-of-scope store or no staff · 409 same scope in progress · 503 no S3 |
| `GET /staff-members/bulk-exports?page&pageSize` | `{ items, total }`, newest first |
| `POST /staff-members/bulk-exports/:id/download` | 200 `{ url, fileName, expiresAt }` (5-minute URL) · 409 not ready or failed, or (BM file only) a packed staff member withdrew 본사 제공 동의 or their 가맹 store closed · 410 expired · 404 not visible |

A finished row keeps `staff_member_ids`, the staff records packed into the file. Right before a BM download
the service counts those records through `visibleStaffWhere` (the same consent and closed-franchise rule that
built the file). If any dropped out, it refuses with 409 and asks for a new request (2026-10-29 재영, RET-09).
FM files skip this check because they never filter by consent. Files already downloaded are not touched.

`storeIds` on preview takes repeated keys and commas, or both mixed. That is the same parser as the staff
list. Empty means every store the caller manages.

# Traps

- **Registration order matters.** The controller lives at `/staff-members/bulk-exports`, so the menu guard
  judges it by 직원 정보 관리 `read`. If `StaffMembersModule` registers first, `GET /staff-members/:id`
  takes `bulk-exports` as an ID and answers 404. `AppModule` imports `BulkExportsModule` first, and the e2e
  test covers it.
- **Role is checked after the menu.** Only `BM` and `FM` pass, and BA, FA and platform roles get 403 even
  with menu read. The rule lives in the service, so the batch reuses it when it re-checks the requester.
- **Who may see a file is not "the requester".** It is anyone with the same BP and the same role type who
  currently manages every store in `store_ids` (`isVisibleTo`). The list does this in SQL with
  `store_ids <@ managed::int[]`, because Prisma cannot express array containment. The role match is what
  keeps an FM file, which consent does not filter, away from a BM.
- **Target staff** (`targetStaffWhere`) are staff with at least one non-DRAFT contract, who are either
  employed or retired on or after KST today minus 36 months (`addMonths`, so 29 Feb becomes 28 Feb).
  For BM, franchise staff without 본사 제공 동의 are dropped through `hqVisibleWhere`. All staff of closed
  stores that are not direct (`storeStatusCode = 'CLOSED'`) are dropped as well. "Not direct" counts an
  unknown type as franchise, which errs toward hiding, as `hidesPersonalData` does. FM gets neither rule.
- **Never read:** `staff_tax_profiles`, `location_access_logs`, location consent tables, the RRN. The unit
  test runs `buildArchive` against a recording Prisma proxy and fails if any of them is touched. Staff
  rows select only id, store, name and phone. The `hqVisibleWhere` filter reads `accounts.is_hq_sharing_consented`
  in a where clause, which is the one place an account column is used.
- **Files in the zip:** contract documents of kind `SIGNED_COPY` · `PAPER_EMPLOYMENT_CONTRACT` · `WAGE_CONTRACT`
  (not `SENT_ORIGINAL`, not `SIGNATURE`), plus `SENT` payslips rendered with `renderPayslipPdf` through the
  same `DETAIL_SELECT` · `toSummary` as the staff app. PDFs and images are stored at level 0, CSVs deflated.
  CSVs carry a UTF-8 BOM and CRLF. A cell that starts with `= + - @` gets a leading `'` so Excel does not
  run it as a formula. Paths are `{점포명}/{이름}_{직원 레코드 ID}/…`, with path characters replaced by `_`.
  A name made only of dots (`.`, `..`) becomes `_`, so an unzip tool cannot climb out of the folder (zip-slip).
  A duplicate path gets ` (2)`.
- **Everything is in memory** (`ponytail:` in `zipArchive`). The upgrade path is fflate's streaming `Zip`
  piped into an S3 multipart upload. Until then `buildArchive` adds up the bytes of fetched contract files and
  rendered payslip PDFs. Past `BULK_EXPORT_MAX_BYTES` (500 MB) it throws 413, which ends the job at once with
  「파일이 너무 큽니다. 점포를 나눠 다시 요청해 주세요.」.
- **The failure reason is shown on screen**, so it holds only messages we raised (`HttpException`). Any other
  error (DB, S3, a stuck job) is stored as 「일괄 저장 파일을 만들지 못했습니다. 다시 요청해 주세요.」 and
  the original goes to the log only.
- **One in progress per scope** is the partial unique index on `(bp_code_id, md5(scope_key))`. An all-stores
  key lists every store id and can pass btree's row size limit (about 2.7KB) without the md5. The e2e test
  inserts an 800-store key. A clash is P2002, which the service turns into 409.
- **Items carry `storeIds`** (the request's scope, sorted), so 「다시 요청」 can send the same scope.
- **Retry:** two attempts. A 4xx-shaped failure ends at once, for example a requester who no longer manages
  the scope, a blocked account, or a changed role. A DB error while re-checking the requester propagates as-is,
  so it is retried. A job stuck in `PROCESSING` for 60 minutes goes back to `PENDING`, or to `FAILED` once both
  attempts are used.
- **Expiry:** `expires_at = completed_at + 7 days`. Every day at 04:40 KST the purge job runs inside
  `BatchLockService.runExclusive`, deletes the S3 object and sets `storage_key = NULL`, at most 100 rows
  per run, oldest expiry first. Downloading after that is 410, and the list shows `isExpired`.
- **No notifications** (NTF-01): no 운영 알림, no template, no mail. A failed job is retried by requesting
  again.

# Testing on PGlite

`test/bulk-exports.e2e-spec.ts` passes on the PGlite socket server only with `maxConnections` above 1.
Prisma loads the payslip relations in parallel, and a single connection closes mid-query. Run suites
with `--runInBand`, because parallel suites on one PGlite backend interfere with each other.

[^plan]: `docs/plans/2026-10-29-staff-records-export.md`
