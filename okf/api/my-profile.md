---
type: API
title: My profile (staff app)
description: 직원 근무 앱 마이페이지 (WHALEERP-188) — GET /me/profile(계정 칸 · 계정의 본사 제공 동의 · 위치정보 동의), GET /me/memberships(재직 직원 기준 소속 근무지), GET /me/memberships/:staffMemberId/tax-profile(소속별 신고 정보), 그리고 개인정보 칸의 AES-256-GCM 암호화 형식.
tags: [staff-app, account, personal-data, encryption]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-20T05:10:00Z }
sources:
  - id: my-profile-service
    resource: ../../src/my-profile/my-profile.service.ts
    title: MyProfileService — 내 정보(계정 칸 · 동의)
    last_modified: 2026-10-20T04:36:43Z
  - id: my-memberships-service
    resource: ../../src/my-profile/my-memberships.service.ts
    title: MyMembershipsService — 소속 근무지 · 소속별 신고 정보
    last_modified: 2026-10-20T04:36:43Z
  - id: location-consent-state
    resource: ../../src/my-profile/location-consent-state.ts
    title: 위치정보 동의 상태 판정(API 전용 enum LocationConsentState)
    last_modified: 2026-10-20T04:36:43Z
  - id: personal-data-cipher
    resource: ../../src/common/personal-data-cipher.ts
    title: 개인정보 칸 암호화 · 복호화, 신고 정보 AAD
    last_modified: 2026-10-20T04:36:43Z
  - id: personal-data-key
    resource: ../../src/common/personal-data-key.provider.ts
    title: PERSONAL_DATA_ENCRYPTION_KEY 읽기와 운영 빈 키 로그
    last_modified: 2026-10-20T04:36:43Z
  - id: personal-data-mask
    resource: ../../src/common/personal-data-mask.ts
    title: 주민등록번호 · 계좌번호 가림
    last_modified: 2026-10-20T04:36:43Z
---

# What it is

The 직원 근무 앱's 마이페이지 (193) is three reads, all `@UserTypes('account')`
(an admin token is 403) and all keyed by the token's account — no account id is
ever taken from the path.

| 호출 | 내용 |
|---|---|
| `GET /me/profile` | 계정 칸, 본사 제공 동의, 위치정보 동의[^my-profile-service] |
| `GET /me/memberships` | 소속 근무지 `{ items, total }`[^my-memberships-service] |
| `GET /me/memberships/:staffMemberId/tax-profile` | 그 소속의 신고 정보 |

The screen decides the split (2026-10-20): tapping a 소속 근무지 shows 근로계약서 ·
급여명세서 · 신고정보 buttons, each opening its own page. A 소속 is one staff
record, so those pages open by `staffMemberId`. The 근로계약서 · 급여명세서 pages
have no account-token API yet; when they get one it should take the same
`staffMemberId` and the same "is this my membership" check.

It also contains failure: one 신고 정보 row that cannot be decrypted, or a missing
key, used to fail the whole 내 정보 screen. Now it fails only that page.

Editing (189 주소 · 191 이메일 · 192 비밀번호) is separate; 이름 · 생년월일 are
never editable and 휴대전화번호 is read-only in 1차 (2026-10-19).
`GET /auth/account/me` stays the light status check the app makes on every open.

# Memberships are the 재직 직원 rule, not every record

`memberships` lists the account's staff records that match `ACTIVE_STAFF`
(`src/todos/todo-rules.ts`) — a 체결 완료 contract, 가입 완료, not retired. It is
the same rule TO-DO and payroll use (PAY-16 · CTR-29), so the app never shows a
소속 that the other screens ignore. Consequences:

- a record with only a 임시저장 contract is not a 소속 (2026-10-19 decision);
- 퇴직 예정 is a 소속, with `retiredDate` set;
- retired records and records not yet joined are absent.

Ordered by 입사일 (missing last) then `staffMemberId`. An account with none — 연결
보류, or everything retired — gets `{ items: [], total: 0 }`.

**The tax-profile route uses the same rule as its ownership check.** It looks up
`{ staffMemberId, accountId, ...ACTIVE_STAFF }`, so someone else's id, and also
one of your own retired or draft-only records, is 404 — even when that record has
a 신고 정보 row. Anything outside the list does not exist from this route.

`store` is read with a second query: `staff_members.store_id` points at 1팀's
`stores`, but 3팀's Prisma models hold it as a plain `Int` with no relation, so
`select: { store: … }` is a validation error at runtime that a mocked unit test
does not see. The e2e caught it.

