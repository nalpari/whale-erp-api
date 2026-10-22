---
type: API
title: BP signup (관리자 웹 회원가입)
description: POST /auth/signup creates a customer BP and its BP 마스터 in one transaction, records the two required 약관 agreements, optionally stores 국세청-verified 사업자정보 from a 10-minute verification token, mails the applicant and the platform masters after commit, and returns a 10-minute signup token that is not an access token; what is deliberately left for later.
tags: [auth, signup, bp, admin, team1]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-22T02:04:33Z }
sources:
  - id: signup-service
    resource: ../../src/admin-signup/admin-signup.service.ts
    title: AdminSignupService (availability, signup transaction, BP code numbering, mails)
    last_modified: 2026-10-22T02:04:33Z
  - id: signup-controller
    resource: ../../src/admin-signup/admin-signup.controller.ts
    title: /auth/signup routes (public, throttled)
    last_modified: 2026-10-15T06:05:33Z
  - id: signup-dto
    resource: ../../src/admin-signup/dto/signup.dto.ts
    title: SignupDto (format rules shared with the front signup screen)
    last_modified: 2026-10-15T06:53:09Z
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
    title: AdminSignupModule (optional mail — does not import MailModule; imports NtsModule)
    last_modified: 2026-10-15T05:14:21Z
  - id: business-verification
    resource: ../../src/admin-signup/business-verification.service.ts
    title: BusinessVerificationService (duplicate check, NTS verify, verification token)
    last_modified: 2026-10-15T06:37:12Z
  - id: nts-business-client
    resource: ../../src/nts/nts-business.client.ts
    title: NtsBusinessClient (국세청 진위확인 validate)
    last_modified: 2026-10-15T06:37:12Z
  - id: nts-module
    resource: ../../src/nts/nts.module.ts
    title: NtsModule (NTS key optional — 503 without it; shared with stores)
    last_modified: 2026-10-15T06:05:33Z
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
| `POST /auth/signup/business-verifications` | 사업자정보 인증. `{ bizRegistrationNumber, bizCeoName, bizOpenDate }` → 200 `{ verificationToken }`; 409 for a number in use, 422 when 국세청 says it does not match, 503 when 국세청 cannot answer |

