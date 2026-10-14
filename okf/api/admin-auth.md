---
type: API
title: Admin authentication
description: 관리자 웹 login (1팀 admin_accounts) — login · refresh · logout over admin_sessions, temporary-password login, GET /auth/admin/login-info for the screen, the per-request menu-permission guard, the public 공통코드 API (platform BP only), and a platform user's stores and 공통코드 of a picked BP.
tags: [auth, jwt, security, session, admin, codes]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-14T07:51:25Z }
sources:
  - id: admin-auth-service
    resource: ../../src/auth/admin-auth.service.ts
    title: 관리자 웹 login · refresh · logout
    last_modified: 2026-10-14T08:00:00Z
  - id: admin-auth-controller
    resource: ../../src/auth/admin-auth.controller.ts
    title: POST /auth/admin/login · refresh · logout, GET /auth/admin/login-info
    last_modified: 2026-10-14T05:00:00Z
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
    title: '@MenuPermission(menuCode, action) — per-request check'
    last_modified: 2026-10-14T05:00:00Z
  - id: codes-service
    resource: ../../src/codes/codes.service.ts
    title: 공통코드 per BP, for login-info, GET /public-code-items and GET /bp-codes/{bpCodeId}/code-items
    last_modified: 2026-10-14T07:51:25Z
  - id: admin-temporary-password-service
    resource: ../../src/auth/admin-temporary-password.service.ts
    title: POST /auth/admin/temporary-passwords — 비밀번호 찾기 임시 비밀번호
    last_modified: 2026-10-14T05:00:00Z
  - id: admin-password-change-service
    resource: ../../src/auth/admin-password-change.service.ts
    title: POST /auth/admin/password-change — 강제 비밀번호 변경 + 약관 동의
    last_modified: 2026-10-14T08:00:00Z
  - id: admin-password-policy
    resource: ../../src/auth/admin-password-policy.ts
    title: 1팀 비밀번호 정책(PL-QSBSYY) 검사와 문구
    last_modified: 2026-10-14T05:00:00Z
  - id: bp-codes-controller
    resource: ../../src/bp-codes/bp-codes.controller.ts
    title: GET /bp-codes/{bpCodeId}/stores · code-items — 플랫폼 사용자의 BP 진입
    last_modified: 2026-10-14T07:51:25Z
---

# Routes

| Route | Public | Does |
|---|---|---|
| `POST /auth/admin/login` | yes | `{ loginId, password, deviceInformation? }` → `{ accessToken, refreshToken, refreshTokenExpiresAt, account }` — the 직원 앱 shape; `account.bp` carries `bpCodeId` |
| `POST /auth/admin/refresh` | yes | refresh token → new access token and the session's new expiry |
| `POST /auth/admin/logout` | admin | ends this browser's session only |
| `POST /auth/admin/temporary-passwords` | yes | `{ name, loginId, email }` → the same 202 whether or not they match; a match gets a 1-hour temporary password by mail |
| `POST /auth/admin/password-change` | admin | `{ newPassword, newPasswordConfirm, isTermsAgreed? }` → 204. 강제 변경 — no current password asked |
| `GET /auth/admin/login-info` | admin | `{ account, menus, stores, codes }` as of the call |
| `GET /public-code-items?groups=A,B` | yes | the platform BP's 공통코드 — only the named groups when `groups` is given — `{ codes: { GROUP: [{ value, label, order }] } }` |
| `GET /bp-codes/{bpCodeId}/stores` | any signed-in user, by BP | every undeleted store of a customer BP, `{ items, total }`. PM · PA see any customer BP; everyone else only their own (below) |
| `GET /bp-codes/{bpCodeId}/code-items?groups=A,B` | any signed-in user | the same `codes` for any undeleted BP — 관리자 of every role and 직원 앱 alike |

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
- Five wrong attempts lock for five minutes (429), counted under
  `SELECT … FOR UPDATE` on the `admin_accounts` row, as in the 직원 앱 login.
  While locked the password is not even checked, and the attempt is not counted.
