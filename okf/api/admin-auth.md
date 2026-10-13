---
type: API
title: Admin authentication
description: 관리자 웹 login (1팀 admin_accounts) — login · refresh · logout over admin_sessions, temporary-password login, GET /auth/admin/login-info for the screen, the per-request menu-permission guard, the public 공통코드 API by BP code, and a platform user's stores and 공통코드 of a picked BP.
tags: [auth, jwt, security, session, admin, codes]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-13T10:00:00Z }
sources:
  - id: admin-auth-service
    resource: ../../src/auth/admin-auth.service.ts
    title: 관리자 웹 login · refresh · logout
    last_modified: 2026-10-13T02:11:20Z
  - id: admin-auth-controller
    resource: ../../src/auth/admin-auth.controller.ts
    title: POST /auth/admin/login · refresh · logout, GET /auth/admin/login-info
    last_modified: 2026-10-13T02:11:20Z
  - id: admin-session-service
    resource: ../../src/admin-session/admin-session.service.ts
    title: admin_sessions (issue · find · extend · isActive · revoke)
    last_modified: 2026-10-13T02:11:20Z
  - id: admin-login-info-service
    resource: ../../src/auth/admin-login-info.service.ts
    title: Login info — account, menu tree with CRUD, managed stores, codes
    last_modified: 2026-10-13T02:11:20Z
  - id: menu-permission-guard
    resource: ../../src/auth/menu-permission.guard.ts
    title: '@MenuPermission(menuCode, action) — per-request check'
    last_modified: 2026-10-13T02:11:20Z
  - id: codes-service
    resource: ../../src/codes/codes.service.ts
    title: 공통코드 per BP, for login-info, GET /public-bp-codes/{bpCode}/code-items and GET /bp-codes/{bpCodeId}/code-items
    last_modified: 2026-10-13T10:00:00Z
  - id: admin-temporary-password-service
    resource: ../../src/auth/admin-temporary-password.service.ts
    title: POST /auth/admin/temporary-passwords — 비밀번호 찾기 임시 비밀번호
    last_modified: 2026-10-13T07:00:00Z
  - id: bp-codes-controller
    resource: ../../src/bp-codes/bp-codes.controller.ts
    title: GET /bp-codes/{bpCodeId}/stores · code-items — 플랫폼 사용자의 BP 진입
    last_modified: 2026-10-13T10:00:00Z
---

# Routes

| Route | Public | Does |
|---|---|---|
| `POST /auth/admin/login` | yes | `{ loginId, password, deviceInformation? }` → `{ accessToken, refreshToken, refreshTokenExpiresAt, account }` — the 직원 앱 shape; `account.bp` carries `bpCodeId` |
| `POST /auth/admin/refresh` | yes | refresh token → new access token and the session's new expiry |
| `POST /auth/admin/logout` | admin | ends this browser's session only |
| `POST /auth/admin/temporary-passwords` | yes | `{ name, loginId, email }` → the same 202 whether or not they match; a match gets a 1-hour temporary password by mail |
| `GET /auth/admin/login-info` | admin | `{ account, menus, stores, codes }` as of the call |
| `GET /public-bp-codes/{bpCode}/code-items?groups=A,B` | yes | the 공통코드 that BP sees — only the named groups when `groups` is given — `{ codes: { GROUP: [{ value, label, order }] } }` |
| `GET /bp-codes/{bpCodeId}/stores` | PM · PA | every undeleted store of a customer BP, `{ items, total }` — the store selector after picking a BP |
| `GET /bp-codes/{bpCodeId}/code-items?groups=A,B` | PM · PA | the same `codes` for a picked customer BP |

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
- The mail is sent **before** anything is stored. If Gmail fails, the answer is
  503 and no temporary password exists — one that was never delivered would
  only lock the user's old one out.
- On success, under the account row lock: every live temporary password is
  invalidated (used ones too, since they stay usable until expiry), the new one
  is stored for one hour, the login lock is cleared, and
  `is_password_change_required` is set. That flag is what makes a sign-in with
  it raise the forced-change popup and end the session at its expiry; a sign-in
  with the own password clears it again.
- The own password is left alone — `password_hash` is not replaced with `'!'`
  for 찾기, so someone who remembers it can still use it.
- `mail_send_logs` keeps the body with `#{임시비밀번호}` masked.
- The button links to `ADMIN_WEB_URL` + `/login`; an empty value stops the boot
  in production and falls back to `http://localhost:3000` elsewhere.

Because `AuthModule` now imports `MailModule`, **the whole app needs
`MAIL_USERNAME` · `MAIL_PASSWORD` to boot**, not only this route.

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
- Signing in with the own password invalidates unused 찾기 (`TEMPORARY`)
  passwords and clears the forced-change flag they set.

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
button its user has lost; the 403 says 「권한이 변경되었습니다. 다시 로그인해 주세요」.
The guard denies when it finds no menu marker — a restriction-shaped guard
must not open up when used wrong.

What `login-info` contains:

- **menus** — active menus of active services (`SERVICE` codes), readable by
  the account's role group, as a tree of at most three levels. A parent the user
  cannot read is included only as the way to a readable child, with every
  permission false. A child of an inactive parent disappears with it.
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

- **Before login** — `GET /public-bp-codes/{bpCode}/code-items`, by BP *code*:
  `bpCodeId` differs between environments, and a screen with no session cannot
  learn it, so the same address must mean the same BP everywhere. Screens pass
  the platform BP, `BP000000`. A malformed code is 400; an unknown, deleted or
  withdrawn BP is 404. It replaced `GET /code-items?bpCode=`, which no screen
  had called yet.
- **The account's own BP** — `login-info.codes`; no call after login.
- **A BP a platform user picked** — `GET /bp-codes/{bpCodeId}/code-items`, by id
  like everything after login; same access and 404s as that BP's stores (below).

`groups` is optional on both routes: a comma list (or repeated parameter) of group codes, at
most 50, each in the `code_groups` format. Given, only those groups come back,
and a group that does not exist or is not in use comes back as `[]`, so a screen
can read `codes[GROUP]` without a check. An empty entry or a malformed code is
400. Without it, every group comes back, as before.

**Any BP's codes are readable without signing in**, including its renamed labels
and BP전용 items, and BP codes are sequential, so they can be enumerated. That
was accepted as harmless — codes and labels only. If a BP ever keeps something
in 공통코드 it would not show a stranger, this route needs a sign-in.

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

- Only an active PM or PA account of the platform BP passes (`isPlatformUser`,
  재영 2026-10-13 — PA was held back for WHALEERP-301 until then); anyone else
  gets 403. This is entry to a BP only — what a platform user may do inside a
  customer BP's stores (`canManageStore`) is still WHALEERP-301.
- An unknown or deleted BP, the platform BP itself, and an id outside
  `1..2147483647` are 404. A withdrawn BP still answers, since its records stay
  viewable.
- Both are current on every call; it is not part of the "next login" policy,
  because entering a BP is itself the moment the screen is drawn.
