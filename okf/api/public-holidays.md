---
type: API
title: Platform holidays
description: 관리자 웹 「플랫폼 휴일 관리」(MN000217) — GET /public-holidays reads the 공식 휴일 of a year (목록) or a month (캘린더) with the synchronization status; read-only, no route changes a holiday.
tags: [admin, holiday, platform, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-26T00:43:12Z }
sources:
  - id: public-holidays-controller
    resource: ../../src/public-holidays/public-holidays.controller.ts
    title: /public-holidays route (path-form @MenuPermission, platformOnly)
    last_modified: 2026-10-26T00:43:12Z
  - id: public-holidays-service
    resource: ../../src/public-holidays/public-holidays.service.ts
    title: PublicHolidaysService (year · month range, synchronization status)
    last_modified: 2026-10-26T00:43:12Z
  - id: public-holidays-query
    resource: ../../src/public-holidays/dto/list-public-holidays-query.dto.ts
    title: year 2000~2100 · month 1~12 query
    last_modified: 2026-10-26T00:43:12Z
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

`year` is required and must be 2000~2100, `month` 1~12; anything else is 400 with
「연도는 2000~2100 사이로 보내 주세요」 / 「월은 1~12 사이로 보내 주세요」.[^public-holidays-query]
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
explains. 2051–2100 hold solar holidays only until the synchronization fills the rest.

# Synchronization status

`synchronization` serves the 「최종 동기화」 label and the failure notice:[^public-holidays-service]

- `lastSynchronizedAt` — the latest `SUCCEEDED` row of
  `public_holiday_synchronization_logs`, any year; `null` while nothing has synced.
- `failedYears` — of 올해 · 다음 해, the years whose **latest** log is `FAILED`. A later
  success clears an earlier failure. 올해 is the Korean date (`kstToday`), so the
  answer does not slip a year between 00:00 and 09:00 KST on 1 January.

The synchronization batch itself (WHALEERP-543) is not built yet, so today the table
is empty: `lastSynchronizedAt` is `null` and `failedYears` is `[]`.

# Permission

The menu is found by the path: `menus.url = '/public-holidays'` is MN000217
(`20261019144438_team1_menu_single_level_urls`). The route asks for `read` with
`platformOnly`, so a PA needs a 조회 row for MN000217 and BP-side accounts get 403
even with a row — the same arrangement as [Platform menus](/api/platform-menus.md).
PM000001 has the row from the initial data.

All reads run in one array `$transaction`, so a request holds one pool connection
rather than four. The e2e suite (`test/public-holidays.e2e-spec.ts`) checks the
migrated 2026 추석 rows, the year count against the table, the failure flag, 400s,
403s and the absent write routes against a real database.

[^public-holidays-controller]: /public-holidays 경로와 메뉴 권한(경로로 찾는 MN000217, 플랫폼 전용)
[^public-holidays-service]: PublicHolidaysService — 연도 · 월 범위와 동기화 상태
[^public-holidays-query]: 연도 2000~2100 · 월 1~12 조회 조건
