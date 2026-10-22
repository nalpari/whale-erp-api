---
type: API
title: Admin authentication
description: 관리자 웹 login (1팀 admin_accounts) — login · refresh · logout over admin_sessions, temporary-password login, 아이디 찾기 (masked login id), GET /auth/admin/login-info for the screen, the per-request menu-permission guard, the public 공통코드 API (platform BP only), and a platform user's stores and 공통코드 of a picked BP.
tags: [auth, jwt, security, session, admin, codes]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-22T05:40:00Z }
sources:
  - id: access-messages
    resource: ../../src/auth/access-messages.ts
    title: 관리자 403 문구 네 가지
    last_modified: 2026-10-21T09:08:15Z
  - id: menu-permission-urls-spec
    resource: ../../src/auth/menu-permission-urls.spec.ts
    title: 컨트롤러 경로 ↔ 메뉴 URL 대응표(22개)
    last_modified: 2026-10-21T08:37:49Z
  - id: admin-auth-service
    resource: ../../src/auth/admin-auth.service.ts
    title: 관리자 웹 login · refresh · logout · signup-session
    last_modified: 2026-10-16T00:00:00Z
  - id: password
    resource: ../../src/auth/password.ts
    title: verifyPassword — scrypt 형식이 아닌 저장값('!')도 더미 해시로 한 번 대조
    last_modified: 2026-10-22T04:31:00Z
  - id: admin-auth-controller
    resource: ../../src/auth/admin-auth.controller.ts
    title: POST /auth/admin/login · refresh · logout · signup-session · login-id-find-attempts, GET /auth/admin/login-info · me · me/email-availability, PATCH /auth/admin/me
    last_modified: 2026-10-21T17:10:00Z
  - id: admin-profile-service
    resource: ../../src/auth/admin-profile.service.ts
    title: MY PAGE 내 정보(F-AMTDCK > S-JXKHCM) — get · update(동시 수정 검사 · 이메일 변경 시 지금 비밀번호 확인 · 임시 비밀번호 무효화) · checkEmailAvailable, 로그인한 관리자 자신만
    last_modified: 2026-10-21T17:10:00Z
  - id: admin-login-id-find-service
    resource: ../../src/auth/admin-login-id-find.service.ts
    title: POST /auth/admin/login-id-find-attempts — 아이디 찾기(가린 아이디)
    last_modified: 2026-10-19T00:00:00Z
  - id: admin-session-service
    resource: ../../src/admin-session/admin-session.service.ts
    title: admin_sessions (issue · find · extend · isActive · revoke)
    last_modified: 2026-10-14T05:00:00Z
  - id: admin-login-info-service
    resource: ../../src/auth/admin-login-info.service.ts
    title: Login info — account, menu tree with CRUD, managed stores, codes
    last_modified: 2026-10-14T05:00:00Z
  - id: menu-permission-guard
    resource: ../../src/auth/menu-permission.guard.ts
    title: '@MenuPermission(action | action[], { platformOnly }) — menu by the controller path, per-request check, target BP (X-Bp-Code-Id → @TargetBp())'
    last_modified: 2026-10-22T00:37:16Z
  - id: codes-service
    resource: ../../src/codes/codes.service.ts
    title: 공통코드 per BP, for login-info, GET /public-code-items and GET /bp-codes/{bpCodeId}/code-items
    last_modified: 2026-10-14T07:51:25Z
  - id: admin-temporary-password-service
    resource: ../../src/auth/admin-temporary-password.service.ts
    title: POST /auth/admin/temporary-passwords — 비밀번호 찾기 임시 비밀번호
    last_modified: 2026-10-20T05:00:00Z
  - id: admin-password-change-service
    resource: ../../src/auth/admin-password-change.service.ts
    title: POST /auth/admin/password-change — 강제 비밀번호 변경 + 약관 동의
    last_modified: 2026-10-19T05:00:00Z
  - id: admin-password-policy
    resource: ../../src/auth/admin-password-policy.ts
    title: 1팀 비밀번호 정책(PL-QSBSYY) 검사와 문구
    last_modified: 2026-10-14T05:00:00Z
  - id: bp-codes-controller
    resource: ../../src/bp-codes/bp-codes.controller.ts
    title: GET /bp-codes · /bp-codes/{bpCodeId}/stores · code-items — 플랫폼 사용자의 BP 선택과 진입
    last_modified: 2026-10-21T09:00:00Z
---

# Routes

