---
type: API
title: Excel exports
description: 모든 화면의 엑셀 공통 — 1만 건 미만은 바로 파일, 이상은 예약 생성(S3 24시간 · 등록한 이메일로 링크 · 요청한 본인만), 같은 사람 · 같은 화면은 생성 중이면 409 · 1분에 한 번, 모든 요청을 excel_download_logs 에 2년 남긴다. GET /excel-downloads/:id 가 예약 생성한 파일의 주소를 준다.
tags: [admin, excel, batch, storage, mail, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-29T05:17:36Z }
sources:
  - id: excel-exports-service
    resource: ../../src/excel-exports/excel-exports.service.ts
    title: ExcelExportsService — request · processPending · download · purgeExpired
    last_modified: 2026-10-29T05:17:36Z
  - id: excel-export-policy
    resource: ../../src/excel-exports/excel-export-policy.ts
    title: 1만 건 · 1분 · 24시간 · 두 번 시도 · 2년, 판단 규칙과 메일 변수
    last_modified: 2026-10-29T02:30:00Z
  - id: excel-export-source
    resource: ../../src/excel-exports/excel-export-source.ts
    title: ExcelExportSource — 화면이 주는 건수 · 파일 · 메뉴 URL
    last_modified: 2026-10-29T02:30:00Z
  - id: excel-exports-scheduler
    resource: ../../src/excel-exports/excel-exports.scheduler.ts
    title: excel-export(1분) · excel-download-purge(매일 04:30)
    last_modified: 2026-10-29T02:30:00Z
  - id: excel-downloads-controller
    resource: ../../src/excel-exports/excel-downloads.controller.ts
    title: GET /excel-downloads/:id
    last_modified: 2026-10-29T05:17:36Z
  - id: excel-download-logs-migration
    resource: ../../prisma/migrations/20261028140448_team1_excel_download_logs/migration.sql
    title: excel_download_logs · 메일 템플릿 2건
    last_modified: 2026-10-29T02:30:00Z
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

- **While one is being made, a new request is 409** — 「엑셀 파일을 만드는 중입니다」, followed by
  「다 만들어지면 등록한 이메일로 알려 드립니다」 for a 예약 생성 and 「잠시 뒤 다시 받아 주세요」 for a
  바로 받기 (which sends no mail). Only the same screen: a 점포 export in progress does not block
  BP 목록. The partial unique index `excel_download_logs_requested_by_menu_id_key
  (requested_by, menu_id) WHERE status IN ('PENDING', 'PROCESSING')` enforces it in the database
  too; if it is ever hit (hand-written SQL), the answer is the same 409, not a 500.
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
  (with `started_at`) before building and `SUCCEEDED` after — or `FAILED` with the reason. The
  original error is logged with its stack and rethrown even if writing `FAILED` fails; the row
  then stays `PROCESSING` until the 10-minute stuck cleanup.
- **10,000 or more: 예약 생성** (202 with `{ excelDownloadId, rowCount, message }`). Only a
  `PENDING` row is written. It needs `MAIL_*`, `ADMIN_WEB_URL` and `AWS_S3_*` (503 otherwise —
  the api logs which ones are missing once at boot) and a registered e-mail on the account (400
  otherwise) — without them the file could be made but never delivered.
- A source must be registered (`ExcelExportRegistry`) before it is used: an unregistered one
  fails its first request with a 500, instead of serving 바로 받기 and failing every 예약 생성
  in the batch.

# Scheduled generation

`excel-export` runs **every minute**, and a run that is still going makes the next minute skip
(`waitForCompletion`).[^excel-exports-scheduler] It takes `PENDING` rows one by one with
`FOR UPDATE SKIP LOCKED` (several instances share the queue — the e2e runs two at once; up to
five per run; only `SCHEDULED` rows, and **only for screens registered in this instance** — an
instance without the source, such as an old one during a rolling deploy or another e2e suite's
app, leaves the job instead of burning an attempt on 「소스 없음」), setting `PROCESSING`, `attempt_count + 1` and
**`started_at`** — not under `runExclusive`, whose 60-second transaction would also hold
building, the S3 upload and the mail. A run that has work logs `processed=N`. One job throwing
(a DB error while recording its failure) is logged with its id and the run goes on to the next;
the stuck cleanup collects that job. For each:[^excel-exports-service]

1. **Re-check the permission the request passed**: the requester must still have 조회 on the
   screen's menu (`adminHasMenuAction(read)`, which also needs an active account) — the file is
   built after the request and downloadable for 24 hours, so a role group that lost the menu in
   between gets no file. Then rebuild the caller from the row — requester and `bp_code_id`,
   platform or not judged from the account now — and the query by
   `plainToInstance(source.queryType, search_conditions)`. The screen re-checks its own scope
   while building: 점포 through `loadCaller`, BP 목록 through `assertExcelCaller` (an active
   platform account).
2. `build` → S3 `excel-exports/{requester}/{uuid}.xlsx` (`StoredFileKind` `XLSX`: the server
   writes it, uploads cannot be xlsx).