All four are `@Public()` and behind `SignupThrottlerGuard` (the auth throttler with
도입문의's 429 wording, 「잠시 후 다시 시도해 주세요」). Signing up burns scrypt, and
the availability checks tell anyone whether an id or address is registered, so all
four need the IP and account limits. 사업자정보 인증's body has no email, 아이디 or
phone, so its account axis falls back to the IP as well.

**회원가입도 도입문의와 동일하게 같은 IP 당 1시간에 5건까지만 받는다** (명세 `S-RCJXIG`, 2026-10-15). The
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

- `bp_codes`: the next `BP######`, `ACTIVE`, with `trade_name` as typed. With a
  `bizVerificationToken`, also `biz_registration_number` · `biz_ceo_name` ·
  `biz_open_date` from the token and `biz_verified_at` = signup time.
- `admin_accounts`: `role_type_code = BM`, role group `BM000001`, `join_path_code =
  SIGNUP`, `is_all_stores = true`, and the agreed versions and times of both 약관.
- `terms_agreement_logs`: two rows with `channel = SIGNUP` and the client IP.
- `code_items`: the new BP's copy of every undeleted 플랫폼제공 공통코드 group's platform
  originals (`BP000000`, not deleted, not BP전용), **whether or not the group has been
  applied to BPs** and whatever its status — inactive groups and codes are copied as they
  are, so a code the platform stopped stays one the BP cannot switch on (2026-10-22, 1팀
  요청). `manage_owner_code = PLATFORM_PROVIDED`, `created_by` · `updated_by` = the new BP
  마스터 (as [BP에 적용] records the admin who pressed it). It is the same function as
  [BP에 적용] (`copyProvidedItems` · `providedOriginals` in
  `src/code-groups/provided-code-copy.ts`); a group with no originals adds nothing. Being in
  the transaction, a failed copy leaves no BP or account behind — see
  [BP code groups](/api/bp-code-groups.md).

The 약관 version recorded is the one in force at signup: `is_active`, not deleted,
`effective_date <=` today in Korea (`kstToday()`), latest first — comparing
against the UTC date would miss a version that takes effect today between 0 and 9 KST. The request carries only
`agreeTermsOfUse` / `agreePrivacy`, so it does not identify the version the user
actually read. If a version changes between the screen opening and the submit,
the newer one is recorded.

# 사업자정보 인증 (국세청 진위확인)

Optional on the signup screen, which has only three fields: 사업자등록번호 · 대표자명 ·
개업일자. 대표자 연락처 · 이메일 · 주소 · 업태 · 종목 are not part of signup — they
belong to the BP 마스터 마이페이지 and 점포 등록/수정 (2026-10-15 사용자 확인).

`POST /auth/signup/business-verifications` runs in this order:

1. **Duplicate check first** (`PL-OCJOFP`). A number used by another customer BP
   (not the platform BP, not deleted, not `WITHDRAWN`), or by the 사업자정보 of a store
   that is 미운영 or 운영 and not deleted, is a 409 「이미 등록된 사업자등록번호입니다.」
   without saying who uses it. 국세청 is not called. The store condition is the same as
   store registration's (`StoreManagementService.isNumberTaken`): a closed store's
   number can be reused there, so signup must not block it either.
2. `NtsBusinessClient.verify` posts `{ businesses: [{ b_no, start_dt, p_nm }] }` to
   `api.odcloud.kr/api/nts-businessman/v1/validate` with a 5-second timeout.
   `valid === "01"` is a match, `"02"` a mismatch (422). Anything else — HTTP error,
   timeout, another shape, no key — is 503 and an `error` log with the cause only
   (no number, no name). 휴업 · 폐업 is not judged; only authenticity.
3. On a match, a JWT `{ typ: 'biz-verification', bizRegistrationNumber, bizCeoName,
   bizOpenDate }` valid for 10 minutes.

Signup takes `bizVerificationToken` and reads the three values **only from the
token** — the request cannot carry `biz*` fields (unknown fields are a 400). A bad,
expired or other-purpose token (`typ` `signup` / `access`) is a 400 「사업자정보
인증이 만료되었습니다. 다시 인증해 주세요.」 before the transaction. Inside the
transaction, after the BP-code advisory lock and the per-number lock store writes take
(`stores:biz:<number>`), the duplicate check runs again, so two signups racing on the same number cannot both
pass, and a signup waits for a store save in progress on that number; the loser gets the
same 409 and no BP is left behind. The other direction is not checked: the store side
counts only `store_business_profiles`, so a store may take a number a BP already
holds.

**사업자정보 진위확인은 같은 IP 당 1시간에 10건까지만 받는다** (2026-10-15). It spends
국세청's daily quota and its 409 tells whether a number is registered, so the default
(60 a minute) would let one IP sweep numbers; ten an hour still allows a few retries
after a typo. Without `TRUST_PROXY` naming 관리자 웹's server, every applicant shares
one bucket.

`NTS_SERVICE_KEY` is the 공공데이터포털 key. Either form works: a key containing `%`
is taken as already URL-encoded, otherwise it is encoded. **It is optional, like
mail** (2026-10-15): empty, the api still boots and every verification is a 503 (signup
without verification still works); in production an error is logged at boot so a
deploy that forgot it shows up in the logs instead of refusing to start. The token
carries 사업자등록번호 and 대표자명 in plain base64 — keep it out of logs and URLs. The e2e suite
overrides `NtsBusinessClient`, so it never calls 국세청.

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

- **Spending the verification token once — settled as not needed** (2026-10-15). The
  spec's 「한 번 쓰면 만료」 is met by the duplicate check: once a signup succeeds the
  number belongs to that BP, so reusing the token within its 10 minutes is a 409 (the
  in-transaction re-check under the number lock, and after a unique violation from
  another path the recheck answers the same 409). Only a BP withdrawn within those 10
  minutes would let it through, which was accepted. Manyfast `S-RCJXIG` says so.
- **마이페이지 재인증** will reuse `BusinessVerificationService` and add its own
  route. 점포 already uses the same `NtsBusinessClient` through `NtsModule`
  ([Store management](/api/stores.md)).
- **「웨일ERP 시작하기」**, which exchanges the signup token for a login session.
  It belongs with 관리자 웹 login (admin access tokens and `admin_sessions`).
  The exchange must spend the token once (record its `jti`): today it can be
  replayed for its whole 10 minutes, which is harmless only while nothing accepts it.
