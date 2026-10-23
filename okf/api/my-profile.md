---
type: API
title: My profile (staff app)
description: 직원 근무 앱 마이페이지 (WHALEERP-188) — GET /me/profile(계정 칸 · 계정의 본사 제공 동의 · 위치정보 동의 · 비밀번호 변경 시각), GET /me/memberships(재직 직원 기준 소속 근무지), GET · PUT /me/memberships/:staffMemberId/tax-profile(소속별 신고 정보 조회 · 작성 · 수정, WHALEERP-334), 주소 수정(189) · 이메일 아이디 변경(191) · 비밀번호 변경(192) · 위치정보 · 본사 제공 동의 쓰기(193), 그리고 개인정보 칸의 AES-256-GCM 암호화 형식.
tags: [staff-app, account, personal-data, encryption]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-23T02:20:00Z }
sources:
  - id: my-profile-service
    resource: ../../src/my-profile/my-profile.service.ts
    title: MyProfileService — 내 정보(계정 칸 · 동의 · 비밀번호 변경 시각)
    last_modified: 2026-10-20T05:37:25Z
  - id: my-address-service
    resource: ../../src/my-profile/my-address.service.ts
    title: MyAddressService — 주소 수정과 이력(WHALEERP-189)
    last_modified: 2026-10-20T07:10:00Z
  - id: my-password-service
    resource: ../../src/my-profile/my-password.service.ts
    title: MyPasswordService — 지금 비밀번호 확인 뒤 변경(WHALEERP-192)
    last_modified: 2026-10-21T01:31:05Z
  - id: my-consent-service
    resource: ../../src/my-profile/my-consent.service.ts
    title: MyConsentService — 위치정보 동의 · 본사 제공 동의 쓰기
    last_modified: 2026-10-20T08:30:00Z
  - id: my-profile-controller
    resource: ../../src/my-profile/my-profile.controller.ts
    title: 내 정보 경로 · 상태 코드 · 요청 한도(주소 · 이메일 · 비밀번호)
    last_modified: 2026-10-21T01:22:19Z
  - id: my-consent-controller
    resource: ../../src/my-profile/my-consent.controller.ts
    title: 위치정보 · 본사 제공 동의 경로
    last_modified: 2026-10-20T09:20:00Z
  - id: my-email-change-service
    resource: ../../src/my-profile/my-email-change.service.ts
    title: MyEmailChangeService — 이메일 변경 핀 요청 · 확인(WHALEERP-191)
    last_modified: 2026-10-21T01:22:19Z
  - id: close-unverified-email-change-pins
    resource: ../../prisma/migrations/20261021110054_team3_close_unverified_email_change_pins/migration.sql
    title: 비밀번호 확인 없이 낸 이메일 변경 핀을 배포 때 닫기(WHALEERP-607)
    last_modified: 2026-10-21T02:02:06Z
  - id: email-change-pin-sender
    resource: ../../src/my-profile/email-change-pin-sender.ts
    title: 이메일 변경 핀 메일(EMAIL_CHANGE_PIN), MAIL_* 없으면 503
    last_modified: 2026-10-20T08:30:00Z
  - id: my-memberships-service
    resource: ../../src/my-profile/my-memberships.service.ts
    title: MyMembershipsService — 소속 근무지 · 소속별 신고 정보
    last_modified: 2026-10-23T02:20:00Z
  - id: my-memberships-controller
    resource: ../../src/my-profile/my-memberships.controller.ts
    title: 소속 · 신고 정보 경로, 신고 정보 저장의 요청 한도
    last_modified: 2026-10-23T01:48:54Z
  - id: save-my-tax-profile-dto
    resource: ../../src/my-profile/dto/save-my-tax-profile.dto.ts
    title: 신고 정보 저장 본문(rrn · bankCode · payrollAccountNumber · currentPassword)
    last_modified: 2026-10-23T02:20:00Z
  - id: location-consent-state
    resource: ../../src/my-profile/location-consent-state.ts
    title: 위치정보 동의 상태 판정(API 전용 enum LocationConsentState)
    last_modified: 2026-10-20T05:01:41Z
  - id: personal-data-cipher
    resource: ../../src/common/personal-data-cipher.ts
    title: 개인정보 칸 암호화 · 복호화, 신고 정보 AAD
    last_modified: 2026-10-20T05:01:41Z
  - id: personal-data-key
    resource: ../../src/common/personal-data-key.provider.ts
    title: PERSONAL_DATA_ENCRYPTION_KEY 읽기와 빈 키 로그
    last_modified: 2026-10-20T05:01:41Z
  - id: active-staff
    resource: ../../src/todos/todo-rules.ts
    title: ACTIVE_STAFF — 재직 직원 기준(소속 판정)
    last_modified: 2026-10-20T03:47:38Z
  - id: personal-data-mask
    resource: ../../src/common/personal-data-mask.ts
    title: 주민등록번호 · 계좌번호 가림
    last_modified: 2026-10-20T05:01:41Z
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
| `PUT /me/memberships/:staffMemberId/tax-profile` | 신고 정보 작성 · 수정 (WHALEERP-334) |

