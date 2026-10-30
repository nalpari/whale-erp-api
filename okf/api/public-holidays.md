---
type: API
title: Platform holidays
description: 관리자 웹 「플랫폼 휴일 관리」(MN000217) — GET /public-holidays reads the 공식 휴일 of a year (목록) or a month (캘린더) with the synchronization status; read-only, no route changes a holiday. A monthly batch (public-holiday-sync) aligns 올해 · 다음 해 with the 공휴일 API.
tags: [admin, holiday, platform, team1, batch]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-30T07:56:44Z }
sources:
  - id: public-holidays-controller
    resource: ../../src/public-holidays/public-holidays.controller.ts
    title: /public-holidays route (path-form @MenuPermission, platformOnly)
    last_modified: 2026-10-30T06:42:37Z
  - id: public-holidays-service
    resource: ../../src/public-holidays/public-holidays.service.ts
    title: PublicHolidaysService (year · month range, synchronization status)
    last_modified: 2026-10-30T07:19:13Z
  - id: public-holidays-query
    resource: ../../src/public-holidays/dto/list-public-holidays-query.dto.ts
    title: year 2000~2100 · month 1~12 query
    last_modified: 2026-10-30T07:21:57Z
  - id: holiday-api-client
    resource: ../../src/public-holidays/holiday-api.client.ts
    title: HolidayApiClient — 한국천문연구원 특일 정보 getRestDeInfo, a year at a time
    last_modified: 2026-10-28T00:50:40Z
  - id: holiday-api-module
    resource: ../../src/public-holidays/holiday-api.module.ts
    title: HOLIDAY_SERVICE_KEY, optional (error log in production)
    last_modified: 2026-10-28T00:50:40Z
  - id: public-holiday-sync-plan
    resource: ../../src/public-holidays/public-holiday-sync-plan.ts
    title: planPublicHolidaySync — create · update · refresh · remove by date
    last_modified: 2026-10-28T01:59:07Z
  - id: public-holiday-sync-service
    resource: ../../src/public-holidays/public-holiday-sync.service.ts
    title: PublicHolidaySyncService — API outside the transaction, apply and log under runExclusive
    last_modified: 2026-10-30T07:19:13Z
  - id: public-holiday-sync-scheduler
    resource: ../../src/public-holidays/public-holiday-sync.scheduler.ts
    title: 매월 1일 04:00 KST, public-holiday-sync
    last_modified: 2026-10-28T00:50:40Z
---

# Status

One route for the 플랫폼 휴일 관리 screen (Plane WHALEERP-544, 명세 S-DDGJKQ
「플랫폼 휴일 캘린더 및 목록 조회」):[^public-holidays-controller]

- `GET /public-holidays?year=2026&month=9` → the 캘린더 view: that month's 공식 휴일.
- `GET /public-holidays?year=2026` → the 목록 view: the whole year.

Both answer `{ year, month, items, total, synchronization }`. `items` are
`publicHolidayId`, `holidayDate` (`YYYY-MM-DD`), `name`, `note` in date order, with no
paging — a year is at most a few dozen rows. `total` is the count shown next to the
heading (「공식 휴일 N일」). `month` is `null` for a year query.

