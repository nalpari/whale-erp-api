---
type: API
title: Staff signup (직원 앱 가입)
description: The 직원 앱 entry and signup of the 진입 · 가입 화면 가이드 (JOIN-7) — POST /auth/account/invitations/check finds a live 가입 초대 by the link token or by phone + 초대 코드 and returns the 근무지 · 고용 형태 · 유효 기간 · phone to fill; POST /auth/account/signup creates the account on the invitation's phone, links the 직원 레코드, accepts the invitation, moves the waiting 근로계약 to 서명 대기 and returns a login session in one go; 만 19세 미만 stops with the invitation marked 가입 불가 and an 운영 알림. No 본인인증; the per-phone lock waits for its table.
tags: [auth, signup, staff, invitation, team3]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-28T05:30:00Z }
sources:
  - id: staff-signup-service
    resource: ../../src/staff-signup/staff-signup.service.ts
    title: StaffSignupService (lookup, check, signup transaction, under-age notice, logged-in list · accept)
    last_modified: 2026-10-28T05:30:00Z
  - id: my-invitations-controller
    resource: ../../src/staff-signup/my-invitations.controller.ts
    title: GET /me/invitations · POST /me/invitations/:invitationId/accept (account token)
    last_modified: 2026-10-28T05:30:00Z
  - id: my-invitation-dto
    resource: ../../src/staff-signup/dto/my-invitation.dto.ts
    title: MyInvitationDto · MyInvitationListResponseDto · AcceptMyInvitationDto · AcceptMyInvitationResponseDto
    last_modified: 2026-10-28T05:30:00Z
  - id: staff-signup-controller
    resource: ../../src/staff-signup/staff-signup.controller.ts
    title: /auth/account/invitations/check · /auth/account/signup (public, default rate limit)
    last_modified: 2026-10-20T06:10:00Z
  - id: staff-signup-dto
    resource: ../../src/staff-signup/dto/staff-signup.dto.ts
    title: StaffSignupDto (lookup + account + 인적사항; no phone of its own)
    last_modified: 2026-10-21T07:07:00Z
  - id: hq-sharing-consent
    resource: ../../src/staff-signup/hq-sharing-consent.ts
    title: 본사 제공 동의 문구 버전 and which stores ask
    last_modified: 2026-10-20T06:10:00Z
  - id: staff-signup-migration
    resource: ../../prisma/migrations/20261021103042_team3_staff_signup/migration.sql
    title: accounts.gender · is_foreigner and NTF_SIGNUP_UNDER_AGE
    last_modified: 2026-10-20T05:46:10Z
  - id: staff-signup-e2e
    resource: ../../test/staff-signup.e2e-spec.ts
    title: Signup against a real DB
    last_modified: 2026-10-28T05:30:00Z
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

Both are public, behind AuthModule's **default** rate limit like the other public auth routes (signup
burns scrypt); signup is also on the account axis by e-mail. There is **no IP limit of its own** for
code entry — guessing is stopped by the per-phone lock below (운영 정책 JOI-02 v158, 2026-10-20 재영
dropped the 「접속 IP 기준 제한」 of the guide).

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

**The per-phone lock** (JOIN-7, 2026-10-20 김민식) runs before the lookup whenever phone + code is
sent (check and signup; the token is 32 random bytes and is not counted). It mirrors 이메일 찾기:

