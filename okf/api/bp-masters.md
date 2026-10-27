---
type: API
title: BP masters
description: 관리자 웹 「BP 마스터 계정 관리」(MN000203, /bp-masters) — the platform's list · register · edit · status change · password reset · delete of customer BPs together with their one BP 마스터 account; history merged from two tables, 미사용 cascading to every account of the BP, and deletion only for an unused 오등록.
tags: [admin, bp, account, permission, mail, excel]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-27T03:08:29Z }
sources:
  - id: bp-masters-service
    resource: ../../src/bp-masters/bp-masters.service.ts
    title: BpMastersService (list · detail · histories · verifyBusiness · create · update · changeStatus · resetPassword · remove · excel)
    last_modified: 2026-10-27T03:08:29Z
  - id: bp-masters-controller
    resource: ../../src/bp-masters/bp-masters.controller.ts
    title: /bp-masters routes — path-form @MenuPermission with platformOnly, route order before :id
    last_modified: 2026-10-27T03:08:29Z
  - id: bp-master-excel
    resource: ../../src/bp-masters/bp-master-excel.ts
    title: BP 목록 엑셀 — columns, both phone numbers masked
    last_modified: 2026-10-23T00:40:00Z
  - id: admin-password
    resource: ../../src/platform-admins/admin-password.ts
    title: 초기 · 초기화 비밀번호와 그 메일 — shared with 플랫폼 관리자 관리 · BP 관리자 관리
    last_modified: 2026-10-23T08:00:00Z
  - id: next-bp-code
    resource: ../../src/admin-signup/next-bp-code.ts
    title: nextBpCode — BP code numbering under an advisory lock, shared with signup
    last_modified: 2026-10-23T00:40:00Z
  - id: bp-masters-e2e
    resource: ../../test/bp-masters.e2e-spec.ts
    title: e2e on a real database — 403 for BP accounts, concurrent register, code copy, history paging, cascade, delete
    last_modified: 2026-10-23T00:40:00Z
---

# What it is

The platform side of a customer BP. One BP has exactly one BP 마스터 (`role_type_code = 'BM'`),
so the screen treats the pair as one thing: the list row, the detail and the edit form mix
`bp_codes` columns (BP 코드, 상호명, 사업자정보, BP 상태) with the master's
`admin_accounts` columns (아이디, 이름, 연락처, 이메일, 가입경로, 최근 로그인).[^bp-masters-service]
The platform BP (`BP000000`) and deleted BPs are outside it (404). A 탈퇴 BP is shown but
never changed — every write answers 409 — and its 이름 · 연락처 · 이메일 come back `null`
whatever the row still holds, so the screen prints 「탈퇴로 삭제됨」 and the name search
cannot find it.

The menu is found from the controller path (`/bp-masters` → MN000203, the URL the
`20261019144438` migration set), and every route also needs `platformOnly` — a BP-side
account with a stray permission row still gets 403.[^bp-masters-controller] The 탭 BP header
(`X-Bp-Code-Id`) is not used: the BP being managed is the route id.

# Rules that are not guessable

- **Register is one transaction and copies 공통코드.** `bp_codes` (BP code from
  `nextBpCode` under the same advisory lock as signup[^next-bp-code]), the master
  (`BM000001`, `isAllStores = true`, `PLATFORM_REGISTERED`, no 약관 yet), the 플랫폼제공
  공통코드 rows for the new BP (`copyProvidedItems`, exactly as signup does), and a 1-hour
  초기 비밀번호. The account starts with the locked hash `'!'` and 「미발송」 on; the mail
  (`EMAIL_BP_REGISTER`) goes after commit and only a sent mail turns 미발송 off. A failed
  or impossible mail leaves the BP registered with `isMailSent: false` — the way back is
  비밀번호 초기화. This flow is the same code as 플랫폼 관리자 등록
  (`admin-password.ts`), so the two screens fail the same way.[^admin-password]
- **The 아이디 is compared case-insensitively and stored lower-case**, like signup — the
  unique index is case-sensitive, so the check is the only guard against `HanGang01`
  next to `hangang01`.