| Route | Public | Does |
|---|---|---|
| `POST /auth/admin/login` | yes | `{ loginId, password, deviceInformation? }` → `{ accessToken, refreshToken, refreshTokenExpiresAt, account }` — the 직원 앱 shape; `account.bp` carries `bpCodeId` |
| `POST /auth/admin/refresh` | yes | refresh token → new access token and the session's new expiry |
| `POST /auth/admin/signup-session` | yes | `{ signupToken, deviceInformation? }` → the same shape as `login`. Trades the 10-minute `signupToken` the front signup flow receives for a real session, with no password |
| `POST /auth/admin/logout` | admin | ends this browser's session only |
| `POST /auth/admin/temporary-passwords` | yes | `{ name, loginId, email }` → 202 once a 1-hour temporary password is mailed; no match 404 (아이디 찾기's wording), mail not sent 503 `TEMPORARY_PASSWORD_SEND_FAILED` |
| `POST /auth/admin/login-id-find-attempts` | yes | `{ name, email }` → `{ maskedLoginId }` for an active match, else the same 404 |
| `POST /auth/admin/password-change` | admin | `{ newPassword, newPasswordConfirm, isTermsAgreed? }` → 204. 강제 변경 — no current password asked |
| `GET /auth/admin/login-info` | admin | `{ account, menus, stores, codes }` as of the call |
| `GET /auth/admin/me` | admin | MY PAGE(S-JXKHCM) — `{ loginId, name, phone, email, roleTypeCode, createdAt, lastLoginAt }` for the signed-in admin's own account only (`CurrentUser().id`, never a BP/customer context) |
| `PATCH /auth/admin/me` | admin | `{ name, phone, email, updatedAt, currentPassword? }` → 204. If `email` changed, `currentPassword` is required and checked first (`BadRequestException` before the email-uniqueness check, so a token-only caller can't use this route to probe which emails are taken) — otherwise a stolen access token alone could change the login email to an attacker address and intercept a mailed temp-password via `POST /auth/admin/temporary-passwords` (ip-code-review-claude adversarial review, 2026-10-21; same control as my-profile(직원 앱)'s email-change). `updatedAt` is the optimistic-lock token from `GET /me` — `updateMany` with `sameMillisecond(updatedAt)`, 409 if another admin (e.g. via platform-admins) saved first (same review round — the original diff had no concurrency check and silently overwrote concurrent edits). Re-checks email uniqueness (excluding `WITHDRAWN`) inside the same transaction, 409 on conflict; if email changed, invalidates any unused `temporary_passwords` for the account (an account-takeover path via the mailed temp-password flow otherwise survives an email change) and re-arms `isInitialPasswordUnsent` if any were invalidated; logs changed fields to `admin_change_histories` with `updatedBy` set to the signed-in admin. Account axis throttled on the signed-in user, not the request's own `email` field (the default account tracker keys on `body.email`, which this route's caller controls) |
| `GET /auth/admin/me/email-availability?email=` | admin | `{ available }` for MY PAGE's blur/Enter check — DTO-validated (400 on missing/malformed `email`, fixed from a prior 500). No `@SkipThrottle` (아이디 · 이메일 중복 확인은 기본 한도를 둔다는 결정, api #37 과 같다) |
| `GET /public-code-items?groups=A,B` | yes | the platform BP's 공통코드 — only the named groups when `groups` is given — `{ codes: { GROUP: [{ value, label, order }] } }` |
| `GET /bp-codes?keyword=&page=&pageSize=` | PM · PA only | customer BPs to pick from, `{ items: [{ bpCodeId, bpCode, tradeName, accountStatusCode }], total }` (below) |
| `GET /bp-codes/{bpCodeId}/stores` | any signed-in user, by BP | every undeleted store of a customer BP, `{ items, total }`. PM · PA see any customer BP; everyone else only their own (below) |
| `GET /bp-codes/{bpCodeId}/code-items?groups=A,B` | any signed-in user, by BP | the same `codes` for a BP the caller may see — PM · PA any undeleted BP (the platform BP included); BP · 가맹 관리자 their own; 직원 앱 a BP with a joined, employed staff record; else 404 (below) |

Access tokens last 1 hour and carry `type: 'admin'`, `loginId` and `sid`; the
refresh token lasts 1 hour after its last use and is not rotated (front okf
`auth.md`, `S-QCNVFC`). On a fresh database the platform master signs in for the first time through
`temporary-passwords` — the mail goes to the address in the migration.

# Login order and what each rejection looks like

Lock → id · password → account status → forced change (front `auth.md`).

- Unknown id, wrong password, wrong temporary password, 탈퇴 and deleted
  accounts all answer **the same 401 message**, and every attempt runs scrypt
  **twice** — once against the account's password, once against its live
  temporary password or a dummy. Running it once when there is no temporary
  password would let response time tell whether one was issued.
  A stored value that is not a scrypt hash (`'!'`, an account waiting for its
  initial or reset password) costs a derivation too. Until WHALEERP-392
  (2026-10-22) `verifyPassword` returned false at once, so such an account ran
  scrypt once instead of twice and showed that the id exists — "twice" was not
  true for it before then.
- Five wrong attempts lock for five minutes (429), counted under
  `SELECT … FOR UPDATE` on the `admin_accounts` row, as in the 직원 앱 login.
  While locked the password is not even checked, and the attempt is not counted.
  **The lock tells that the id exists, and that is accepted** (WHALEERP-392,
  2026-10-22): an unknown, 탈퇴 or deleted id never reaches 429, so five wrong attempts
  are enough to tell. Locking unknown ids too would need a per-login-id counter
  with no row to lock; the IP and login-id rate limits slow the probing instead.