`year` is required and must be 2000~2100 (the table's range), `month` 1~12; anything else is 400 with
「연도는 2000년부터 2100년까지 조회할 수 있습니다.」 / 「월은 1~12 사이로 보내 주세요.」.[^public-holidays-query]
An empty `month=` is not "no month": the query string is coerced to `0` and gets the
month 400, like the other query DTOs (none of them maps `''` to absent). **The 목록 view
leaves `month` out of the URL** rather than sending it empty (사용자 결정, 2026-10-26).
The range is the table's own CHECK (`public_holidays_year_range`). The screen opens on
the current year and month; that default is the client's, not the API's.

# Read-only by design

공식 휴일 change only through the rule-computed migration and the 공공 API
synchronization, so there is **no create, update or delete route** — POST · PUT ·
DELETE on `/public-holidays` are 404, and the controller spec pins that `list` is its
only method (WHALEERP-546). A wrong date is fixed by a new migration or by the
synchronization, never from this screen.

One row per date: when two holidays fall on one day the row carries both names
(`어린이날 · 부처님오신날`, 2025-05-05), as [Team 1 physical schema](/domain/team1-physical-schema.md)
explains.

**2051–2100 hold solar holidays only** — the lunar conversion table (한국천문연구원) ends in 2050, so those
years have no 설날 · 부처님오신날 · 추석, and the synchronization, which only fetches 올해 · 다음 해, will not
reach them for decades. They are not hidden (2026-10-30, 재영 — 「막을 이유가 없다」): cutting the table to
2050 and then capping only this query were both tried and dropped the same day, so the rows, the CHECK and the
query all stay 2000~2100, and [BP holidays](/api/bp-holidays.md) still show those solar days. A screen reading a
year past 2050 is expected to know it is incomplete.

# Synchronization status

`synchronization` serves the 「최종 동기화」 label and the failure notice:[^public-holidays-service]

- `lastSynchronizedAt` — the latest `SUCCEEDED` row of
  `public_holiday_synchronization_logs`, any year; `null` while nothing has synced.
- `failedYears` — of 올해 · 다음 해, the years whose **latest** log is `FAILED`. A later
  success clears an earlier failure. 올해 is the Korean date (`kstToday`), so the
  answer does not slip a year between 00:00 and 09:00 KST on 1 January.

The log is written by the synchronization batch below. In a database it has never run in,
`lastSynchronizedAt` is `null` and `failedYears` is `[]`. The shared development database
already has one row: 2026 was synchronized by hand on 2026-10-28, before merge (사용자 요청).

# Synchronization batch

`public-holiday-sync` (WHALEERP-543, 2026-10-28) runs at **04:00 KST on the 1st of every
month** — clear of the 00:00 · 03:00 · 03:30 batches — and handles 올해 and 다음 해 by the
Korean date, each year on its own: one log row per year, and a failed year does not stop
the other.[^public-holiday-sync-scheduler][^public-holiday-sync-service] A 임시공휴일 named
mid-month arrives on the next 1st.

**Source.** 공공데이터포털 「한국천문연구원_특일 정보」, operation 공휴일 정보 조회
(`getRestDeInfo`), one call per year (`solYear` only, 100 rows, JSON).[^holiday-api-client] It
returns only days off — 대체공휴일, 임시공휴일 and 선거일 included once 관보 publishes them;
국경일 that are not days off (none today, but the operation keeps them apart) do not come.
Its quirks: 0 rows come as `items: ""`, one row as an object rather than an array, and a key
error comes as **XML even with `_type=json`** (`SERVICE_KEY_IS_NOT_REGISTERED_ERROR`); the
client reads all three. More rows than one page (`totalCount` > received) is a failure rather
than a partial year.

**Key.** `HOLIDAY_SERVICE_KEY` — a 공공데이터포털 account key, the same value as
`NTS_SERVICE_KEY` when one account applied for both (특일 정보 needs its own 활용신청).
Encoding or Decoding form both work. It is optional like the 국세청 key: without it the api
boots, logs a warning (an error in production), and each run records `FAILED` for both
years.[^holiday-api-module]

**Rules — by date, the API wins** (사용자 결정 2026-10-28):[^public-holiday-sync-plan]

- A date only the API has is created; a date whose 이름 · 비고 · 출처 differs is updated to
  the API's; a date that already matches only gets `synchronized_at`. Every touched row
  becomes `source = PUBLIC_API` with `source_ref` (`<locdate>-<seq>`) and `synchronized_at`.
- **Names are the API's text and 비고 is cleared** — 「1월1일」, 「대체공휴일(삼일절)」,
  「기독탄신일」. Until 2026-10-30 the rule-computed rows said 「신정」 · 「성탄절」 · 「설날 연휴」 ·
  「추석 연휴」 and put 대체공휴일 in 비고 (「대체공휴일 — 삼일절」), so a list read differently across the
  year the synchronization had covered, and a calendar (names only) hid which day was a substitute. That
  had been accepted; `20261030153929_team1_public_holiday_api_names` instead rewrote every `RULE` row (2000–2100) to the API's spelling — 신정 →
  1월1일, 성탄절 → 기독탄신일, 설 · 추석 앞뒤 날 → 설날 · 추석 (the API names all three days alike), a
  substitute → 「대체공휴일(본 휴일)」 with 비고 NULL — checked against the 2026 rows the API wrote. 대체공휴일
  of 설날 · 추석 · 기독탄신일 did not occur in 2026, so their spelling follows the same pattern by inference.
  Rows joined with 「 · 」 keep their order. A later synchronization of such a year therefore changes only
  `source` · `source_ref` · `synchronized_at`, not the name — unless one of the inferred 대체공휴일 spellings turns
  out different, in which case the synchronization corrects it.
- When the API returns the year cleanly, **every row of that year it did not return is
  deleted, whatever its source** — a rule row the API disagrees with, and a cancelled
  임시공휴일 that came from an earlier sync. The table has no `is_deleted`, so this is a real
  `DELETE`.
- **Any invalid item holds back every deletion for that year** (코드 리뷰 반영, 2026-10-28). An
  item whose date cannot be read cannot say which day it meant, so the table's row for that
  day would otherwise look like 「not returned」 and be deleted — a real 광복절 gone from the
  calendar until the next 1st. Creates and updates still apply; `failed_count` and `error`
  record the item, and the next clean run does the deletions.
- 0 rows means 미발표: nothing changes (a `SUCCEEDED` row with zero counts).
- **Weekend holidays are ordinary** — 2026-03-01 (Sunday) is created and updated like any
  day (사용자 결정). The 명세's 「토 · 일요일은 만들지 않는다」 means plain weekends are never
  turned into holidays, which the API never asks for anyway.
- Two holidays on one date become one row, names joined with 「 · 」 in `seq` order (the
  date's unique index).
- An item with a malformed date, a date outside the year, a non-numeric `seq` (it orders the
  merged names and forms `source_ref`), or an empty or over-100-character name is skipped and
  counted in `failed_count`, its reason in `error`; the rest still applies, short of deletions.

**Failure and concurrency.** The API is called **outside any transaction**, so a slow portal
holds neither a connection nor the lock. If it fails (no key, 미승인, timeout, HTTP error,
unexpected shape) the year's table is untouched and a `FAILED` row carries the reason — never
the key. The changes and the `SUCCEEDED` row are one transaction under `runExclusive`, the
advisory lock every batch here uses ([Employment Contract Batch](/api/employment-contract-batch.md)),
which is the answer to the 명세's open question of how to stop a duplicate run: an overlapping
instance skips, and one arriving after the commit re-runs and logs a zero-count success. A
database error rolls the year back and logs `FAILED`; if even that log cannot be written (the
database is down) the error is logged and the other year is still tried.

One gap is accepted: an API failure's `FAILED` row is written outside the lock, so with two
instances a late one whose call timed out can log `FAILED` after the other's success. That
year then shows in `failedYears` although the table is current, until the next run.

**Verified** against the real API on a throwaway database (2026-10-28): 2026 created 3
(노동절, 전국동시지방선거, 제헌절) and updated 19, 2027 created 4 and updated 20, nothing
deleted. On the shared database 2026 created 4 and updated 18 — 2026-03-02 had been deleted
by hand just before, so it came back as a new `PUBLIC_API` row. `test/public-holiday-sync.e2e-spec.ts`
replaces 2050 (a year no business data uses) with eight solar `RULE` rows, runs the synchronization with a fake
client, and restores the year afterwards.

What it does not do: no manual-run route, no lunar back-fill of 2051–2100 (the API answers only years it has
published), and no reconciliation report of API against rule.

# Permission

The menu is found by the path: `menus.url = '/public-holidays'` is MN000217
(`20261019144438_team1_menu_single_level_urls`). The route asks for `read` with
`platformOnly`, so a PA needs a 조회 row for MN000217 and BP-side accounts get 403
even with a row — the same arrangement as [Platform menus](/api/platform-menus.md).
PM000001 has the row from the initial data.

All reads run in one array `$transaction`, so a request holds one pool connection
rather than four. It does not pin one snapshot (READ COMMITTED, as
[naming](/conventions/naming.md) accepts for lists); `total` is the length of the
same read, so it always matches `items`. The e2e suite (`test/public-holidays.e2e-spec.ts`)
checks against a real database the migrated 2026 추석 rows, the month edges (2월 설 연휴
without 3월 1일; 3월 삼일절 and its 대체공휴일), the year count against the table, a
failure covered by a later success, `lastSynchronizedAt` skipping a later failure,
400s, 403s and the absent write routes. Its synchronization rows are dated 2099 so they
stay the latest even in a database that has real history.

`PublicHolidaysController` is in the path-to-menu table of
`src/auth/menu-permission-urls.spec.ts`, so renaming the controller path without the
menu URL migration fails a unit test instead of turning every request into 403.

[^public-holidays-controller]: /public-holidays 경로와 메뉴 권한(경로로 찾는 MN000217, 플랫폼 전용)
[^public-holidays-service]: PublicHolidaysService — 연도 · 월 범위와 동기화 상태
[^public-holidays-query]: 연도 2000~2100 · 월 1~12 조회 조건
[^holiday-api-client]: 공휴일 API 클라이언트(한국천문연구원 특일 정보 getRestDeInfo, 연도 하나씩)
[^holiday-api-module]: HOLIDAY_SERVICE_KEY 선택 설정(운영은 error 로그)
[^public-holiday-sync-plan]: 날짜로 비교해 추가 · 수정 · 시각만 · 삭제를 정하는 계획
[^public-holiday-sync-service]: API 는 트랜잭션 밖, 반영 · 이력은 runExclusive 안
[^public-holiday-sync-scheduler]: 매월 1일 04:00 KST, public-holiday-sync
