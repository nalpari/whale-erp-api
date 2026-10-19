---
type: API
title: Public 약관 API
description: GET /public-terms-versions and /public-terms-versions/{termsTypeCode} — the 약관 in force, tabbed by 공통코드 TERMS_TYPE, readable without login; it picks the same version signup records an agreement to.
tags: [terms, public, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-19T03:50:00Z }
sources:
  - id: terms-versions-service
    resource: ../../src/terms-versions/terms-versions.service.ts
    title: TermsVersionsService (which version is in force, tab order)
    last_modified: 2026-10-19T03:45:00Z
  - id: terms-versions-controller
    resource: ../../src/terms-versions/terms-versions.controller.ts
    title: /public-terms-versions routes (public, 404)
    last_modified: 2026-10-19T03:45:00Z
  - id: terms-demo-migration
    resource: ../../prisma/migrations/20261019124121_team3_terms_demo_content/migration.sql
    title: 약관 v1.0 6건 제목 · 본문을 목업 데모 문구로
    last_modified: 2026-10-19T03:41:21Z
---

# Status

Two `@Public()` routes for the 약관 screen (관리자 웹 `/terms`, the links under
login and signup):[^terms-versions-controller]

- `GET /public-terms-versions` → `{ items, total }`, one item per 약관 type:
  `termsTypeCode`, `label` (the tab name — the `TERMS_TYPE` code item's label),
  `title` (the body's heading), `version`, `effectiveDate` (`YYYY-MM-DD`). No body.
- `GET /public-terms-versions/{termsTypeCode}` → the same plus `content`
  (Markdown). 404 when the type is unknown, switched off, or has no version in force.

The tab's address is not settled; the proposal is the raw code
(`/terms#PRIVACY_COLLECT`), to be decided when front is wired to this API.

# The version shown is the version agreed to

Signup records an agreement to the row that is `is_active`, not deleted, and in
force by **KST** today, latest 시행일 first ([BP signup](/api/admin-signup.md)).
This API picks with the same rule, so the wording a visitor read is the version
their agreement points at.[^terms-versions-service] A version registered ahead of
its 시행일 stays invisible until that day; using `new Date()` instead of `kstToday`
would show it — or hide the current one — between 00:00 and 09:00 KST.

Tabs follow `TERMS_TYPE`: its order, its labels, and its switch. Turning a code
item off removes that 약관 from both routes, which is the only way to hide one —
the routes never take a BP, so a BP cannot see another's 약관 by changing a value.

# Wording lives in the database

The six `v1.0` bodies came from the 관리자 웹 mockup (`auth.js` `TERMS`) through a
migration, and since then the database is the source; changing the mockup changes
nothing.[^terms-demo-migration] Why that migration edited agreed-to rows in place,
and the rule after launch, are in [Team 1 physical schema](/domain/team1-physical-schema.md).

[^terms-versions-controller]: /public-terms-versions routes (public, 404)
[^terms-versions-service]: TermsVersionsService (which version is in force, tab order)
[^terms-demo-migration]: 약관 v1.0 6건 제목 · 본문을 목업 데모 문구로