- 미사용 is told (403) only when the password was right.
- Success re-reads the row under the lock and refuses if, meanwhile, the
  account was locked, deactivated, withdrawn, its password changed or the
  temporary password invalidated — the user typed a correct value, so these do
  not count as failures.
- `admin_login_logs` keeps every attempt with the client IP. An unknown id has
  no account to point at and is logged as `PASSWORD_MISMATCH` with a null id.

# Signup auto-login (「웨일ERP 시작하기」)

`POST /auth/admin/signup-session` is the front signup-done screen's 「웨일ERP
시작하기」 button. `AdminSignupService.signup` ends a successful sign-up by
signing a JWT (`typ: 'signup'`, 10 minutes, `signup.response.dto.ts`'s
`signupToken`) instead of a session; this route redeems it so the just-signed-up
admin does not retype a password they chose seconds ago.

- The token is verified like any JWT (signature, expiry) and its `typ` must be
  `'signup'` — an access or refresh token, or anything malformed, is 401 with
  the same generic message as a bad login (`INVALID_SIGNUP_TOKEN_MESSAGE`), so
  the front cannot distinguish "expired" from "forged" from "wrong token kind".
- The account must still exist and not be deleted or 탈퇴 (401, same message —
  the token outlived the account). An existing but 미사용 account is 403, the
  same `INACTIVE_MESSAGE` as a login attempt.
- On success it issues a session exactly like `login`'s success path
  (`AdminSessionService.issue`, same response shape, `account.isPasswordChangeRequired`
  read as-is — signup never sets it) and writes one `admin_login_logs` row with
  no failure reason. There is no password check, no lock counter and no scrypt
  call: the signup flow already proved the password once, and spending another
  round-trip here would only slow down a screen whose whole point is skipping one.
- The front treats both 401 and 403 the same way — back to `/login` — since by
  the time this call can fail, the signup itself already succeeded; there is no
  form left on screen to show the error in.

# Issuing a temporary password

`POST /auth/admin/temporary-passwords` is 비밀번호 찾기 (front okf `auth.md`,
「계정 찾기」), ported from a parallel implementation on `squirtle`:

- Name, login id and e-mail must all match an active, undeleted account (the
  name trimmed and NFC-normalized, the same rule as 아이디 찾기 on the same screen —
  otherwise a padded name matched one form and silently missed the other). No
  match — including a match only with an unused, withdrawn or deleted account —
  is a **404** with 아이디 찾기's message 「입력하신 정보와 일치하는 계정을 찾을 수
  없습니다.」. Five per account per hour (429, Korean message); the route also
  takes 아이디 찾기's request limit, 30 a minute per IP and 10 per 10 minutes
  per e-mail.
- Until 2026-10-20 a mismatch and a failed mail both answered the same 202, so
  the response would not tell a guesser that name, id and e-mail matched (PR #30
  review). The front asked for 404 and 503 instead (the spec's 「일치하는 계정을
  찾을 수 없습니다」 · 「보내지 못했습니다」 screens), and that reasoning no longer
  held: 아이디 찾기 already confirms a name and e-mail pair, which leaves only the
  login id to the triple, and the IP limit now slows the guessing.
- The mail is sent **before** anything is stored. If Gmail fails — or no
  sender is configured — nothing is stored and the answer is **503** with
  `code: TEMPORARY_PASSWORD_SEND_FAILED`. Never `Cannot …` — the front reads a message starting that way
  as an api not yet deployed.
- **Only an SMTP failure is that 503.** A failure before SMTP — the template
  missing or switched off by an operator, a stored address `MailService`
  rejects, the database — is rethrown as a 500 with an `error` log, because
  retrying cannot fix it and 「잠시 후 다시」 would have every admin retry forever.
  `MailService` marks what it rethrows from the SMTP step
  (`isMailTransportError`) and has already logged the masked reason; this route
  logs only the account id, never the SMTP text, which can carry addresses.
  A missing sender is logged at `error` too.
- A timeout is not proof that nothing went out: Gmail may have accepted the mail
  before the connection dropped. Then the user is told 503 and later receives a
  password that was never stored; asking again issues a working one. The api
  cannot tell this from a mail that really failed, so **the screen does not say
  「보내지 못했습니다」** for this 503: it says that if no mail arrives within a
  few minutes, ask again (2026-10-20). Storing before sending would make every
  mailed password valid, but a mail that never left would then leave a live
  password nobody received — the reason PR #30 stores only after sending.
- After the mail, under the account row lock, the account is **read again with
  the same conditions**. If its e-mail, name, status or deletion changed while
  SMTP ran (up to tens of seconds), nothing is stored — otherwise a password
  mailed to an old address would live for an hour (the race PR #29's review
  caught for 플랫폼 관리자 resets). The answer is still 202, since the mail has
  gone; the value in it is unusable.
- Then every live 찾기 (`TEMPORARY`) password is invalidated (used ones too,
  since they stay usable until expiry), the new one is stored for one hour and
  the login lock is cleared. An initial or reset password an administrator
  issued (`INITIAL` · `RESET`) is left alone: this route is public, and ending
  it would turn that account's forced-change session into 401. Login only
  accepts the latest temporary password, so it no longer signs in anyway.
