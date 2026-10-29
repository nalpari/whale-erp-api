---
type: API
title: Public 약관 API
description: GET /public-terms-versions and /public-terms-versions/{termsTypeCode} — the 약관 in force, tabbed by 공통코드 TERMS_TYPE, readable without login; it picks the same version signup records an agreement to.
tags: [terms, public, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-29T04:44:34Z }
sources:
  - id: terms-versions-service
    resource: ../../src/terms-versions/terms-versions.service.ts
    title: TermsVersionsService (which version is in force, tab order)
    last_modified: 2026-10-19T03:45:00Z
  - id: terms-versions-controller
    resource: ../../src/terms-versions/terms-versions.controller.ts
    title: /public-terms-versions routes (public, 404)
    last_modified: 2026-10-29T04:44:34Z
  - id: terms-demo-migration
    resource: ../../prisma/migrations/20261019124121_team1_terms_demo_content/migration.sql
    title: 약관 v1.0 6건 제목 · 본문을 목업 데모 문구로
    last_modified: 2026-10-19T03:41:21Z
  - id: location-terms-v1-1
    resource: ../../prisma/migrations/20261028160701_team3_location_terms_v1_1/migration.sql
    title: 위치정보 약관 LOCATION v1.1 (탭 진입 읽기 · 지도 · 카카오 전달)
    last_modified: 2026-10-28T09:08:00Z
  - id: terms-mypage-label
    resource: ../../prisma/migrations/20261029114945_team1_terms_mypage_label/migration.sql
    title: 약관 v1.0 본문의 「MY PAGE」를 「마이페이지」로 (TERMS_SERVICE · PRIVACY_COLLECT)
    last_modified: 2026-10-29T02:50:08Z
---

# Status

Two `@Public()` routes for the 약관 screen (관리자 웹 `/terms`, the links under
login and signup):[^terms-versions-controller]

- `GET /public-terms-versions` → `{ items, total }`, one item per `TERMS_TYPE`
  code that has a version in force (a type without one is left out):
  `termsTypeCode`, `label` (the tab name — the `TERMS_TYPE` code item's label),
  `title` (the body's heading), `version`, `effectiveDate` (`YYYY-MM-DD`). No body.
- `GET /public-terms-versions/{termsTypeCode}` → the same plus `content`
  (Markdown). 404 when the type is unknown, switched off, or has no version in force.

The tab's address is not settled; the proposal is the raw code
(`/terms#PRIVACY_COLLECT`), to be decided when front is wired to this API.

# The version shown is the version agreed to

Both places that record an agreement — signup ([BP signup](/api/admin-signup.md))
and the first-login password change ([Admin authentication](/api/admin-auth.md)) —
pick the row that is `is_active`, not deleted, and in force by **KST** today,
latest 시행일 first. This API picks with the same rule, so the wording a visitor
read is the version their agreement points at.[^terms-versions-service] The
password change skipped the 시행일 until it was aligned on 2026-10-19.

A version registered ahead of its 시행일 stays invisible until that day. Comparing
with `new Date()` instead of `kstToday` would keep showing the previous version for
the first nine hours (00:00–09:00 KST) of the new one's 시행일, since the UTC date
turns later.

# Tabs follow the platform's `TERMS_TYPE`, agreement does not

Tabs take the platform BP's `TERMS_TYPE` rows — order, label and status. 약관 are
platform-wide (`terms_versions` has no BP column) and no route takes a BP. A 약관
drops out of both routes when its code item or the group is switched off, as it
does when its version is deactivated, deleted, or not yet in force.

The two agreement paths do **not** read `TERMS_TYPE`. Switching off the code of a
required 약관 (`TERMS_SERVICE`, `PRIVACY_COLLECT`) hides it here while signup and
the password change keep recording agreement to it — so those codes are not to be
switched off. Kept that way on purpose (2026-10-19): the group is 플랫폼고정, and
gating signup on it would add a way to break signup for a screen setting.

# Wording lives in the database

The six `v1.0` bodies came from the 관리자 웹 mockup (`auth.js` `TERMS`) through a
migration, and since then the database is the source; changing the mockup changes
nothing.[^terms-demo-migration] Why that migration edited agreed-to rows in place,
and the rule after launch, are in [Team 1 physical schema](/domain/team1-physical-schema.md).

The menu name in two of those bodies was changed the same way, in place on v1.0 with no new version
(2026-10-29, 사용자 결정 — the screen is 「마이페이지」, not 「MY PAGE」): `TERMS_SERVICE` 제12조 now reads
「마이페이지의 회원 탈퇴」 and `PRIVACY_COLLECT` 「마이페이지에서 언제든지 지울 수 있습니다」. A label fix before
launch asks nobody to agree again. The migration fails unless exactly one row of each type
still holds 「MY PAGE」.[^terms-mypage-label]

The first revision under the after-launch rule is `LOCATION` v1.1 (WHALEERP-628; its 시행일 is the KST date the migration is applied, not a fixed date — ATT-22 v236; avoid applying it around KST midnight): a
new row, with v1.0's `is_active` turned off. It adds the 출퇴근 탭 진입 read, the map
display and the approximate location passed to 카카오 지도 (운영 정책 ATT-05 · ATT-22 v229,
2026-10-28 재영). Because the version in force changed, staff who agreed to v1.0 are asked
again at their next 출퇴근 등록 (ATT-23). Whether 카카오 is 「제공」 or 「위탁」 is left to
법무(ATT-8); that wording change is another new version.[^location-terms-v1-1] This v1.1 migration must reach a database
only after the 직원 앱 that shows the new consent wording is out — the merge order is in
[Attendance](/api/attendance.md).

[^terms-versions-controller]: /public-terms-versions routes (public, 404)
[^terms-versions-service]: TermsVersionsService (which version is in force, tab order)
[^terms-demo-migration]: 약관 v1.0 6건 제목 · 본문을 목업 데모 문구로
[^terms-mypage-label]: 약관 v1.0 본문의 「MY PAGE」를 「마이페이지」로 (TERMS_SERVICE · PRIVACY_COLLECT)
[^location-terms-v1-1]: 위치정보 약관 LOCATION v1.1 (탭 진입 읽기 · 지도 · 카카오 전달)
