---
type: API
title: Excel exports
description: 모든 화면의 엑셀 공통 — 1만 건 미만은 바로 파일, 이상은 예약 생성(S3 24시간 · 등록한 이메일로 링크 · 요청한 본인만), 같은 사람 · 같은 화면은 생성 중이면 409 · 1분에 한 번, 모든 요청을 excel_download_logs 에 2년 남긴다. GET /excel-downloads/:id 가 예약 생성한 파일의 주소를 준다.
tags: [admin, excel, batch, storage, mail, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-28T08:30:00Z }
sources:
  - id: excel-exports-service
    resource: ../../src/excel-exports/excel-exports.service.ts
    title: ExcelExportsService — request · processPending · download · purgeExpired
    last_modified: 2026-10-28T08:30:00Z
  - id: excel-export-policy
    resource: ../../src/excel-exports/excel-export-policy.ts
    title: 1만 건 · 1분 · 24시간 · 두 번 시도 · 2년, 판단 규칙과 메일 변수
    last_modified: 2026-10-28T08:30:00Z
  - id: excel-export-source
    resource: ../../src/excel-exports/excel-export-source.ts
    title: ExcelExportSource — 화면이 주는 건수 · 파일 · 메뉴 URL
    last_modified: 2026-10-28T08:30:00Z
  - id: excel-exports-scheduler
    resource: ../../src/excel-exports/excel-exports.scheduler.ts
    title: excel-export(1분) · excel-download-purge(매일 04:30)
    last_modified: 2026-10-28T08:30:00Z
  - id: excel-downloads-controller
    resource: ../../src/excel-exports/excel-downloads.controller.ts
    title: GET /excel-downloads/:id
    last_modified: 2026-10-28T08:30:00Z
  - id: excel-download-logs-migration
    resource: ../../prisma/migrations/20261028140448_team1_excel_download_logs/migration.sql
    title: excel_download_logs · 메일 템플릿 2건
    last_modified: 2026-10-28T08:30:00Z
---

# Status

Built 2026-10-28 from 사용자 결정 and the front's settled policy (front `okf/stores.md` ·
`okf/bp.md`, S-BAYAJS · S-ALHCJS · BP-1). Every excel download of the admin web goes through
`ExcelExportsService`; today that is [Store management](/api/stores.md) (`GET /stores/excel`)
and [BP masters](/api/bp-masters.md) (`GET /bp-masters/excel`). Before this, each kept its own
in-memory one-a-minute map, answered 10,000+ rows with a 400 and logged nothing.

A screen supplies only an `ExcelExportSource` — its menu URL, a screen name for the mail, the
query class, the file name, `count` and `build` — and registers it with `ExcelExportRegistry`
when its module starts. Everything else is here.[^excel-export-source]

# The rules

All per **(requester, screen)**, the screen being the menu (`menu_id`):[^excel-export-policy]

- **While one is being made, a new request is 409** — 「엑셀 파일을 만드는 중입니다」. Only the
  same screen: a 점포 export in progress does not block BP 목록. The partial unique index
  `excel_download_logs_requested_by_menu_id_key (requested_by, menu_id) WHERE status IN
  ('PENDING', 'PROCESSING')` enforces it in the database too.
- **Otherwise one request a minute** (429 with the seconds left), counted from the last
  request whatever its result — a failed export also waits, so retrying cannot re-read up to
  10,000 rows in a loop. The check runs once without a lock (cheap rejection), the screen's
  `count` runs **outside any transaction**, and the check runs again with the insert under
  `pg_advisory_xact_lock('excel-exports:{requester}:{menu}')`, so a double click makes one row.
  Counting inside that transaction deadlocks: the screen counts through the injected
  `PrismaService`, so the transaction would hold a pooled connection while waiting for another
  — always with one connection (`E2E_SINGLE_BACKEND`), under load in production. The e2e
  pins this with a source that reads the database.
  The count lives in the database now, so more instances no longer multiply the limit.
- A 4xx from the screen (BP not chosen, account unusable) leaves **no row** and does not
  use the minute.
- **Under 10,000 rows: the file directly** (200 xlsx). The row is written `PROCESSING`
  before building and `SUCCEEDED` after — or `FAILED` with the reason.
- **10,000 or more: 예약 생성** (202 with `{ excelDownloadId, rowCount, message }`). Only a
  `PENDING` row is written. It needs `MAIL_*`, `ADMIN_WEB_URL` and `AWS_S3_*` (503 otherwise)
  and a registered e-mail on the account (400 otherwise) — without them the file could be
  made but never delivered.

# Scheduled generation

`excel-export` runs **every minute**, and a run that is still going makes the next minute skip
(`waitForCompletion`).[^excel-exports-scheduler] It takes `PENDING` rows one by one with
`FOR UPDATE SKIP LOCKED` (several instances share the queue; up to five per run), setting
`PROCESSING`, `attempt_count + 1` and **`started_at`** — not under `runExclusive`, whose
60-second transaction would also hold building, the S3 upload and the mail. For
each:[^excel-exports-service]