- **Issuing does not set `is_password_change_required`.** The route is public,
  so setting the flag here let anyone who knows a name, login id and e-mail
  turn every live session of a signed-in admin into 403 (PR #30 review). The
  flag is set by the login that actually uses a temporary password; that is
  what raises the forced-change popup and caps the session at its expiry.
- The own password is left alone — `password_hash` is not replaced with `'!'`
  for 찾기, so someone who remembers it can still use it.
- `mail_send_logs` keeps the body with `#{임시비밀번호}` masked.
- The button links to `ADMIN_WEB_URL` + `/login`.

The api boots without `MAIL_*` or `ADMIN_WEB_URL`: `AuthModule` gets this mail
sender (`ADMIN_MAIL`) from `createPlatformAdminMail`, the same factory as the
플랫폼 관리자 initial-password mail (api #29), instead of importing `MailModule`,
which would stop the boot. **Either one missing means no sender** — nothing is
stored and the answer is the same 503. Half the mail settings, or an
`ADMIN_WEB_URL` that is not an http(s) address, stop the boot. `MAIL_PASSWORD` is
a Gmail **app** password; the account password is refused (534-5.7.9).

# Finding a login id

`POST /auth/admin/login-id-find-attempts` is 아이디 찾기 (front okf `auth.md`
「계정 찾기」, mockup `auth/find.html`), shaped like 직원 앱's
`email-find-attempts`:

- `{ name, email }` — both trimmed, the name NFC-normalized as 비밀번호 찾기's is,
  e-mail lowercased — must match an active,
  undeleted account. Among those the e-mail is unique, so the answer is one value,
  `{ maskedLoginId }`, not a list.
- **The api masks; the full id never leaves it.** First two and last character
  stay, the rest becomes `*` at full length (`hanwhale1` → `ha******1`, the
  four-character minimum → `ab*d`, which shows three of four characters — that
  follows the requested rule, not an oversight). Nothing is mailed.
- No match, or a match only with an unused, withdrawn or deleted account, is the
  same 404 「입력하신 정보와 일치하는 계정을 찾을 수 없습니다.」, so the route does
  not tell which accounts exist.
- Rate limit is **30 a minute per IP and 10 per 10 minutes per e-mail**, with no
  consecutive-failure lock (WHALEERP-398, 2026-10-20 — this replaced the spec's
  「횟수 제한 없음」, F-FQKGEE). The IP limit shares `EMAIL_FIND_IP_LIMIT`'s value;
  the e-mail limit is the default account axis, which keys on the body's e-mail. That axis opens a new bucket for every
  e-mail typed, so guessing names across e-mails is slowed by the IP axis alone.
  Unlike e-mail find there is no 5-miss lock (`email_find_attempts` is per phone).

# Forced password change

`POST /auth/admin/password-change` is the popup of 1팀 `S-VFGQLI` for an account
signed in with an initial or temporary password (`isPasswordChangeRequired`).

- **Until it is done, the guard answers 403 「서비스 이용을 위해 비밀번호를
  변경해 주세요.」 to every admin route** except `login-info`, `logout` and this one
  (`@AllowPasswordChangePending()`). The flag rides on the session lookup the
  guard already does (`AdminSessionService.findActive`), so it costs no read.
  Skipping the popup and calling an API directly is therefore not possible.
- The rules are 1팀's `PL-QSBSYY`, not 3팀's `password-policy.ts`: letters,
  digits and one of `! @ # $ % ^ & * ( ) - _ = + [ ] { } ?` each at least once,
  8–20 characters, nothing else. Violations are 400 with **the policy's own
  sentence, one at a time in the policy's order** — combination/length → login
  id → character → current password → issued password → confirmation — so the
  screen shows `message` as is.
- An account that is 플랫폼등록 and has not agreed (`isTermsAgreementRequired`)
  must send `isTermsAgreed: true`, or nothing is saved (400). The versions of
  `TERMS_SERVICE` and `PRIVACY_COLLECT` in force are recorded as
  `FIRST_LOGIN` agreements and on the account, in the same transaction as the
  password — picked by the same rule as signup and the
  [public 약관 API](/api/terms-versions.md): active, not deleted, 시행일 by
  **KST** today, latest first. Until 2026-10-19 this path skipped the 시행일, so a
  version registered ahead of its date would have been agreed to early.
- On success, under the account row lock: new hash, flag off, every temporary
  password invalidated, `admin_change_histories` gets 「비밀번호 · 강제 변경」
  (no value), and **every live session of the account is stretched to one hour
  from now** — the ones capped at the temporary password's expiry would
  otherwise die with it, and the spec keeps all devices signed in.
- Not the target (flag off) is 409. If the password the session signed in with
  is gone — expired, ended by a re-issue, or never there because an
  administrator reset the account while it was signed in — the answer is 401
  「로그인한 비밀번호가 더 이상 유효하지 않습니다. 다시 로그인해 주세요.」 and the
  user signs in again with the password just mailed.

The temporary-password generator was tightened at the same time: the policy
asks for an upper- **and** a lower-case letter, which a mixed-case pool alone
did not guarantee.

# Temporary passwords live only in `temporary_passwords`

Login accepts the account's own password **or** the latest live temporary
password (not invalidated, not deleted, not expired), whatever its purpose.
The model the issuing code must follow: a temporary password is never written
into `admin_accounts.password_hash`; where the old password must die (초기화),
the issuer replaces that hash with `'!'`.

- A temporary password may be used again until it expires — `used_at` records
  the first use only. Burning it on first use would strand a user who closed the
  tab before the forced change.
- A session opened with one ends at that temporary password's expiry, and
  `refresh` will not push past it while the account still has the forced-change
  flag. The cap is recomputed from `temporary_passwords`; `admin_sessions` has
  no column for it.
- **A forced-change session with no live temporary password ends at `refresh`.**
  The two cases above (a re-issue, or a reset while signed in) leave the flag on
  with nothing to change against: every route is 403 and `password-change` 401.
  Extending such a session would keep it alive forever, so `refresh` revokes it
  and answers 401 instead, which sends 관리자 웹 to the login screen (PR #30
  review).
- Signing in with a temporary password sets the forced-change flag. Signing in
  with the own password invalidates unused 찾기 (`TEMPORARY`) passwords and
  clears the flag — set, perhaps, by a temporary-password sign-in in another
  browser. Accounts registered or reset by an administrator keep it: their
  password is `'!'`, so they cannot sign in with an own password.

# Sessions: the refresh token names its row

`admin_sessions.refresh_token_hash` has no index, so the refresh token is
`<sessionId>.<random>` and lookup is by primary key, then a constant-time hash
comparison. The access token is signed after the row exists (it carries the
id), and both hashes are written in the same transaction.

The guard checks `admin_sessions` on every request — not revoked, not deleted,
not expired, owned by the token's subject — but **not the account status**:
미사용 · 삭제 · 탈퇴 do not cut a signed-in session; `refresh` refuses them, so
the session ends within the hour (front `auth.md`, 2026-10-07).

# Screen info is fetched once; permission is checked every time

Policy (front `auth.md` · `system.md` `PL-AMTMVC`, 2026-10-13): 관리자 웹 calls
`login-info` right after login and draws menus, buttons and the store selector
from it; changed roles, menus or store mappings reach the screen at the next
login. The API does not snapshot anything — `login-info` returns current values,
and "next login" holds only because the web calls it once.

Business routes instead check **current** values on every request:
`@MenuPermission('update')` adds `@UserTypes('admin')` and a guard
that reads the caller's role group from the database, and store scope stays
with `AdminScopeService.canManageStore`. A screen may therefore still show a
button its user has lost; the 403 is the access message below. The guard denies
when it finds no menu marker, a marker with an empty action list or a value that
is not one of the four actions (`isMenuAction`, derived from the guard's own
column map), or a marker that has a `menuCode` key with an empty or `undefined`
value — that one does not fall through to the path, which would judge it by
another menu. A restriction-shaped guard must not open up when used wrong.

## The menu is found by the controller path

Since 2026-10-21 (1팀 결정) the marker names no menu. The guard takes the first
segment of the controller's `@Controller` path and looks for the active,
undeleted menu whose `menus.url` is `'/' + segment` — `@Controller('stores')`
is judged by the menu at `/stores`, in the same single `role_group_menus` read (a `findFirst`
that also returns the menu's `serviceCode`, used for the target BP below).
This rests on the policy that a 관리자 웹 screen address and its API resource are
the same one-segment path (`/stores` screen ↔ `/stores` API ↔ menu url `/stores`).
It reads the path from the controller metadata, not `req.url`, which a query
string, a trailing slash or a global prefix would shift. A controller with no
path, an empty or `/` path (`@Controller()`), or an array of paths is 403 — a
guard that cannot name its menu does not fall back to "any menu". **That 403 comes
per request, not at boot**: the decorator cannot know which controller it will sit
on, so a path-form marker on a pathless controller boots fine and denies everyone.

When the guard denies for lack of a permission row, it asks once more whether an
active menu with that URL (or code) exists at all, and if none does it logs an
error naming the controller and the URL or code — a missing menu is a broken
setting, not a missing right. The response stays the same 403, the extra query
happens only on the deny path, and a failure of that query is logged rather than
turned into a 500.

Three things follow, and they are the trap:

- **The menu URL is the permission key.** Changing a menu's URL would change
  which right opens that API at once — another menu's right (moving 공지사항's URL
  to `/platform-admins` would open 플랫폼 관리자 to 공지사항 rights, an escalation),
  or nobody's (moving MN000215's URL makes `/platform-menus` 403 for everyone,
  recoverable only in the database). So 메뉴 관리's 수정 right would in effect be
  the right to grant rights. Since 2026-10-21 (사용자 결정) URLs bound to an API
  path are fixed: [platform menus](/api/platform-menus.md) refuses (409) to change
  such a menu's URL or to let another menu take it. The 409 platform menus already
  had for overlapping URLs now also keeps the permission key unique, with a partial
  unique index (`menus_url_active_key`) behind it. Moving an address means changing
  the controller path and the menu URL together, in a migration.
- **Every sub-path belongs to the first segment's menu.** `/stores/:id/image`
  and `/staff-members/:id/password-reset-links` are judged by `/stores` and
  `/staff-members`; a controller cannot split one path between two menus.
- **A route that must be judged by another menu names it.**
  `@MenuPermission('MN000010', 'update')` — the old form, kept as the exception —
  checks `menu_code` instead of the path, with the same boot-time checks (`MN` + 6
  digits, no empty action list, every element an action). Kept for exceptions by
  1팀's decision; no route uses it today. The first argument decides the form: an action
  (`read` · `create` · `update` · `delete`) or an action array is the path form,
  anything else is a menu code.

All `@MenuPermission` routes, 1팀's and 3팀's (점포 · 플랫폼 관리자 · 권한 · 메뉴 ·
공통코드, 직원 정보 · 퇴직 · 재설정 링크 · 직원 TO-DO, TO-DO, 문의하기 · 커뮤니티
문의사항 · 도입문의, 공지사항 · FAQ 관리와 고객지원) moved to the path form the same
day, each after checking that its controller path's first segment is its menu's
URL; no route uses a menu code now. `src/auth/menu-permission-urls.spec.ts` pins
that table — each of the 22 controller classes (근로계약 · 재발송 joined on 2026-10-21,
WHALEERP-592; 직원 상세 요약 the same day, WHALEERP-183) against the `menus.url` its
migration set — so renaming a controller path fails a unit test instead of
silently moving the API to another menu.

Two options cover what used to need a check inside the handler (2026-10-20, 1팀
결정 — 1팀's menu-permission screens (점포 · 플랫폼 관리자 · 권한 · 메뉴 · 공통코드) now
use the guard, as 고객지원 문의하기 (`/support-inquiries`, MN000036) · 직원 정보 ·
TO-DO already did; 커뮤니티 문의사항 · 도입문의 (`/platform-inquiries` ·
`/platform-leads`) use the path form too — see [inquiries](/api/inquiries.md)):

- **An action array is OR.** `@MenuPermission(['create', 'update'])`
  passes with either right — for a route that the 등록 and 수정 screens share
  (점포 사업자 진위확인).
- **`{ platformOnly: true }`** adds, after the menu right, "an active PM or PA
  **of the platform BP**" (`isPlatformRole` in `admin-scope.service.ts`, the same
  rule `AdminScopeService.isPlatformAdmin` uses). A menu row wrongly attached to a
  BP-side role group, or a PM · PA role wrongly given to a customer-BP account,
  then still cannot open a platform screen (플랫폼 관리자 · 권한 · 메뉴 ·
  공통코드).