- `invitation_code_attempts` (logical ERD front #64, 재영) — one row per try, keyed by
  `invitationCodePhoneKeyOf` (HMAC of the phone with its own purpose prefix, no phone stored). The
  latest row's `failed_count` · `lock_expires_at` is the state; tries for one phone queue on
  `pg_advisory_xact_lock`.
- A phone + code matching a **live** 가입 초대 of that phone (`SENT`, before `expires_at`) clears the
  count. A match on an ended one (expired · accepted) neither counts nor clears — an old code cannot reset
  the count (api #81 review) — and the request answers 404 `INVITATION_ENDED` / 409 as below. No
  match counts a failure — **phones with no invitation count the same**, so the lock never tells
  whether a phone was invited — and answers 404. The 5th failure locks for **30 minutes**
  (`registerFailure(…, CODE_LOCK_MS)`) and answers 429 `INVITATION_CODE_LOCKED` with
  `lockExpiresAt`; while locked even the right code is 429, recorded but not counted.
- The record commits on its own, so a later failure of the request does not undo the count.
- **A resend unlocks the phone**: `ContractDeliveryService.prepare` writes a cleared row (0 failures,
  no lock, `is_succeeded` true like a matching code) for the phone it sends a 가입 초대 to (2026-10-20
  김민식), queued on the same phone key as the input. The lock check reads only the count and the lock
  time; `is_succeeded` marks the rows the count restarts from. If the 알림톡 surely did not go out, the undo queues on the same phone key and deletes that
  row **and the attempts after it** with the invitation — the previous state (its lock included) counts
  again. Deleting only the cleared row would leave a failure counted from 0 in between as the latest row,
  so the lock would stay lifted (api #81 re-review). It stops before the next `is_succeeded` row (another
  resend's unlock or a matching code): from there on that request lifted the lock, and deleting it would
  lock out the code that request delivered (api #81 3rd review). A match on an ended invitation copies
  the previous state, which can also be (0, no lock) — it is not `is_succeeded`, so the undo does not
  stop there and leave the lock lifted (api #81 4th review). So `is_succeeded` now means "the count
  restarts here" (a code matching a live invitation — one on an ended invitation stays false — or a resend's
  unlock), not only a successful entry; the column comment says so from migration
  `20261022142049_team3_invitation_code_attempts_is_succeeded_comment` (api #124). During a rolling deploy an old
  instance's unlock row is not marked, so a new instance's undo may delete it and re-lock a code that old
  instance did deliver (until 30 minutes pass or it is resent) — accepted, the window is small.
- `token` · `phone` · `code` skip validation only when absent; `null` is a 400 (it used to reach
  `hashToken` and 500).

# Signup

`StaffSignupDto` = the lookup + `email` (login id, lower-cased; also `IsSendableEmail` — a quoted local
part like `"a"@example.com` is a 400, since password-reset mail could never reach it, api #81 3rd review) ·
`password` · `name` · `birthDate`
(YYYY-MM-DD) · `gender` (required, 남 · 여 — 2026-10-21 재영: 본인 대조가 늘 다섯 가지를 보도록
성별이 빈 계정을 만들지 않는다, ACC-23 · JOI-10) · `isForeigner` (optional) · `zipCode` (5 digits) ·
`address` · `addressDetail` (optional) · `hqSharingConsented` (optional) · `deviceIdentifier`
(optional, as in login). **There is no phone field**: the account takes the invitation's
(근로계약서) phone — if a 직원 could type it, they could sign up on someone else's number and block
that person's next invitation (JOIN-7). 약관 동의 waits for 1팀's common 약관 registration
(2026-10-20 김민식).

Before the transaction: the password rule (`validateNewPassword`) is 400, a birth date after today
(KST) is 400 `BIRTH_DATE_IN_FUTURE` (a mistyped year would otherwise end the invitation as 만 19세
미만), then the phone + code lock, and scrypt runs outside.

In one transaction:

1. Find the live invitation again, then **take the person lock** `lockPeople(tx, [phone])` — the
   same order as 근로계약 save and resend (phone → contract → invitation), so two signups on one phone
   queue (the second sees the first account and is 409) and a signup racing a resend cannot deadlock
   (api #81 review). Then **lock the staff record** (`FOR UPDATE`) before the invitation and the
   contracts — the order 퇴직 확정 takes (staff → invitation → contract), so the two cannot deadlock —
   and re-read its phone: changed meanwhile by a 근로계약 edit → 404 `INVITATION_ENDED`, so an account
   is never made on the old number (api #81 re-review). Under those locks an account on its phone → 409
   `ACCOUNT_EXISTS`.
2. **만 19세 미만 on the signup day (KST)** → the invitation becomes `REJECTED_UNDER_AGE` (conditioned
   on `SENT`), nothing else is written, the birth date is stored nowhere. After commit an 운영 알림
   `NTF_SIGNUP_UNDER_AGE` goes to the store's managers (`storeManagers`, event key
   `invitation:{id}`), then **400 `SIGNUP_UNDER_AGE`** with the ACC-22 sentence. The 직원 목록 shows
   가입 불가(만 19세 미만); the 관리자 fixes the birth date and sends again.
3. Accept: `SENT → ACCEPTED`, `responded_at`, conditioned on `SENT`. 0 rows means the invitation
   changed meanwhile: re-read — `ACCEPTED` is 409 `INVITATION_ALREADY_JOINED`, anything else (resent ·
   retired · replaced) is 404 `INVITATION_ENDED`, so nobody without an account is sent to login.
4. Create the account (`JOINED`) with the entered values and the invitation's phone. An e-mail already
   in `accounts` → **409 `ACCOUNT_EMAIL_TAKEN`**. At a non-`DIRECT` store with
   `hqSharingConsented: true` the **account** gets `is_hq_sharing_consented` ·
   `hq_sharing_consent_version` (`HQ_SHARING_CONSENT_VERSION`, the one constant of 내 정보 동의 #85) · `hq_sharing_agreed_at` — one answer per
   person since api #78.
5. Link the record (`account_id`, `join_status = JOINED`, conditioned on no account yet).
6. The record's 발송 대기 contracts → 서명 대기, history actor `STAFF`. The deadline from the send stays.

After commit a session is issued (`AuthSessionService.issue`, same device rule as login) and the login
response returned. A failure there leaves the signup done — the 직원 logs in from the login screen.

# Adding a 근무지 after login (WHALEERP-603)

Two stores can send a 가입 초대 to the same phone at the same time (neither saw an account then). After
signing up with one, the other answers 409 `ACCOUNT_EXISTS` at the check. The logged-in 직원 then adds
that 근무지 in the app (2026-10-20 김민식) — `MyInvitationsController`, account token required (admin
token 403), AuthModule's default rate limit plus the account axis (10 per 10 minutes per account,
`signedInUserTracker`) on the accept route only. The list is read whenever the 소속 근무지 screen opens,
so it skips the account axis (`@SkipThrottle({ account: true })` — the global default is also 10 per
10 minutes, counted per token; e2e calls it 11 times) and keeps the IP axis; no IP limit of its own
(JOI-02 v158).

Name match instead of the code (2026-10-28 김민식, api #180 review): possession of the phone used to
be proven by a code · link from the 알림톡. An account's phone is fixed at signup with no change path,
so a recycled number would let the old account see and accept the new owner's invitations. Both the
list and accept therefore also require the record's name (근로계약서) to equal the account's
`realName` under the 본인 대조 rule — whitespace removed, Latin upper-cased (`sameName`, same as
`contracts/identity-match.ts` `nameKey`, kept local because contracts is another team's area). A
different name is treated like another person's invitation: absent from the list, 404
`INVITATION_NOT_FOUND` on accept, checked before the status. A same-name new owner is not caught;
the 날인 본인 대조 (name · phone · birth date · gender · foreigner) still stands in front of signing.

**Since 2026-10-28 the app picks from a list instead of typing a code or opening the link**
(WHALEERP-603 changed). The old `POST /me/invitations/check` · `POST /me/invitations/accept` (code ·
token lookup, with the per-phone code lock counted on the account's phone) are gone, and with them
`MyInvitationLookupDto` and the account-side lock — the public signup path keeps its lock unchanged.

- `GET /me/invitations` → 200 `{ items: MyInvitationDto[], total }`, each `{ invitationId, storeName,
  employmentType, jobTitle, sentAt, expiresAt, asksHqSharingConsent }`. The items are the live 가입
  초대 · 재초대 sent to **the account's phone** — `SENT`, `expires_at` ahead, the record's phone equals
  the account's and the record has no account yet (the same "live" as the signup check) — newest
  `sent_at` first (then id). An invitation whose store cannot be found is skipped.
  `asksHqSharingConsent` is true only at a non-`DIRECT` store **and** when the account has not
  consented yet (one answer per person, api #78).
- `POST /me/invitations/:invitationId/accept` with `{ hqSharingConsented? }` → 200 `{ staffMemberId,
  storeName }` — the app goes to that 소속's waiting contract. The id goes through `InvitationIdPipe`
  (`parseRouteId`: outside `1..2147483647` or not digits is 404 `INVITATION_NOT_FOUND` before any
  query). Then, inside the transaction, the invitation is read by id and judged **phone first**:

  | Found | Answer |
  |---|---|
  | none, not `SIGNUP` · `REINVITE`, or the record's phone ≠ the account's | 404 `INVITATION_NOT_FOUND` — whatever its status, so someone else's invitation never shows whether it was accepted or ended |
  | mine, `ACCEPTED` | 409 `INVITATION_ALREADY_JOINED` |
  | mine, not live (not `SENT`, past `expires_at`, record already has an account) or its store is gone | 404 `INVITATION_ENDED` |

  Otherwise in one transaction: accept the invitation (`SENT → ACCEPTED`, conditioned; 0 rows re-reads
  — `ACCEPTED` 409, else 404 `INVITATION_ENDED`), link that 직원 레코드 to the account (`JOINED`), 발송
  대기 contracts → 서명 대기 (actor `STAFF`). When consent is asked and sent, the account gets it
  (version · agreed-at, withdrawn-at cleared).
- Locks as at signup: the person lock `lockPeople(tx, [phone])` first, then the account is re-read and
  the invitation found, then the staff record `FOR UPDATE` before the invitation and the contracts —
  the same order as 재발송 and 퇴직 확정, so they never wait on each other (api #81 3rd review). The
  phone is read again under that lock; if a 근로계약 edit changed it meanwhile, 404 `INVITATION_ENDED`
  and nothing is linked.

No account details, 인적사항, 약관 or age check — the account exists already (WHALEERP-137). A
withdrawn or missing account is 401 on both routes. This is not 소속 추가 확인 (WHALEERP-144): that path
is for numbers that already had an account when the 근로계약서 was saved, and its invitation type
(`AFFILIATION_CONFIRM`) is a 404 here.

# No 본인인증

The entered 이름 · 생년월일 · 성별 · 외국인 여부 are kept on the account (`accounts.gender` ·
`is_foreigner` added for this) and compared with the 근로계약서 at signing ([Contracts API](/api/contracts-api.md)
본인 대조, WHALEERP-125 · 145). The phone always matches, since it comes from the invitation.
`connecting_information` stays empty and `LINK_HOLD` is unused.

# Left for later

- 약관 동의 (1팀 common 약관 registration).
- `NTF_SIGNUP_UNDER_AGE` wording is a draft for the 기획 to confirm.
- The 직원 앱 screen for adding a 근무지 (WHALEERP-604) — where the invitation list sits is for the 기획.
