---
type: API
title: Staff signup (직원 앱 가입)
description: The 직원 앱 entry and signup of the 진입 · 가입 화면 가이드 (JOIN-7) — POST /auth/account/invitations/check finds a live 가입 초대 by the link token or by phone + 초대 코드 and returns the 근무지 · 고용 형태 · 유효 기간 · phone to fill; POST /auth/account/signup creates the account on the invitation's phone, links the 직원 레코드, accepts the invitation, moves the waiting 근로계약 to 서명 대기 and returns a login session in one go; 만 19세 미만 stops with the invitation marked 가입 불가 and an 운영 알림. No 본인인증; the per-phone lock waits for its table.
tags: [auth, signup, staff, invitation, team3]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-20T06:10:00Z }
sources:
  - id: staff-signup-service
    resource: ../../src/staff-signup/staff-signup.service.ts
    title: StaffSignupService (lookup, check, signup transaction, under-age notice)
    last_modified: 2026-10-20T06:10:00Z
  - id: staff-signup-controller
    resource: ../../src/staff-signup/staff-signup.controller.ts
    title: /auth/account/invitations/check · /auth/account/signup (public, IP 30/min)
    last_modified: 2026-10-20T06:10:00Z
  - id: staff-signup-dto
    resource: ../../src/staff-signup/dto/staff-signup.dto.ts
    title: StaffSignupDto (lookup + account + 인적사항; no phone of its own)
    last_modified: 2026-10-20T06:10:00Z
  - id: hq-sharing-consent
    resource: ../../src/staff-signup/hq-sharing-consent.ts
    title: 본사 제공 동의 문구 버전 and which stores ask
    last_modified: 2026-10-20T06:10:00Z
  - id: staff-signup-migration
    resource: ../../prisma/migrations/20261020144610_team3_staff_signup/migration.sql
    title: accounts.gender · is_foreigner and NTF_SIGNUP_UNDER_AGE
    last_modified: 2026-10-20T05:46:10Z
  - id: staff-signup-e2e
    resource: ../../test/staff-signup.e2e-spec.ts
    title: Signup against a real DB
    last_modified: 2026-10-20T06:10:00Z
---

# What it is

The 직원 who got a 가입 초대 ([Contracts API](/api/contracts-api.md) — sending: 알림톡 body with an
8-character 초대 코드, link `/invite#token=…`) signs up in the 직원 앱. The screens follow the
진입 · 가입 화면 가이드 (whale-erp-staff `docs/plans/2026-10-19-진입-가입-화면-가이드.md`, JOIN-7 ·
2026-10-19 재영), taken as the whole basis on 2026-10-20 (김민식):

1. **Check** — `POST /auth/account/invitations/check` with either `{ token }` (opened from the link)
   or `{ phone, code }` (typed in the app). 200 `{ storeName, employmentType, expiresAt, phone,
   asksHqSharingConsent }`.
2. **Signup** — `POST /auth/account/signup` with the same lookup plus the account and 인적사항.
   201 with the **login response** (`accessToken` · `refreshToken` · `refreshTokenExpiresAt` ·
   `account`, built by `AccountAuthService.loginResponseOf`) — the 직원 lands on the home screen
   logged in, where the 날인 요청 shows (가이드 ④).

Both are public, behind AuthModule's rate limit with the IP axis at **30 per minute**
(`EMAIL_FIND_IP_LIMIT`, JOIN-7 「접속 IP 기준 제한」); signup is also on the account axis by e-mail.

# Finding the invitation

Exactly one of the two keys, or 400:

- **Token** — `invitations.invitation_token` = sha256 of the 43-character link token.
- **Phone + code** — `invitations.invitation_code_hash` = HMAC of the code (upper-cased) **and** the
  invitation's 직원 레코드 has that phone. Both must match; the phone input drops hyphens.

Only `SIGNUP` · `REINVITE` invitations. Live = `SENT`, `expires_at` ahead, the record has no account.