3. `SUCCEEDED` with `storage_key`, `completed_at`, **`expires_at` = completion + 24 hours** —
   the job's own completion time, not the run's start.
4. Mail `EMAIL_EXCEL_READY` to the account's current e-mail: 화면 · 건수 · 기한 (Korean time) and
   a button to the **admin web** page `ADMIN_WEB_URL/excel-downloads/{id}` — not to the API, which
   a mail client cannot call with a login. `notified_at` records the send.

A failure goes back to `PENDING` once (the next run, a minute later — a run never retries what
it already handled; a job recovered as stuck at the start of a run is retried in that same run);
the second failure is `FAILED` with **`EMAIL_EXCEL_FAILED`** (화면 · 요청 일시, 「다시 요청해
주세요」). **A 4xx is final at once** — lost permission, a blocked account, a scope the screen
refuses would fail the same way again — and its reason is prefixed with the status
(`[403] …`). A final failure is logged as an error with its stack; one that will be retried as a
warning. Anything after the row is `SUCCEEDED` — reading the address, sending the mail — is
logged and never undoes the row. A mail failure logs only the error kind, never the message:
SMTP errors carry the recipient's address (`MailService` logs the masked cause).

**Every state change of a job is conditional on still owning it** — `status = 'PROCESSING'` and
the same `attempt_count`. If the job was meanwhile recovered as stuck and taken by another
attempt, the update matches 0 rows: that attempt sends no mail and deletes the file it uploaded.
Without the condition a slow attempt would overwrite the newer one and the requester could get
both a 「실패」 and a 「준비」 mail.

Rows left `PROCESSING` by a crash are cleaned at the start of each run, measured from
`started_at` — the start of this attempt, not the request, so a job that waited in the queue
is not taken away the moment it starts: a direct download 10 minutes after it started becomes
`FAILED` (or the screen would stay blocked), a scheduled one an hour after it started is treated
as a failed attempt; both are logged. Two CHECKs keep this from failing silently: a
`PROCESSING` row must have `started_at` (otherwise the cleanup never matches it and the screen
is 409 for good), and a 바로 받기 can never be `PENDING` (the queue would build and mail it).

# Downloading

`GET /excel-downloads/:id` (admin token) returns `{ url, fileName, expiresAt }`, `url` being a
5-minute S3 presigned GET named with the file name.[^excel-downloads-controller] Someone else's
row, a direct download or an unknown id is 404; not yet made or `FAILED` is 409; after
`expires_at` it is **410**. **The screen's permission is checked again when downloading**: the
route has no menu guard (the menu comes from the log's `menu_id`, not the path), so the service
asks `adminHasMenuAction(read)` on that menu — which also needs an active account — and the
source's `assertRequester` (BP 목록: still a platform account); either failing is 403 and no URL
is issued. Checking only when the file is built would leave the 24 hours after it open: a role
group that lost the menu, or an account set to 미사용, could still fetch the 사업자정보 file
(PR #188 review). Permission is not the whole of it: **a screen with a data scope also compares
a scope fingerprint**. `ExcelExportSource.scopeKey(caller)` is asked when the file is built and
stored in `scope_key`, and asked again — with the caller rebuilt from the row — when it is
downloaded; any difference is 403 (「볼 수 있는 범위가 바뀌어…다시 요청해 주세요」). 점포 목록's
fingerprint is what `scopeOf` uses: the target BP and either 「all」 (platform or `is_all_stores`)
or the sorted non-deleted `admin_store_mappings` store ids — so a manager narrowed from all stores
to some, or losing a mapping, cannot fetch the wider file. A widened scope is also a difference
and is refused too; asking again builds the file for the current scope. BP 목록 has no scope (the
platform sees every BP) and keeps `assertRequester` only. Each success sets `downloaded_at`. The admin web page behind the mail link calls this and opens the URL — that
page is front work.

**The API deletes the files.** The files carry 사업자정보 and 대표자명, so 「24 hours」 has to be
true of the bucket, not only of the link: `excel-download-purge` (below) also deletes from S3
every scheduled file whose `expires_at` passed within the last 7 days. The log keeps no
"deleted" mark, so the same week is swept daily — S3 deletes of a missing key succeed — which
also covers a purge that did not run for a few days; one failed delete is logged as an error and
retried the next day. The sweep runs even when the log purge before it fails. A file uploaded by
an attempt that lost its job, or that failed before `SUCCEEDED`, is deleted right away — best
effort: its key is in no log row, so the sweep cannot find it, and a failed delete there is left
to the bucket lifecycle rule. That rule on `excel-exports/` (1–2 days) is therefore still worth
adding; the bucket is shared with 1차 ERP, so it must be limited to that prefix.

# The log

`excel_download_logs` (1팀, `20261028140448_team1_excel_download_logs`): requester, menu,
target BP, the query as JSON, row count, `DIRECT` · `SCHEDULED`, `PENDING` · `PROCESSING` ·
`SUCCEEDED` · `FAILED`, file name, storage key, attempts, failure reason, mail time, expiry,
last download, request, attempt start (`started_at`) and completion time, and the scope fingerprint
taken when the file was built (`scope_key`).[^excel-download-logs-migration]
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