The screen decides the split (2026-10-20): tapping a 소속 근무지 shows 근로계약서 ·
급여명세서 · 신고정보 buttons, each opening its own page. A 소속 is one staff
record, so those pages open by `staffMemberId`. The 근로계약서 · 급여명세서 pages
have no account-token API yet; when they get one it should take the same
`staffMemberId` and the same "is this my membership" check.

It also contains failure: one 신고 정보 row that cannot be decrypted, or a missing
key, used to fail the whole 내 정보 screen. Now it fails only that page.

Editing is below (189 주소 · 191 이메일 · 192 비밀번호 · 193 동의). 이름 · 생년월일 · 성별 · 외국인 여부 are never editable — 성별 · 외국인 여부
are not on the account and not in this response (they live on `contract_parties`) — and 휴대전화번호 is
read-only in 1차 (2026-10-19).
`GET /auth/account/me` stays the light status check the app makes on every open.

# Editing

All writes are `@UserTypes('account')`, take no account id, take the account row
lock (`SELECT … FOR UPDATE`) for the write — the password and e-mail routes verify
outside it and re-check under it — answer 401 for a withdrawn account and 204 on
success. The screen refetches `GET /me/profile`
after each one.

| 호출 | 내용 |
|---|---|
| `PUT /me/profile/address` | `{ zipCode, address, addressDetail? }` — 189[^my-address-service] |
| `POST /me/profile/password-change` | `{ currentPassword, newPassword }` — 192[^my-password-service] |
| `POST /me/profile/email-change-pins` | `{ newEmail, currentPassword }` — 191, 지금 비밀번호가 맞으면 새 이메일로 핀[^my-email-change-service] |
| `POST /me/profile/email-change` | `{ pin }` — 191, 맞으면 이메일을 바꿈 |
| `POST /me/location-consent` · `/pause` · `/resume` · `/withdraw` | 위치정보 동의 · 잠시 멈춤 · 다시 켜기 · 철회[^my-consent-service] |
| `POST /me/hq-sharing-consent` · `/withdraw` | 본사 제공 동의(다시 동의) · 철회[^my-consent-controller] |

**The address lives on the account, so "every 소속" is free.** `accounts`
holds 우편번호 · 도로명 주소 · 상세 주소 and staff records have no address of
their own, so one write shows on every 소속. 「이미 체결된 근로계약서에는 반영하지
않음」 holds because a contract keeps its own copy in `contract_parties`
(`zip_code` · `address` · `address_detail`) — nothing writes that copy yet; the
signing flow that fills it must copy the account's address at that moment and
never read it live. A save writes one `account_change_histories` row (`ADDRESS`,
`SELF`, before and after as `(우편번호) 주소 상세`); saving the same value writes
nothing. The PUT replaces all three columns, so leaving 상세 주소 out (or empty)
stores null. 우편번호 must be 5 digits; the road address is whatever the app's 주소
검색 (카카오 우편번호, ME-2) returned — the api does not check it against anything.

**The password change reuses the reset's rules and its write.** The current
password is checked first, then `validateNewPassword` (the same function as signup
and reset), then the hash is made outside the lock. Under the lock the stored
hash is compared with the one just verified — if a reset finished in between, the
verified password is no longer current and the answer is 400. The write is
`applyNewPassword` with channel `SELF` and `keepSessionId`: open reset PINs and
links and open 이메일 변경 PINs are closed, **every other device is signed out, this one stays**
(2026-10-20 노영주). A wrong current password does **not** count toward the
login lock — only a request limit (10 per 10 minutes per account,
`signedInUserTracker`) slows guessing with a stolen token (2026-10-20 노영주).
400 bodies carry the reason as `message`. `passwordChangedAt` in `GET
/me/profile` is the last `PASSWORD` history row (any channel), or `createdAt`
when there is none; the app decides what "오래" means for the 194 suggestion.