The order is the old in-handler one: account unusable (ACCOUNT_UNAVAILABLE) →
menu right (ACCESS_DENIED) → platform account (ACCESS_DENIED) → target BP (below).
The marker is stored exactly as written — `{ action, platformOnly? }` for the path
form, `{ menuCode, action, platformOnly? }` for a named menu.

## The target BP comes from `X-Bp-Code-Id`

관리자 웹 puts a tab's BP in its address (`/bp/{bpCodeId}/...`) and sends it as
`X-Bp-Code-Id` (front 「탭 BP 경로 방식 전환 계획」 2단계, 1팀 결정 2026-10-21). The guard
judges it — there is no separate guard, so one `@MenuPermission` cannot be half
forgotten — and only when the judged menu's `serviceCode` is `WHALE_ERP`; a
`PLATFORM` menu ignores the header. The account row the guard already reads adds
`bpCodeId`, so no extra query except the platform caller's BP lookup.

| Caller | No header | Own BP | Another customer BP | Missing · deleted · platform BP · malformed |
|---|---|---|---|---|
| PM · PA of the platform BP | platform BP | — | that BP | 404 「BP 를 찾을 수 없습니다」 |
| BM · BA · FM · FA | own BP | own BP | 403 「다른 BP 의 정보는 다룰 수 없습니다.」 | 403 (same) |