| Found | Answer |
|---|---|
| nothing | 404 `INVITATION_NOT_FOUND` — for phone + code 「휴대전화번호나 초대 코드를 다시 확인해 주세요」, never which one was wrong |
| an `ACCEPTED` one | 409 `INVITATION_ALREADY_JOINED` — the app goes to login |
| only ended ones (past `expires_at`, `EXPIRED`, `REJECTED_UNDER_AGE`) | 404 `INVITATION_ENDED` — ask the 근무지 to invite again |
| live, but a non-withdrawn account already has the record's phone | 409 `ACCOUNT_EXISTS` — log in, then add the 근무지 in the app (WHALEERP-603) |

The check shows only the 근무지 · 고용 형태 · 유효 기간 and the phone to fill — never the record's name ·
birth date or anything about an existing account (가이드 ②). `asksHqSharingConsent` is true unless the
store is `DIRECT` (an unknown type asks too — the same line as `hidesPersonalData`).

**Not yet: the per-phone lock** (5 wrong phone + code tries → 30 minutes, phones without an
invitation counted the same, a resend unlocks that phone — JOIN-7, 2026-10-20 김민식). Its table
`invitation_code_attempts` (shaped like `email_find_attempts`) is requested from 재영 for the logical
ERD; until it lands only the IP limit applies. **Do not ship to users without it.**

# Signup

`StaffSignupDto` = the lookup + `email` (login id, lower-cased) · `password` · `name` · `birthDate`
(YYYY-MM-DD) · `gender` (optional, 남 · 여) · `isForeigner` (optional) · `zipCode` (5 digits) ·
`address` · `addressDetail` (optional) · `hqSharingConsented` (optional) · `deviceIdentifier`
(optional, as in login). **There is no phone field**: the account takes the invitation's
(근로계약서) phone — if a 직원 could type it, they could sign up on someone else's number and block
that person's next invitation (JOIN-7). 약관 동의 waits for 1팀's common 약관 registration
(2026-10-20 김민식).

Before the transaction: the password rule (`validateNewPassword`) is 400, and scrypt runs outside.

In one transaction:

1. Find the live invitation again; an account on its phone → 409 `ACCOUNT_EXISTS`.
2. **만 19세 미만 on the signup day (KST)** → the invitation becomes `REJECTED_UNDER_AGE` (conditioned
   on `SENT`), nothing else is written, the birth date is stored nowhere. After commit an 운영 알림
   `NTF_SIGNUP_UNDER_AGE` goes to the store's managers (`storeManagers`, event key
   `invitation:{id}`), then **400 `SIGNUP_UNDER_AGE`** with the ACC-22 sentence. The 직원 목록 shows
   가입 불가(만 19세 미만); the 관리자 fixes the birth date and sends again.
3. Accept: `SENT → ACCEPTED`, `responded_at`, conditioned on `SENT` — a second signup on the same
   invitation changes 0 rows and is 409 `INVITATION_ALREADY_JOINED`.
4. Create the account (`JOINED`) with the entered values and the invitation's phone. An e-mail already
   in `accounts` → **409 `ACCOUNT_EMAIL_TAKEN`**. At a non-`DIRECT` store with
   `hqSharingConsented: true` the **account** gets `is_hq_sharing_consented` ·
   `hq_sharing_consent_version` (`HQ_SHARING_CONSENT_VERSION`) · `hq_sharing_agreed_at` — one answer per
   person since api #78.
5. Link the record (`account_id`, `join_status = JOINED`, conditioned on no account yet).
6. The record's 발송 대기 contracts → 서명 대기, history actor `STAFF`. The deadline from the send stays.

After commit a session is issued (`AuthSessionService.issue`, same device rule as login) and the login
response returned. A failure there leaves the signup done — the 직원 logs in from the login screen.

# No 본인인증

The entered 이름 · 생년월일 · 성별 · 외국인 여부 are kept on the account (`accounts.gender` ·
`is_foreigner` added for this) and compared with the 근로계약서 at signing ([Contracts API](/api/contracts-api.md)
본인 대조, WHALEERP-125 · 145). The phone always matches, since it comes from the invitation.
`connecting_information` stays empty and `LINK_HOLD` is unused.

# Left for later

- The per-phone lock (above).
- 약관 동의 (1팀 common 약관 registration).
- `NTF_SIGNUP_UNDER_AGE` wording is a draft for the 기획 to confirm.
- Adding a 근무지 after login with another 초대 코드 (WHALEERP-603 · 604).