- 미사용 is told (403) only when the password was right.
- Success re-reads the row under the lock and refuses if, meanwhile, the
  account was locked, deactivated, withdrawn, its password changed or the
  temporary password invalidated — the user typed a correct value, so these do
  not count as failures.
- `admin_login_logs` keeps every attempt with the client IP. An unknown id has
  no account to point at and is logged as `PASSWORD_MISMATCH` with a null id.

# Issuing a temporary password

`POST /auth/admin/temporary-passwords` is 비밀번호 찾기 (front okf `auth.md`,
「계정 찾기」), ported from a parallel implementation on `squirtle`:

- Name, login id and e-mail must all match an active, undeleted account; any
  mismatch gets the same 202 and no mail, so the route does not tell whether an
  account exists. Five per account per hour (429, told only to a full match).
- The mail is sent **before** anything is stored. If Gmail fails — or no
  sender is configured — nothing is stored and the answer is **the same 202**:
  a 503 there would tell a guesser that the name, id and e-mail matched (PR #30
  review). A user who got nothing asks again; the operator sees a warning log.
- After the mail, under the account row lock, the account is **read again with
  the same conditions**. If its e-mail, name, status or deletion changed while
  SMTP ran (up to tens of seconds), nothing is stored — otherwise a password
  mailed to an old address would live for an hour (the race PR #29's review
  caught for 플랫폼 관리자 resets).
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
stored and the answer is still the same 202. Half the mail settings, or an
`ADMIN_WEB_URL` that is not an http(s) address, stop the boot. `MAIL_PASSWORD` is
a Gmail **app** password; the account password is refused (534-5.7.9).

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
  must send `isTermsAgreed: true`, or nothing is saved (400). The two active
  versions of `TERMS_SERVICE` and `PRIVACY_COLLECT` are recorded as
  `FIRST_LOGIN` agreements and on the account, in the same transaction as the
  password.
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
`@MenuPermission('MN000010', 'update')` adds `@UserTypes('admin')` and a guard
that reads the caller's role group from the database, and store scope stays
with `AdminScopeService.canManageStore`. A screen may therefore still show a
button its user has lost; the 403 is the access message below. The guard denies
when it finds no menu marker — a restriction-shaped guard must not open up when
used wrong.

# 403 messages

Three sentences only, one per situation (재영, 2026-10-14). They live in
`src/auth/access-messages.ts`, and 관리자 웹 branches on them, so **a new 403 for
one of these situations uses the constant, never its own wording** — and a change
of wording is announced to front.

| Situation | `message` | 관리자 웹 |
|---|---|---|
| Forced password change not done (guard) | 「서비스 이용을 위해 비밀번호를 변경해 주세요.」 | reopen the change popup |
| No menu permission (`@MenuPermission`, `MenuPermissionsService`), a platform-only screen called by a non-platform account (`isPlatformAdmin` callers, 플랫폼 관리자 role check), a token of the wrong kind (`@UserTypes`) | 「접근 권한이 없습니다. 관리자에게 문의해 주세요.」 | show it, go back (`history.back()`, home if none) |
| Deleted, 미사용 or 탈퇴 account still holding a live session | 「사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.」 | show it, go back |

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
- **Any BP, after login** — `GET /bp-codes/{bpCodeId}/code-items`, by id like
  everything after login. **Any signed-in user** may call it — 관리자 of every
  role and 직원 앱 tokens — and any undeleted BP answers, the platform BP and
  withdrawn BPs included; unknown, deleted or out-of-range ids are 404 (재영,
  2026-10-14: it is not a 플랫폼 관리자 route). It used to share the stores
  route's PM · PA restriction. So any signed-in user, a 직원 앱 token included,
  can still walk BP ids and read other BPs' BP전용 codes — accepted as codes and
  labels only. Narrow it like the stores route if that ever stops being true.

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
  inside a customer BP's stores (`canManageStore`) is still WHALEERP-301.
- An unknown or deleted BP, the platform BP itself, and an id outside
  `1..2147483647` are 404. A withdrawn BP still answers, since its records stay
  viewable.
- Both are current on every call; it is not part of the "next login" policy,
  because entering a BP is itself the moment the screen is drawn.