**The e-mail changes only after the current password and a PIN sent to the new
address are both right.** After the DTO's format checks (e-mail format, a
sendable address, `currentPassword` present — those 400s come first and reveal
nothing about accounts) and the service's own 503 (no `MAIL_*`) and 401
(withdrawn account), it checks `currentPassword` (WHALEERP-607, 운영 정책 ACC-13): a wrong one is 400 「지금 비밀번호가 맞지 않습니다」, the same
`message` as the password change, nothing is stored or sent, and — as there — it
does **not** count toward the login lock; the route's 10-per-10-minutes limit is
what slows guessing. That limit is counted per route, so a stolen token gets 10
guesses here **and** 10 on `password-change` — 20 per 10 minutes per account
(per instance; the 1-minute and daily PIN caps come after the password and do not
slow guessing). Sharing one bucket between the two routes would halve it; not
done. The password is checked before the same-address and in-use checks, so without
it a token cannot learn whether an address is taken (409) or current (400). Under
the issuing lock the stored hash is compared with the one just verified, so a
reset or password change that finished in between makes it 400 too. Only the PIN
request asks for it; `email-change` stays `{ pin }`, since a PIN exists only for a
request whose password was right — and `applyNewPassword` closes open 이메일 변경
PINs, so a password change or reset after the PIN was sent ends it too. The DTO
rejects an address mail cannot be sent to (400 「메일을 보낼 수
없는 형식의 이메일입니다」 — `@IsEmail` accepts a quoted local part such as
`"a"@example.com`, which `MailService` refuses, so it used to pass, lose its PIN and
end in 500; brackets and backslashes `@IsEmail` already rejects. The DTO now checks
the same rule as `MailService` through `IsSendableEmail`, which looks at the length
before the regex — `@Matches` would run the regex on the whole string even after
`@MaxLength` failed, and a 100 000-character input stalled the event loop for about
1.8 s; api #87 review). After the password, the service rejects the current
address (400) and one another account uses (409 이미 쓰고 있는 이메일입니다), then
stores a hashed 15-minute PIN with the
new address in `email_change_pins` ([Team 3 physical schema](/domain/team3-physical-schema.md))
and mails it through `EMAIL_CHANGE_PIN`, the PIN masked in `mail_send_logs`.[^email-change-pin-sender]
The send happens **after** the issuing transaction commits, in the reset link's
order: awaiting SMTP inside it would outlast Prisma's 5-second transaction limit
on a slow mail server — the mail goes out, the PIN rolls back, and the person
holds a PIN that does not exist (api review, 2026-10-20). If the send fails the new
PIN is deleted either way, so the person can ask again at once instead of waiting
out the 1-minute interval. An SMTP-stage failure (`isMailTransportError`) is 503
「지금은 인증 메일을 보낼 수 없습니다…」; a failure before sending (the
`EMAIL_CHANGE_PIN` template switched off, a missing title, a DB error) is 500
「메일 설정 문제로 인증 메일을 보내지 못했습니다. 관리자에게 문의해 주세요」, since
asking again will not fix it. The log line names the account and, for the second
kind, only the error's name and Prisma code — never the SMTP text, which can carry
the address; `MailService` logs the masked cause. Without `MAIL_*` every PIN request
is 503 before anything is stored, and in production the service logs an `error`
at boot. Only after a successful send are earlier
open PINs closed (those issued before this one), whatever address they went to;
if that close fails the answer is still 204, since confirmation only looks at the
newest open PIN. `email-change` then checks the latest open PIN the way the reset does
(scrypt outside the lock, re-read under it, wrong tries counted even when
refused, five close it) and, if right, sets `accounts.email`, closes **every** open
e-mail change PIN of the account (not only this one — if the post-send close had
failed, a PIN sent to another address would otherwise change the e-mail a second
time) and writes `EMAIL` / `SELF` with both addresses. The same transaction closes every
open password-reset PIN and 관리자 reset link of the account — they went to the old
address, and leaving them would let whoever holds that mailbox set a new
password. Unlike the reset this route is behind
the person's own token, so nothing is hidden: duplicates are 409, the interval
and daily cap are 429, and a wrong or expired PIN is **400**, not 401 — a 401
would read as "signed out" to the app. An address taken between PIN and change is
409 (checked under the lock, and the unique index catches a race). Sessions are
not ended; the next login uses the new address, refresh reads the e-mail from the
row, and an access token's `email` claim can lag by up to its 15 minutes. Both
routes have a 10-per-10-minutes limit per account.[^my-profile-controller] Until the change, the old
address logs in (195).

**Re-authentication is the current password, asked on the PIN request.** Until
2026-10-21 the routes needed only the account token: someone holding a stolen
token — or a script on the same origin, such as the 카카오 우편번호 script on 내 정보
(staff PR #11 review) — could send the PIN to their own address, move the login
there, then reset the password through the new mailbox. 노영주 had left that gap on
2026-10-20 and closed it on 2026-10-21 by requiring `currentPassword` on
`email-change-pins`. Since `email-change` does not look at the password, a PIN
issued without one before the deploy would still work for its 15 minutes, so
`20261021110054_team3_close_unverified_email_change_pins` sets `used_at` on every
open PIN issued before it runs (rows stay, since the 1-minute and daily caps count
them).[^close-unverified-email-change-pins] It belongs after the new api is up — applied
first it does no harm, but the old api can still issue tokenless PINs until it
stops. The other candidate, mailing the old address that the login
e-mail changed, is not built. The duplicate check still lets a signed-in person
who knows their password learn whether an address is registered, up to the
route's 10 per 10 minutes — accepted, since rejecting duplicates is the
requirement.

**Consent writes are state transitions, and a mismatch is 409.** 위치정보:
동의 creates a row (only when none is unwithdrawn — the partial unique index
allows one; five parallel 동의 give one 204 and four 409, proven in e2e), with the
version of the `LOCATION` 약관 in force today (same pick as the public 약관 API).
잠시 멈춤 needs an unpaused row, 다시 켜기 a paused one and clears `paused_at`
without a new agreement (ATT-26), 철회 any unwithdrawn row. If no `LOCATION` 약관
is active and in force (an operator switched or deleted them all), 동의 is 500
「지금은 위치정보 동의를 받을 수 없습니다. 관리자에게 문의해 주세요」 with an `error`
log naming the account. 본사 제공: 동의
sets the four account columns with `HQ_SHARING_CONSENT_VERSION` (`v1.0`, an api
constant — the wording is in the app, and both change together, 2026-10-20
노영주), overwriting an earlier withdrawal (A안); 철회 sets only the flag and
`hq_sharing_withdrawn_at`, keeping version and 동의 시각 as the CHECKs require.
The api does not check that the person has a 가맹 소속; the screen shows the row
only then. 409 carries no code — the app refetches.

# Memberships are the 재직 직원 rule, not every record

`memberships` lists the account's staff records that match `ACTIVE_STAFF`
(`src/todos/todo-rules.ts`) — a 체결 완료 contract, 가입 완료, not retired.[^active-staff]
TO-DO uses the same constant; payroll has no module yet but its policy (PAY-16 ·
CTR-29) is the same rule and should use it too, so the app never shows a 소속 that
the other screens ignore. If `ACTIVE_STAFF` changes, this page changes with it.
Consequences:

- a record with only a 임시저장 contract is not a 소속 (2026-10-19 decision);
- 퇴직 예정 is a 소속, with `retiredDate` set;
- retired records and records not yet joined are absent.

Ordered by 입사일 (missing last) then `staffMemberId`. An account with none — 연결
보류, or everything retired — gets `{ items: [], total: 0 }`. Deleted stores are
not filtered, and need not be: a store can be deleted only while 미운영 and with no
contract in progress, so no 소속 of this rule can point at one.

**The tax-profile route uses the same rule as its ownership check.** It looks up
`{ staffMemberId, accountId, ...ACTIVE_STAFF }`, so someone else's id, and also
one of your own retired or draft-only records, is 404 — even when that record has
a 신고 정보 row. Anything outside the list does not exist from this route, and
every one of those 404s (including an id that does not exist or is out of range)
has the same body, so the response cannot tell whether someone else's record
exists.

`store` is read with a second query: `staff_members.store_id` points at 1팀's
`stores`, but 3팀's Prisma models hold it as a plain `Int` with no relation, so
`select: { store: … }` is a validation error at runtime that a mocked unit test
does not see. The e2e caught it.

# 본사 제공 동의 is the account's

`hqSharingConsent` (ATT-30) comes from `accounts` — one value per person, applied
to every 가맹 소속 ([Team 3 physical schema](/domain/team3-physical-schema.md),
api #78). The old four columns on `staff_members` were dropped by 민식
(`20261020140331_team3_drop_staff_member_hq_sharing`); nothing here ever read them. The
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
`pausedAt` (ATT-23 · ATT-26). A row paused and later withdrawn still holds its
`paused_at`, so the response sends `pausedAt` only when the state is `PAUSED` —
otherwise an app drawing a badge from `pausedAt` would show 일시 중지 to someone
who withdrew.

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
  Empty means the api still boots and only reading an existing 신고 정보 is 503
  (a 소속 with none is still 200). An empty key logs at boot — `error` in
  production, `warn` elsewhere — and again at each such request, so a forgotten
  setting shows in the logs rather than only as a 503 on one page. The 503 body
  says only "지금 볼 수 없습니다"; the missing setting is in the log, not the
  response. A value of the
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
than being masked into something that looks right.

**A value that cannot be opened is a 500, and the log says which.** A different
key, a ciphertext moved from another row, a damaged value or a broken format all
end in `500 신고 정보를 읽을 수 없습니다`, with an `error` log naming
`staffMemberId` and the column — enough to tell a key accident (every row fails)
from one damaged row. Neither the log nor the mask errors carry the plaintext.

A 소속 with no 신고 정보 yet is
200 with `taxProfile: null`, not 404 — "not submitted" is a normal state of the
page.

# Writing 신고 정보 (WHALEERP-334)

`PUT /me/memberships/:staffMemberId/tax-profile` with `{ rrn?, bankCode?, payrollAccountNumber?, currentPassword? }`
(hyphens and spaces are dropped; a field is skipped only when absent — `null` is 400, it used to reach
the cipher and 500, api #86 review). The same "is this my membership" check as the read — anything else
is 404 — and the account token only: an admin token is 403 at the guard. The answer is the read's shape,
masked values only.

- **Changing an existing profile needs the current password** (`currentPassword`, string, 1–128 —
  the same shape as the e-mail change PIN request, WHALEERP-607; WHALEERP-333 · 334 follow-up, 2026-10-23
  노영주). A stolen token alone must not be able to point the 급여 계좌 at another account. Missing or
  wrong is the same 400 `{ code: 'CURRENT_PASSWORD_MISMATCH', message: '지금 비밀번호가 맞지 않습니다' }`
  (607's message) — 607 tells them apart only because there the field is always required and the DTO
  rejects it; here it is optional, so the service answers both. The **first save does not take it** (the
  post-signing flow, 150) — sent anyway, the service does not compare it, but the DTO still checks its
  shape (string, non-empty, ≤ 128), so an empty or too-long value is 400 even on a first save. **Order**:
  my-membership 404 → password → everything else, with these exceptions in front: DTO validation, the
  request-shape 400s (empty body · one-sided account), and 503 when the server has no encryption key
  (`requireKey`, checked before the 404 and the password). Before the password nothing about the stored values is answered — otherwise the
  birth-date check, the bank check or "same value, nothing written" would let a token holder guess the
  주민등록번호 or account number. A wrong password does not count toward the login lock; the route is
  rate-limited instead — **10 per 10 minutes per signed-in account** (`signedInUserTracker`, plus the
  module's IP axis), the same as the e-mail change, counting first saves too; over it is 429. scrypt runs
  outside the transaction; under the staff-row lock the account row is taken `FOR SHARE` (staff row →
  account row, the same order signup linking uses) and the hash is compared with the one verified, so a
  password reset or change committed in between makes it 400 and nothing is written.
- **First time** needs all three — 400 `TAX_PROFILE_INCOMPLETE` otherwise. **After that** send the
  주민등록번호 alone, or the 급여 계좌 (bank and number together — one alone is 400
  `TAX_PROFILE_ACCOUNT_INCOMPLETE`); what is not sent stays. Nothing at all is 400 `TAX_PROFILE_EMPTY`.
- **주민등록번호**: 13 digits (외국인등록번호 included). The first seven digits must give the account's
  birth date — the 7th digit sets the century (1·2·5·6 → 1900s, 3·4·7·8 → 2000s, 9·0 → 1800s) —
  otherwise 400 `RRN_BIRTH_MISMATCH` telling the 직원 to ask the 관리자 for a correction (진입 · 가입 화면
  가이드). The check digit is not checked: numbers issued since 2020 and 외국인등록번호 do not follow it
  (2026-10-20 김민식). A new 주민등록번호 sets `collected_at` to now and **overwrites** the old one —
  nothing of the previous value is kept (until the 법무 검토 TAX-7 says otherwise).
- **급여 계좌**: `bankCode` must be an active `BANK` 공통코드 item (400 `BANK_CODE_UNKNOWN`), the number
  10–16 digits. A change applies **from the next pay**; payslips keep no account today, so saving is all
  there is to do. `collected_at` does not move.
- `purpose` is fixed (`취득 신고 · 원천징수 · 급여 이체`) and set on creation.
- Values are sealed with the same key and AAD as above, so the read opens them; no key is 503 before
  anything is read or written.
- **Only what actually changed is written** (2026-10-21 김민식, api #86 review): the stored values are
  opened and compared, since the ciphertext differs on every seal (random IV). The same 주민등록번호 again
  leaves it and `collected_at` alone; the same bank and number leave the 급여 계좌 alone (a new bank with
  the same number is a change). If nothing changed nothing is written and the current values come back.
  A stored value that cannot be opened (damaged, key changed) is 500 and **nothing is written — not even
  for a field being sent**: overwriting it would let a wrongly deployed key re-seal every re-entered value,
  which the right key could then no longer open (2026-10-21 김민식, api #95 code-review). The masked answer
  is built inside the same transaction, so a value that cannot be shown rolls the write back too.
- **Change history**: one `staff_tax_profile_histories` row per item that actually changed
  (`RRN` / `PAYROLL_ACCOUNT`) with the staff record, the account that saved and the time — never the
  values. The first save writes both; re-sending what is already there writes none, so the app may send
  the whole form. Same transaction as the write (logical ERD front #69, 2026-10-20 재영).
- **Two first saves at once**: the staff row is taken `FOR UPDATE` before the profile is read, so the
  second one sees the first one's profile instead of failing on the primary key (500 before, api #86
  review). Since 2026-10-23 that second one is an update whose password was never checked, so it is 400
  `CURRENT_PASSWORD_MISMATCH` and writes nothing — the app should treat it as "already saved" and reload. The "my active membership" check runs again under that lock — a 퇴직 확정
  committed in between makes it 404 and nothing is written (api #86 re-review). The birth date for the
  RRN check is read in that same post-lock read. Checking existence first keeps the save from locking
  someone else's row.

[^my-profile-service]: MyProfileService — 내 정보(계정 칸 · 동의 · 비밀번호 변경 시각)
[^my-address-service]: MyAddressService — 주소 수정과 이력(WHALEERP-189)
[^my-password-service]: MyPasswordService — 지금 비밀번호 확인 뒤 변경(WHALEERP-192)
[^my-consent-service]: MyConsentService — 위치정보 동의 · 본사 제공 동의 쓰기
[^my-email-change-service]: MyEmailChangeService — 이메일 변경 핀 요청 · 확인(WHALEERP-191)
[^my-profile-controller]: 내 정보 경로 · 상태 코드 · 요청 한도(주소 · 이메일 · 비밀번호)
[^my-consent-controller]: 위치정보 · 본사 제공 동의 경로
[^close-unverified-email-change-pins]: 비밀번호 확인 없이 낸 이메일 변경 핀을 배포 때 닫기(WHALEERP-607)
[^email-change-pin-sender]: 이메일 변경 핀 메일(EMAIL_CHANGE_PIN), MAIL_* 없으면 503
[^my-memberships-service]: MyMembershipsService — 소속 근무지 · 소속별 신고 정보
[^location-consent-state]: 위치정보 동의 상태 판정(API 전용 enum LocationConsentState)
[^personal-data-cipher]: 개인정보 칸 암호화 · 복호화, 신고 정보 AAD
[^personal-data-key]: PERSONAL_DATA_ENCRYPTION_KEY 읽기와 빈 키 로그
[^active-staff]: ACTIVE_STAFF — 재직 직원 기준(소속 판정)
[^personal-data-mask]: 주민등록번호 · 계좌번호 가림