The own BP is `admin_accounts.bp_code_id` from the database, never a query, body
or cookie value. **No header means the own BP for everyone** during the move —
screens not yet moved send none; making it required (400) is a later step. The
menu right is judged first, so a caller without it cannot probe which BP ids exist.

The result is `request.bp = { bpCodeId, isPlatformCaller }`, read with the
`@TargetBp()` parameter decorator (same file). It is kept out of `request.user`:
the user is "who" on every signed-in route, the target BP is "which BP" on ERP
menu routes only. **`@TargetBp()` on a route where the guard set no BP — a
`PLATFORM` menu, or no `@MenuPermission` — is a 500**, so a missing guard shows up
in development instead of quietly falling back to the own BP. `@MenuPermission`
also adds `@ApiHeader({ name: 'X-Bp-Code-Id', required: false })`, so every
guarded route shows the header in `openapi.json`, platform ones included (the
decorator cannot know the menu's service).

Pass the BP to services as an argument. [BP role groups](/api/bp-role-groups.md) and
[store management](/api/stores.md) (2026-10-22) use `@TargetBp()` so far — both answer a
platform account without the header with a 400; 직원 · TO-DO · 근로계약 move when their
screens do.
**`AdminScopeService` still reads the own BP** — each module that moves adds the
target BP to the scope checks it calls, in its own change (decided 2026-10-21: no
unused argument ahead of its first caller). 1팀's decision for that step: a platform
account given a customer BP manages all of that BP's stores (it reads and writes by
its menu rights, WHALEERP-301's BP-level scope), and a BP or 가맹 account given another
BP manages none. **Decide with it:** `hidesPersonalData` hides franchise staff without
HQ consent from BM · BA only, not from PM · PA.

**A guard runs before pipes and the handler**, so a caller without the right —
or a non-platform caller on a platform screen — now gets 403 even for a
malformed body or query (400) or an id outside `1..2147483647` (404). A missing
row or a store out of scope was already 403 for them — the service that answers
that 404 ran after the old in-handler check too. Callers who
do have the right see the same responses as before. A service that still needs
the caller's role type or role group (master protection, self protection) reads
it with `MenuPermissionsService.caller(adminAccountId)`, which checks nothing but
"still an active account" and answers ACCOUNT_UNAVAILABLE if the account stopped
between the guard and that read. `caller` is all that service has left —
`MenuPermissionsService.assert`, which judged a menu right inside the handler, was
removed on 2026-10-21 once nothing called it. The posts controller (고객지원 공지사항 · FAQ, [posts](/api/posts.md)) was
the last: its list and detail picked the menu by the query or the post until the
paths were split per menu (2026-10-20). 공통코드 was the other case — its panel save added
a `create` check when the body carried new codes — until create and update became
separate routes (2026-10-20), so it now uses the guard alone
([whale-erp-api](/api/whale-erp-api.md)).

# 403 messages

Three sentences only, one per situation (재영, 2026-10-14), plus one for an area
of a screen (below). They live in
`src/auth/access-messages.ts`, and 관리자 웹 branches on them, so **a new 403 for
one of these situations uses the constant, never its own wording** — and a change
of wording is announced to front.

| Situation | `message` | 관리자 웹 |
|---|---|---|
| Forced password change not done (guard) | 「서비스 이용을 위해 비밀번호를 변경해 주세요.」 | reopen the change popup |
| No menu permission (`@MenuPermission`), a platform-only screen called by a non-platform account (`@MenuPermission(…, { platformOnly: true })`, other `isPlatformAdmin` callers), a token of the wrong kind (`@UserTypes`) | 「접근 권한이 없습니다. 관리자에게 문의해 주세요.」 | show it, go back (`history.back()`, home if none) |
| Deleted, 미사용 or 탈퇴 account still holding a live session | 「사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.」 | show it, go back |
| One area of a screen that shows another menu's data — 직원 상세 요약's 근로계약 · 근무스케줄 · 급여명세서 · TO-DO (`READ_DENIED_MESSAGE`, WHALEERP-183) — without that menu's read | 「조회 권한이 없습니다.」 | show it in that area only; the rest of the screen stays |

The fourth exists because the screen does not leave: the guard already let the
caller into 직원 정보 관리, and only one area is missing, so the 「go back」 sentence
would be wrong there (2026-10-21 노영주; 재영 confirmed it as the fourth sentence the
same day, 3팀 buzz — announced to front with the 직원 상세 work).

Situation-specific 403s stay as they are (본인 계정 삭제, 플랫폼 마스터 부여 and
the like in 플랫폼 관리자); they explain a rule, not a missing right. Login's
own 403 for 미사용 is unchanged too — it answers a sign-in, not a session.

Front tells the 403s apart by `message`. A machine-readable code was considered
and not taken: the naming rule keeps Nest's `{ statusCode, message, error }`.

What `login-info` contains:

- **menus** — active menus of active services (`SERVICE` codes), readable by
  the account's role group, as a tree of at most three levels. A parent the user
  cannot read is included only as the way to a readable child, with every
  permission false. A child of an inactive parent disappears with it. Each
  node carries its `serviceCode` (공통코드 `SERVICE`), so the screen can group
  or switch menus by service (front 요청, 2026-10-14).
- **stores** — `AdminScopeService.listStores`, the same rule as
  `canManageStore`. Platform accounts get `[]`: they pick a BP instead, and their
  reach into customer BPs is WHALEERP-301.
- **codes** — every active group for the account's BP (next section).
- **account** — includes `isPasswordChangeRequired`,
  `temporaryPasswordExpiresAt`, and `isTermsAgreementRequired` (플랫폼등록 and
  no agreement yet) for the forced-change popup.

# Which BP's 공통코드 rows

Rows are stored per BP. A 플랫폼제공 group that has been applied to BPs was
copied into every BP, and from then on the BP sees **its own** rows (renamed
labels, BP전용 additions). 플랫폼고정 groups and not-yet-applied 플랫폼제공
groups are read from the platform originals (`BP000000`). Inactive or deleted
groups and items are left out; order is `sort_order`, then code.

Three ways in, by who is asking (재영, 2026-10-13):

- **Before login** — `GET /public-code-items`, with **no BP at all**: the server
  always reads the platform BP (`BP000000`) (재영, 2026-10-14). It replaced
  `GET /public-bp-codes/{bpCode}/code-items`, whose callers all passed
  `BP000000` anyway, and which let anyone read any BP's codes without signing in
  (below). Before that it was `GET /code-items?bpCode=`, and before that
  `GET /code-items/platform-fixed`.
- **The account's own BP** — `login-info.codes`; no call after login.
- **Any BP the caller may see, after login** — `GET /bp-codes/{bpCodeId}/code-items`,
  by id like everything after login, with the stores route's rule
  (`AdminScopeService.bpStoresAccess`, 2026-10-21 — before that any signed-in
  user read any BP's BP전용 codes by walking ids): PM · PA any BP, BP · 가맹
  관리자 their own, a 직원 앱 token a BP where it has a joined, employed staff
  record. Any other BP — the platform BP included for a BP 관리자, who reads the
  platform codes through the public route — is 404 like a missing one; an admin
  account not in use is 403. A withdrawn BP still answers.

`groups` is optional on both routes: a comma list (or repeated parameter) of group codes, at
most 50, each in the `code_groups` format. Given, only those groups come back,
and a group that does not exist or is not in use comes back as `[]`, so a screen
can read `codes[GROUP]` without a check. An empty entry or a malformed code is
400. Without it, every group comes back, as before.

**The public route takes no BP on purpose.** When it took a BP code, anyone
could read any BP's renamed labels and BP전용 items without signing in, and BP
codes are sequential, so they could be enumerated. No pre-login screen needed
another BP, so the parameter went (재영, 2026-10-14). If one ever does — a
직원 앱 sign-up screen reached from an invitation, say — derive the BP from
something the caller holds (the invitation token), not from a code it types.

Both routes read the database on every call and send no cache header, and
관리자 웹 does not cache them either: a screen calls with `groups` when it opens
and gets current values (재영, 2026-10-13 — this replaced a 4-hour Next server
cache for the pre-login read).

# A platform user entering a BP

A platform account's `login-info.stores` is empty: it picks a BP, which 관리자 웹
opens in a new tab. `GET /bp-codes/{bpCodeId}/stores` gives that BP's store
selector and `GET /bp-codes/{bpCodeId}/code-items` its 공통코드; the tab of the
account's own BP copies what login gave instead. Browser data after login is
keyed by `bpCodeId`, which is why `login` and `login-info` both carry
`account.bp.bpCodeId`. The store list is every
undeleted store regardless of 운영 상태, name order, items shaped like
`login-info.stores`, unpaged (a selector, not a list screen). The BP is taken by
id, following the naming rule; the id comes from the BP list the screen picked it
from.

- **Who sees which BP's stores** (`AdminScopeService.bpStoresAccess`, 재영
  2026-10-14 — it is not a 플랫폼 관리자-only route any more):
  - an active PM or PA of the platform BP: any customer BP;
  - BP · 가맹 관리자: their own BP only — all its stores, not only the mapped ones;
  - 직원 앱: a BP where the account has a joined (`JOINED`), employed staff record.
  Any other BP answers **404, like a missing one**, so the route does not tell
  whether a BP exists. An admin account not in use gets 403 「사용할 수 없는
  계정입니다…」. This is reading a store list only — what a platform user may do
  inside a customer BP's stores will come from the target BP above once 점포
  moves to `@TargetBp()`; until then `canManageStore` still uses the own BP.
- An unknown or deleted BP, the platform BP itself, and an id outside
  `1..2147483647` are 404. A withdrawn BP still answers, since its records stay
  viewable.
- Both are current on every call; it is not part of the "next login" policy,
  because entering a BP is itself the moment the screen is drawn.

The BP to pick comes from `GET /bp-codes` (2026-10-19, 서비스 바로가기 「웨일ERP」의
BP 선택 팝업). Only an active PM or PA of the platform BP may call it
(`AdminScopeService.platformAdminAccess`): any other admin gets 403 「접근 권한이
없습니다…」, an account not in use 403 「사용할 수 없는 계정입니다…」, and a 직원 앱
token 403. It lists undeleted customer BPs — **사용 · 미사용 · 탈퇴 alike**, since
a withdrawn BP's records stay viewable and the stores · 공통코드 routes above answer
for it (200, proven by e2e) — in `bp_code` order then `bp_code_id`, paged by the list rule. `keyword`
(trimmed, at most 50) matches 상호 or BP코드 as a case-insensitive substring,
with `%` and `_` taken literally (`containsText`).
`accountStatusCode` is the raw `ACCOUNT_STATUS` value; the screen labels it from
공통코드.