- **The 이메일 can be checked before saving** — `GET /bp-masters/email-availability`
  (등록 권한, like the 아이디 check) uses the same rule as the save's 409: any undeleted,
  non-withdrawn 관리자 계정 holding it. It has no "except me" parameter: the edit screen
  does not ask when the address is unchanged, as in MY PAGE and BP 관리자. It is not
  `/bp-admins/email-availability`, whose guard judges the BP 관리자 menu (MN000012).
- **사업자등록번호 · 대표자명 · 개업일자 only come from a verification token.**
  `POST /bp-masters/business-verifications` checks (duplicate first, then 국세청) and
  returns a 10-minute token; register and edit write the three values and `biz_verified_at`
  only when the token rides along, re-checking the number inside the transaction under
  the per-number lock `stores:biz:<번호>` that store saves, signup and MY PAGE take. The
  edit screen sends its `bpCodeId` so the BP's own number (and its stores') is not a
  duplicate. Ten calls per admin per hour, plus the controller's IP · account throttle —
  the 국세청 key and daily quota are shared by every BP.
- **Edit has no concurrency check** — the last save wins (S-CQGGZS), unlike
  플랫폼 관리자 수정. It always bumps `bp_codes.updated_at` / `updated_by`, because the
  detail's 「최종수정」 means the BP *or* its master. Changing the e-mail voids unused
  temporary passwords (the old inbox could still use them) and turns 미발송 back on.
- **미사용 cascades, 사용 does not.** Turning a BP 미사용 turns every active account of the
  BP (BM · BA · FM · FA) 미사용 in the same transaction; sessions and passwords stay, and
  the menu-permission check refuses them from the next request. Turning it back 사용 lifts
  only the BP and its master — the master re-enables the others one by one. The BP update
  is conditioned on the status it read, so two admins flipping at once get one 409 rather
  than a history line with the wrong 「전」.
- **History is two tables, read as one.** BP columns and status go to
  `bp_change_histories`; the master's 이름 · 연락처 · 이메일 go to `admin_change_histories`.
  The master's own status change is *not* written to the account history — it always
  equals the BP status, and the merged view would show it twice. Cascaded sub-accounts do
  get an account-history line. `GET /bp-masters/:id/histories` merges with one
  `UNION ALL … ORDER BY changed_at DESC LIMIT/OFFSET`, so a deep page does not read every
  row before it. Password resets are not history (the mail log and
  `temporary_passwords` record them).
- **비밀번호 초기화 without a mail sender is 503 and writes nothing** — it would void the
  old password with no way to deliver the new one. It also refuses (409) when the e-mail
  changed between the read and the write, so a password never goes to an old address.
- **Delete is for an unused 오등록 only.** 사용 or 미사용, the master never logged in, no
  undeleted BA · FM · FA, no undeleted store. The detail returns
  `deletion: { isDeletable, reasons }` with the tooltip sentences; `DELETE` re-checks them
  with the BP row locked `FOR UPDATE` (store and sub-account inserts check that row through
  their foreign key, so they queue behind it) and answers 409 with the reasons. The BP and
  the master are flagged `is_deleted` together; the 아이디 stays taken.

# Excel

`GET /bp-masters/excel` takes the list's filters and follows 점포 엑셀: one file per admin
per minute (429, counted in process memory), 10,000 rows or more is 400 (no scheduled
generation yet), and both the master's 연락처 and the 대표자 연락처 have their middle part
masked.[^bp-master-excel] **Downloads are not logged** — the same as 점포 엑셀
(2026-10-23 decision); the front plan's "who · when · conditions · count" line was dropped
rather than adding a table for this screen alone.

# Not yet

- 소속 점포 수 is a number only; linking it to the store list waits for the front.
- Scheduled generation for 10,000+ rows, together with 점포 엑셀.
- Withdrawal itself is not here — no flow sets a BP to 탈퇴 yet; this screen only reads it.

[^bp-masters-service]: BpMastersService
[^bp-masters-controller]: /bp-masters routes
[^bp-master-excel]: BP 목록 엑셀
[^admin-password]: 초기 · 초기화 비밀번호와 그 메일
[^next-bp-code]: nextBpCode