# 본사 제공 동의 is the account's

`hqSharingConsent` (ATT-30) comes from `accounts` — one value per person, applied
to every 가맹 소속 ([Team 3 physical schema](/domain/team3-physical-schema.md),
api #78). `staff_members` still has the old four columns until 민식 drops them
after the shared server is redeployed; **nothing here reads or writes them**. The
field is always present; the app shows it only when a membership's
`store.storeTypeCode` is `FRANCHISE`. Ending a 가맹 relationship does not end the
account's consent (ATT-30 v149), so whatever later writes this consent must not
end it per store record.

# 위치정보 동의 state is derived

`locationConsent.state` is the API-only enum `LocationConsentState` — 미동의 · 동의 ·
일시 중지 · 철회 — registered in `src/enums/api-enums.ts`, so the app gets the
labels from `GET /enums` and no migration is involved.[^location-consent-state]

The row that decides is the one not withdrawn — the partial unique index
`location_consents_account_id_key WHERE withdrawn_at IS NULL` allows at most one
per account. Only when every row is withdrawn does the latest (by `agreedAt`, then
id) decide, giving `WITHDRAWN`. No row is `NOT_AGREED`; `withdrawnAt` wins over
`pausedAt` (ATT-23 · ATT-26).

# Personal data is sealed per row

`staff_tax_profiles.rrn_encrypted` and `payroll_account_number_encrypted` are
bytea, and until this change nothing in the repository wrote them or said how.
The format was proposed here on 2026-10-19 and **decided by 노영주 on 2026-10-20**:[^personal-data-cipher]

- **AES-256-GCM**, stored as `version(1) | IV(12) | auth tag(16) | ciphertext`.
  The version byte names the storage format and is 1 today. It does not identify a
  key — if the key ever rotates, how to tell old values from new is decided then,
  with a new version.
- **AAD is `staff_tax_profiles.<column>:<staffMemberId>`**, built by
  `staffTaxProfileAad`. A ciphertext copied into another row, or into the other
  column, does not decrypt — it throws instead of showing someone else's
  주민등록번호 as yours. Whatever writes these columns (the 신고 정보 API) must
  build the AAD with that same function.
- **Key: `PERSONAL_DATA_ENCRYPTION_KEY`**, base64 of 32 bytes.[^personal-data-key]
  Empty means the api still boots and only reading an existing 신고 정보 is 503;
  in production an empty key also logs an `error` at boot, so a forgotten setting
  shows in the deploy log rather than only as a 503 on one page. A value of the
  wrong length refuses to boot, and the encrypt/decrypt functions check the length
  again for callers that bypass the reader. Changing the key makes every stored
  value unreadable — it is set once per environment and kept.

**Why two-way and not a salted hash.** A hash (with or without salt) cannot be
reversed, so the screen could not show even a masked 주민등록번호 from it. The
salt's job — the same value never producing the same stored bytes — is done here
by the per-value random IV. The decision also settled what is *not* built yet:

- **The key stays an environment variable.** Moving it to a key management
  service (AWS KMS or similar) for production is a later decision; it would come
  with a new version byte.
- **Only masked values leave the api today.** If 관리자 웹 신고 정보 조회 or an
  Excel export needs the full number, that feature alone gets a decrypt-and-return
  path, with its own permission check.
- **No search by 주민등록번호.** Ciphertext with a random IV cannot be compared, so
  a search or duplicate check would need an extra column holding a keyed hash
  (HMAC) of the value. Nothing asks for it yet, so it is not there.

The response carries masked values only — `980304-1******` and `********6789` —
plus 은행 코드, 수집 목적 and 수집 일시 (TAX-8).[^personal-data-mask] A decrypted
value that is not 13 digits (or not a plausible account number) throws rather
than being masked into something that looks right. A 소속 with no 신고 정보 yet is
200 with `taxProfile: null`, not 404 — "not submitted" is a normal state of the
page.

[^my-profile-service]: MyProfileService — 내 정보(계정 칸 · 동의)
[^my-memberships-service]: MyMembershipsService — 소속 근무지 · 소속별 신고 정보
[^location-consent-state]: 위치정보 동의 상태 판정(API 전용 enum LocationConsentState)
[^personal-data-cipher]: 개인정보 칸 암호화 · 복호화, 신고 정보 AAD
[^personal-data-key]: PERSONAL_DATA_ENCRYPTION_KEY 읽기와 운영 빈 키 로그
[^personal-data-mask]: 주민등록번호 · 계좌번호 가림
