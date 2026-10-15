---
type: API
title: BP signup (관리자 웹 회원가입)
description: POST /auth/signup creates a customer BP and its BP 마스터 in one transaction, records the two required 약관 agreements, mails the applicant and the platform masters after commit, and returns a 10-minute signup token that is not an access token; what is deliberately left for later.
tags: [auth, signup, bp, admin, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-15T01:49:03Z }
sources:
  - id: signup-service
    resource: ../../src/admin-signup/admin-signup.service.ts
    title: AdminSignupService (availability, signup transaction, BP code numbering, mails)
    last_modified: 2026-10-14T07:37:52Z
  - id: signup-controller
    resource: ../../src/admin-signup/admin-signup.controller.ts
    title: /auth/signup routes (public, throttled)
    last_modified: 2026-10-15T01:49:03Z
  - id: signup-dto
    resource: ../../src/admin-signup/dto/signup.dto.ts
    title: SignupDto (format rules shared with the front signup screen)
    last_modified: 2026-10-14T07:37:52Z
  - id: admin-password-policy
    resource: ../../src/admin-signup/admin-password-policy.ts
    title: 관리자 웹 password rule
    last_modified: 2026-10-12T07:05:00Z
  - id: admin-web-url
    resource: ../../src/common/admin-web-url.ts
    title: ADMIN_WEB_URL — one reader for every mail button
    last_modified: 2026-10-14T08:07:15Z
  - id: signup-module
    resource: ../../src/admin-signup/admin-signup.module.ts
    title: AdminSignupModule (optional mail — does not import MailModule)
    last_modified: 2026-10-14T06:00:44Z
---

# What it does

The specification is manyfast F-JVTPSU (screens S-RCJXIG 회원가입 and S-UUBGOD 가입
완료) and front's `docs/flow/auth-account`. One request creates a customer BP and
its BP 마스터 together; no store is created.

| Route | Purpose |
|---|---|
| `POST /auth/signup` | Sign up. 201 `{ signupToken, tradeName, loginId, email }`; 409 for a taken 아이디 or 이메일; 429 after 5 an hour from one IP |
| `POST /auth/signup/login-id-availability` | `{ loginId }` → `{ available }` |
| `POST /auth/signup/email-availability` | `{ email }` → `{ available }` |

All three are `@Public()` and behind `SignupThrottlerGuard` (the auth throttler with
도입문의's 429 wording, 「잠시 후 다시 시도해 주세요」). Signing up burns scrypt, and
the availability checks tell anyone whether an id or address is registered, so all
three need the IP and account limits.

**Signing up is 5 an hour per IP — the same policy as 도입문의** (2026-10-15). The
spec (`F-JVTPSU`, `S-RCJXIG`) sets no limit and there is no shared rate-limit
policy, so this follows the nearest public form, `POST /leads`. The default (60 a
minute) was a merge blocker on api #37: each signup sends 1 + (active 플랫폼 마스터)
mails, so one IP cycling e-mails could use up the shared mail account's daily quota
and stop every other mail (PIN, reset link, 문의 답변) for the day. The two
availability checks keep the default — they run every time a field loses focus.
The limit is per visitor only if the caller's address reaches the API: 관리자 웹's
server action forwards `X-Forwarded-For` and `TRUST_PROXY` must name that server,
otherwise every applicant shares one bucket and the sixth signup in an hour fails. The account axis (`accountTracker`) keys on
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
`effective_date <=` today in Korea (`kstToday()`), latest first — comparing
against the UTC date would miss a version that takes effect today between 0 and 9 KST. The request carries only
`agreeTermsOfUse` / `agreePrivacy`, so it does not identify the version the user
actually read. If a version changes between the screen opening and the submit,
the newer one is recorded.

# Traps

**아이디 and 이메일 are lowercased before storage** — by the DTO and again at the top
of `signup()`, so a direct caller cannot store capitals either (an upper-case 이메일
would trip `admin_accounts_email_lower` and surface as a 500). Signup alone therefore
never creates two 아이디 that differ only in case. 아이디 stays unique even across
withdrawn and deleted accounts.

**The 아이디 check ignores case, because 플랫폼 관리자 registration does not
lowercase.** `platform-admins` stores the 아이디 as typed (`SeoJun01`), while signup
stores lowercase. A case-sensitive check would hand out `seojun01` next to
`SeoJun01`, and the unique index would let it in. So `isLoginIdAvailable` compares
with `mode: 'insensitive'` (2026-10-14 review). That check is the only guard: two
signups racing on case variants of a 플랫폼 관리자 아이디 are not blocked by the index.
The rule is still split — 플랫폼 관리자 registration keeps capitals and checks
case-sensitively — and settling it (lowercase both, or a `lower(login_id)` unique
index) is 1팀's call.

**관리자 웹 login matches the 아이디 exactly, capitals included** ([Admin
authentication](/api/admin-auth.md), 1팀). So someone who typed `HanGang01` at signup
is stored as `hangang01` and must sign in with `hangang01`; `HanGang01` answers
like an unknown 아이디. The 가입 완료 screen shows the `loginId` from the response —
the stored, lowercase one — which is the only place the applicant learns that.
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
complete even when mail fails. The button link is `ADMIN_WEB_URL`.

A failed mail is logged at `error`, like 문의 답변: `signup mail FAILED
adminAccountId=… error=… code=…`. An SMTP failure (it carries `code` or
`responseCode`) logs no message, because the server's reply can quote the address;
`MailService` already logged it masked and wrote `mail_send_logs`. A failure before
SMTP — template missing or switched off, a variable or link the template rejects —
reaches neither of those, so its message is logged too; it holds only the template
code, variable names and a masked address. Without that, an operator switching off
`EMAIL_SIGNUP_DONE` would silence every signup mail with nothing to trace. With no
active 플랫폼 마스터 to alert, `signup alert SKIPPED` is logged instead of nothing.

If signing the signup token fails after the commit (practically never), the
account and mail already exist but the caller sees a 500, and retrying gets the 409
for its own 아이디 — the account is fine; the 가입 완료 screen is what was lost.

**Mail settings are optional.** `AdminSignupModule` does not import `MailModule`; it
takes `optionalMailServiceProvider` like 문의 답변 does, and reads `ADMIN_WEB_URL`
through `src/common/admin-web-url.ts`. With `MAIL_*` or `ADMIN_WEB_URL` empty the
api still boots and signup still succeeds — only the two mails are skipped, with a
`signup mail SKIPPED` warning per signup, and in production an error at boot. A
malformed `ADMIN_WEB_URL` (not http(s), or not https in production) still stops
the boot. Until 2026-10-14 the module imported `MailModule`, which made every
environment — every e2e suite and `openapi:export` included — need the mail keys.

**The 아이디 · 이메일 rules are written out three times, on purpose.** `SignupDto` and
the two availability DTOs each carry the literal pattern, because the Swagger plugin
copies only a regex written in the decorator into the schema — a shared constant or a
composed decorator drops `pattern` / `format` from `openapi/openapi.json`, and with
it from front's generated types. `availability.dto.spec.ts` runs the same inputs
through both sides so they cannot drift. The two 필수 약관 flags are `@Equals(true)`,
so a `false` is a 400 at the DTO.

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
  The exchange must spend the token once (record its `jti`): today it can be
  replayed for its whole 10 minutes, which is harmless only while nothing accepts it.