1. Rebuild the caller from the row — requester and `bp_code_id`, platform or not judged from
   the account now — and the query by `plainToInstance(source.queryType, search_conditions)`.
   The screen re-checks the requester while building: 점포 through its `loadCaller`, BP 목록
   through `assertExcelCaller` (an active platform account) — an account blocked since the
   request gets no file.
2. `build` → S3 `excel-exports/{requester}/{uuid}.xlsx` (`StoredFileKind` `XLSX`: the server
   writes it, uploads cannot be xlsx).
3. `SUCCEEDED` with `storage_key`, `completed_at`, **`expires_at` = completion + 24 hours** —
   the job's own completion time, not the run's start.
4. Mail `EMAIL_EXCEL_READY` to the account's current e-mail: 화면 · 건수 · 기한 (Korean time) and
   a button to the **admin web** page `ADMIN_WEB_URL/excel-downloads/{id}` — not to the API, which
   a mail client cannot call with a login. `notified_at` records the send.

A failure goes back to `PENDING` once (the next run, a minute later — a run never retries what
it already handled); the second failure is `FAILED` with **`EMAIL_EXCEL_FAILED`** (화면 · 요청
일시, 「다시 요청해 주세요」). Anything after the row is `SUCCEEDED` — reading the address, sending
the mail — is logged and never undoes the row.

**Every state change of a job is conditional on still owning it** — `status = 'PROCESSING'` and
the same `attempt_count`. If the job was meanwhile recovered as stuck and taken by another
attempt, the update matches 0 rows: that attempt sends no mail and deletes the file it uploaded.
Without the condition a slow attempt would overwrite the newer one and the requester could get
both a 「실패」 and a 「준비」 mail.

Rows left `PROCESSING` by a crash are cleaned at the start of each run, measured from
`started_at` — the start of this attempt, not the request, so a job that waited in the queue
is not taken away the moment it starts: a direct download 10 minutes after it started becomes
`FAILED` (or the screen would stay blocked), a scheduled one an hour after it started is treated
as a failed attempt.

# Downloading

`GET /excel-downloads/:id` (admin token, no menu permission — the permission is **being the
requester**; the menu was checked when the export was requested) returns
`{ url, fileName, expiresAt }`, `url` being a 5-minute S3 presigned GET named with the file
name.[^excel-downloads-controller] Someone else's row, a direct download or an unknown id is 404;
not yet made or `FAILED` is 409; after `expires_at` it is **410**. Each success sets
`downloaded_at`. The admin web page behind the mail link calls this and opens the URL — that
page is front work.

**The API deletes the files.** The files carry 사업자정보 and 대표자명, so 「24 hours」 has to be
true of the bucket, not only of the link: `excel-download-purge` (below) also deletes from S3
every scheduled file whose `expires_at` passed within the last 7 days. The log keeps no
"deleted" mark, so the same week is swept daily — S3 deletes of a missing key succeed — which
also covers a purge that did not run for a few days; one failed delete is logged and retried the
next day. A file uploaded by an attempt that lost its job, or that failed before `SUCCEEDED`, is
deleted right away. A bucket lifecycle rule on `excel-exports/` (1–2 days) is still worth adding
as a backstop; the bucket is shared with 1차 ERP, so it must be limited to that prefix.

# The log

`excel_download_logs` (1팀, `20261028140448_team1_excel_download_logs`): requester, menu,
target BP, the query as JSON, row count, `DIRECT` · `SCHEDULED`, `PENDING` · `PROCESSING` ·
`SUCCEEDED` · `FAILED`, file name, storage key, attempts, failure reason, mail time, expiry,
last download, request, attempt start (`started_at`) and completion time.[^excel-download-logs-migration]
It is an event log (`_logs`, no `is_deleted`): **kept two years** (사용자 결정 — the 개인정보
접속기록 retention of the 안전성 확보조치 기준, which counts downloads) and then deleted by
`excel-download-purge` at **04:30 KST daily** under `runExclusive`; the S3 sweep above runs
after it, outside the lock's 60-second transaction. The table was added to 1팀's ERD in front
(`docs/erd/team1`) and the DDL here is the generator's output. The migration's name is Korean
time (`…140448`, rule 2); it was renamed from a UTC name before it reached any shared database.

# Adding a screen

Write an `ExcelExportSource` for the screen (`count` must throw the screen's own 4xx for scope,
`build` must not depend on the request), provide it in the screen's module with
`ExcelExportsModule` imported, register it in `onModuleInit`, and make the controller return
`excelResponse(await excelExports.request(source, caller, query), res)` with
`@Res({ passthrough: true })`. `menuUrl` must be the screen's active menu URL, or requests fail
with a 500 (configuration, not user error).

[^excel-exports-service]: ExcelExportsService — request · processPending · download · purgeExpired
[^excel-export-policy]: 1만 건 · 1분 · 24시간 · 두 번 시도 · 2년, 판단 규칙과 메일 변수
[^excel-export-source]: ExcelExportSource — 화면이 주는 건수 · 파일 · 메뉴 URL
[^excel-exports-scheduler]: excel-export(1분) · excel-download-purge(매일 04:30)
[^excel-downloads-controller]: GET /excel-downloads/:id
[^excel-download-logs-migration]: excel_download_logs · 메일 템플릿 2건
