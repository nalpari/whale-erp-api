---
type: API
title: BP signup (관리자 웹 회원가입)
description: POST /auth/signup creates a customer BP and its BP 마스터 in one transaction, records the two required 약관 agreements, mails the applicant and the platform masters after commit, and returns a 10-minute signup token that is not an access token; what is deliberately left for later.
tags: [auth, signup, bp, admin, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-12T07:05:00Z }
sources:
  - id: signup-service
    resource: ../../src/admin-signup/admin-signup.service.ts
    title: AdminSignupService (availability, signup transaction, BP code numbering, mails)
    last_modified: 2026-10-12T07:05:00Z
  - id: signup-controller
    resource: ../../src/admin-signup/admin-signup.controller.ts
    title: /auth/signup routes (public, throttled)
    last_modified: 2026-10-12T07:05:00Z
  - id: signup-dto
    resource: ../../src/admin-signup/dto/signup.dto.ts
    title: SignupDto (format rules shared with the front signup screen)
    last_modified: 2026-10-12T07:05:00Z
  - id: admin-password-policy
    resource: ../../src/admin-signup/admin-password-policy.ts
    title: 관리자 웹 password rule
    last_modified: 2026-10-12T07:05:00Z
  - id: admin-web-url
    resource: ../../src/admin-signup/admin-web-url.ts
    title: ADMIN_WEB_URL validation at startup
    last_modified: 2026-10-12T07:05:00Z
---

# What it does

The specification is manyfast F-JVTPSU (screens S-RCJXIG 회원가입 and S-UUBGOD 가입
완료) and front's `docs/flow/auth-account`. One request creates a customer BP and
its BP 마스터 together; no store is created.

| Route | Purpose |
|---|---|
| `POST /auth/signup` | Sign up. 201 `{ signupToken, tradeName, loginId, email }`; 409 for a taken 아이디 or 이메일 |
| `POST /auth/signup/login-id-availability` | `{ loginId }` → `{ available }` |
| `POST /auth/signup/email-availability` | `{ email }` → `{ available }` |

All three are `@Public()` and behind `ThrottlerGuard`. Signing up burns scrypt, and
the availability checks tell anyone whether an id or address is registered, so all
three need the IP and account limits. The account axis (`accountTracker`) keys on
the body's email, or — for `login-id-availability`, whose body has no email — the
body's `loginId` (2026-10-12: this route used to fall through to the IP bucket only,
since `accountTracker` didn't recognize `loginId`). The email goes in a POST body
rather than a query string so that it stays out of access logs.

In one transaction the service writes:

- `bp_codes`: the next `BP######`, `ACTIVE`, with `trade_name` as typed.
- `admin_accounts`: `role_type_code = BM`, role group `BM000001`, `join_path_code =
  SIGNUP`, `is_all_stores = true`, and the agreed versions and times of both 약관.
- `terms_agreement_logs`: two rows with `channel = SIGNUP` and the client IP.

The 약관 version recorded is the one in force at signup: `is_active`, not deleted,
`effective_date <= now`, latest first. The request carries only
`agreeTermsOfUse` / `agreePrivacy`, so it does not identify the version the user
actually read. If a version changes between the screen opening and the submit,
the newer one is recorded.

# Traps

**아이디 and 이메일 are lowercased before storage.** `admin_accounts_login_id_key` is
case-sensitive, so without normalization `Hangang01` and `hangang01` could both be
taken. 관리자 웹 login must normalize the same way, or users who typed capitals
cannot sign in. 아이디 stays unique even across withdrawn and deleted accounts.
이메일 is unique only among accounts that are not deleted and not `WITHDRAWN`, which
matches the partial index.

**BP codes are numbered under an advisory lock.**
`pg_advisory_xact_lock(hashtext('bp_codes.bp_code'))` and then `max(bp_code) + 1`.
Rows are not filtered, so a code from a deleted or withdrawn BP is never reissued.
`BP000000` is the smallest code, which makes the first customer BP `BP000001`. Without
the lock, two concurrent signups read the same max and the second fails with 500.

**A unique violation between the check and the insert becomes a 409.** On P2002 the
service runs the availability checks again to see which value was taken. That path
is only proven on real PostgreSQL. PGlite's socket server shares one session across
connections, so two concurrent transactions there are not isolated. The e2e case
`동시에 같은 아이디로 가입하면 하나만 된다` fails under PGlite with a 500 for that
reason.

**Mail does not hold up the response.** `EMAIL_SIGNUP_DONE` goes to the applicant
and `EMAIL_SIGNUP_ALERT` to every active 플랫폼 마스터 with an email. Both are sent
after commit, in the background. A failure is only logged; the screen says signup is
complete even when mail fails. The button link is `ADMIN_WEB_URL`. Its absence stops
startup, because otherwise the first signup would lose its mail silently.

**The password rule is not the 직원 앱 rule.** `validateAdminPassword` requires a
letter, a digit and one of `!@#$%^&*()-_=+[]{}?`, 8–20 characters, with no spaces.
That is the same list front's `validators.ts` uses. `validateNewPassword`
(WHALEERP-192) is a different policy, so keep the two separate.

**The signup token is not an access token.** It is `{ sub, typ: 'signup' }`, valid
for 10 minutes. `JwtAuthGuard` accepts only `typ: 'access'`, so the token cannot call
anything.

# Not built yet

- **사업자정보 인증** (국세청 진위확인, optional). The flow is: check for a duplicate
  number across BPs and stores first, then call the NTS API, then issue a 10-minute
  verification token that signup consumes once to fill `biz_*`. This waits for the
  API key. Until then `SignupDto` rejects `bizRegistrationNumber` and the other
  `biz*` fields as unknown.
- **「웨일ERP 시작하기」**, which exchanges the signup token for a login session.
  It belongs with 관리자 웹 login (admin access tokens and `admin_sessions`).
