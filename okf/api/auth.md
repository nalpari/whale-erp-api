---
type: API
title: Authentication
description: The 직원 근무 앱 login (login · refresh · logout over per-device sessions, 5-wrong-attempts lock, no refresh rotation) and its PIN password reset, the deny-by-default guard that checks the session on every request, and the rules the still-to-come 관리자 웹 login must keep.
tags: [auth, jwt, security, nestjs, session]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-08T01:09:38Z }
sources:
  - id: auth-module
    resource: ../../src/auth/auth.module.ts
    title: AuthModule (JwtModule, ThrottlerModule, global guard, account login)
    last_modified: 2026-10-07T07:47:58Z
  - id: auth-types
    resource: ../../src/auth/auth.types.ts
    title: UserType slot and token payload (sid)
    last_modified: 2026-10-07T07:47:58Z
  - id: jwt-auth-guard
    resource: ../../src/auth/jwt-auth.guard.ts
    title: Global guard (bearer parsing, token type, session check, user type)
    last_modified: 2026-10-07T07:47:58Z
  - id: jwt-secret
    resource: ../../src/auth/jwt-secret.ts
    title: Signing key validation at startup
    last_modified: 2026-08-31T01:49:15Z
  - id: throttle
    resource: ../../src/auth/throttle.ts
    title: Login rate limiting (IP and account axes)
    last_modified: 2026-08-31T01:49:15Z
  - id: password
    resource: ../../src/auth/password.ts
    title: scrypt password hashing and token hashing
    last_modified: 2026-08-31T01:49:15Z
  - id: account-auth-service
    resource: ../../src/auth/account-auth.service.ts
    title: 직원 근무 앱 login · refresh · logout
    last_modified: 2026-10-07T07:47:58Z
  - id: account-auth-controller
    resource: ../../src/auth/account-auth.controller.ts
    title: POST /auth/account/login · refresh · logout
    last_modified: 2026-10-07T07:47:58Z
  - id: attempt-lock
    resource: ../../src/auth/attempt-lock.ts
    title: Failed-attempt lock rule (5 wrong, 5 minutes)
    last_modified: 2026-10-07T07:47:58Z
  - id: password-reset-service
    resource: ../../src/auth/password-reset.service.ts
    title: PIN password reset (request · verify · reset)
    last_modified: 2026-10-08T00:51:03Z
  - id: password-policy
    resource: ../../src/auth/password-policy.ts
    title: New-password rule (WHALEERP-192)
    last_modified: 2026-10-08T00:51:03Z
  - id: pin
    resource: ../../src/auth/pin.ts
    title: PIN generation and normalisation
    last_modified: 2026-10-08T00:51:03Z
  - id: auth-session-service
    resource: ../../src/auth-session/auth-session.service.ts
    title: Per-device sessions (issue · validate · isActive · revoke)
    last_modified: 2026-10-08T00:51:03Z
---

# What it is

There is one login today: **직원 근무 앱, against 3팀 `accounts`**
(2026-10-07 – 08, WHALEERP-161 – 164, 168 – 171). Six routes, all under
`/auth/account`:

| Route | Public | What it does |
|---|---|---|
| `POST /auth/account/login` | yes | e-mail + password → access token, refresh token, account summary |
| `POST /auth/account/refresh` | yes | refresh token → new access token and the pushed-out expiry |
| `POST /auth/account/logout` | no (`@UserTypes('account')`) | ends this device's session |
| `POST /auth/account/password-reset-pins` | yes | e-mail → a 6-character PIN to that mailbox; always 204 |
| `POST /auth/account/password-reset-pins/verify` | yes | e-mail + PIN → 204 if right; changes nothing |
| `POST /auth/account/password-reset` | yes | e-mail + PIN + new password → password changed, every session ended |

**관리자 웹 has no login yet** — 1팀 builds it against `admin_accounts`.
`UserType` is `'admin' | 'account'`, one value per login table, and nothing
issues `'admin'` yet.[^auth-types] The template's sample login (`staff` and
`customers`, `pnpm user:create`) was removed with the other samples (재영,
2026-10-07); the rules it proved out are kept below.

Requests carry `Authorization: Bearer <accessToken>`. There is no cookie, so
CORS stays simple and Next.js can call the API from either server or client.
Where the token is stored is the frontend's decision.

# Deny by default

`JwtAuthGuard` is registered as an `APP_GUARD`, so **every** route needs a
valid access token unless it is marked `@Public()`. The inverse arrangement —
opt-in protection — leaks a new controller the first time someone forgets the
decorator, and forgetting is the normal case.

Currently public: the leftover `GET /`, `GET /enums` (the 비로그인 홈 needs
it), `POST /auth/account/login`, `POST /auth/account/refresh` and the three
password-reset routes. Swagger UI is
not a Nest route, so the guard never sees it; it is closed in production by the
`APP_ENV` check in `main.ts` instead.

`@UserTypes('admin')` narrows a route to one kind of token (403 otherwise);
without it, any authenticated caller passes — so a route for one client only
must say so. An **empty** list (`@UserTypes()`) denies everyone rather than
allowing everyone: a decorator that looks like a restriction must not be a
no-op when its argument is forgotten. `@CurrentUser()` injects
`{id, type, email, sid?}` from the verified payload.

The `Authorization` scheme is matched case-insensitively, as RFC 7235 §2.1
requires — proxies do normalise header casing.

## The guard checks the session, not just the signature

An access token is valid for 15 minutes by signature alone. If the guard stopped
there, **logging out, or resetting the password, would leave the token working
for up to 15 minutes** — and "a logged-out user is sent no 근무 정보" would be
false. So a `type: 'account'` token carries `sid` (the `auth_sessions` id it
came from) and the guard asks `AuthSessionService.isActive(sid, accountId)` on
**every** request: not revoked, not expired, and owned by the token's subject.
Anything else is a 401 with one message.[^jwt-auth-guard]

Three details that matter:

- The check is a **read** (`count`). It never moves the expiry; only
  `refresh` does. Writing on every API call would turn all reads into writes.
- Authentication comes **before** authorisation: an ended session is 401 even
  on a route the token's type may not use, never 403.
- A `type: 'account'` token **without** `sid` is rejected, not waved through —
  there is nothing to check, so it cannot be trusted. `admin` tokens have no
  session table behind them yet and skip the check; when 1팀's login lands it
  decides its own.

The price is one indexed lookup per request. It was accepted over the
alternatives (signature only, or a short cache) because both leave a window in
which an ended session still reads data.

# Tokens

**Access token**: JWT, HS256, 15 minutes, `typ: 'access'`, a random `jti`, and
`sid`. The guard rejects anything but `typ: 'access'`, which is what stops a
refresh token from being used as a bearer token. The `jti` is not decoration:
two issues in the same second would otherwise be byte-identical.

**Refresh token**: *not* a JWT — 32 random bytes, base64url, shown once. The
database keeps only its sha256.[^password] It lives in `auth_sessions`, **one row
per device** (`device_identifier`), so a login on a phone does not log out the
tablet: logging in again from the *same* device ends that device's previous row
and nothing else.

**Lifetime is "last use + 30 days", and the refresh token is not rotated.**
`refresh` checks the token and, if the session is alive, pushes `expires_at` to
30 days from now and hands out a new access token — the refresh token stays
the same.[^auth-session-service] This is a deliberate policy (직원 근무 앱 keeps
a login for 30 days after last use, decided 2026-09-17 and confirmed
2026-10-07), and it **differs from the removed sample**, which rotated the
refresh token on every use and treated a replay as theft. Rotation is not done
here, so a stolen refresh token works until the session ends — which is why the
session can be ended per device (`logout`), for every device (`revokeAll`,
what a password reset or a 탈퇴 will call), and why the guard checks it on every
request. The access lifetimes of the other clients differ and are not to be
aligned (see [Naming conventions](/conventions/naming.md)).

**Logout** sets `revoked_at` on the session; the row stays. It is idempotent —
calling it again, or twice at once, is not an error. A missing, expired, or
ended refresh token all answer the **same** message, because telling them apart
would show whether a token was ever valid.

Rows are never deleted: `auth_sessions` has a `revoked_at` column and no
deletion flag, and the history is wanted.

`JWT_SECRET` has no default **and is checked for length** — 32 bytes minimum,
enforced in `readJwtSecret`.[^jwt-secret] HS256 accepts a key of any size and
will happily sign with one byte, so an unchecked deployment can be broken from
a single captured token and used to forge any identity. Both an absent and a
too-short value throw during module construction rather than booting a server
whose tokens anyone can forge.

# The login itself

What `login` decides, in order:[^account-auth-service]

1. **Look up by e-mail only**, lowercased and trimmed. The 본인인증 phone number
   is a matching key for invitations, never a login id; the DTO rejects unknown
   fields (400), so a `phone`, `loginAs`, `accountId` or `adminId` cannot be
   smuggled in.
2. **A 탈퇴 (`WITHDRAWN`) account is treated as an account that does not
   exist** (ACC-15, decided 2026-10-07): same message, same time, and a history
   row with no `account_id`. Treating it separately would show that the address
   was once registered.
3. **If the account is locked, refuse before verifying anything** (below).
4. **Verify the password — against a dummy hash when there is no account**. Wrong
   password, unknown account and 탈퇴 must return the same message **and take the
   same time**. Matching only the message is not enough: skipping the ~30 ms
   derivation for unknown e-mails answers "is this address registered?" through
   latency.
5. On success, clear any stored failures, issue the session, sign the access
   token, and write a `login_histories` row. Every attempt writes one, with a
   reason: `PASSWORD_MISMATCH`, `ACCOUNT_NOT_FOUND` or `LOCKED`.

An account whose 가입 연결 is on hold (`LINK_HOLD`) **can log in**; the status is
in the response so the app can show "관리자 확인 중". 퇴직 does not block either: the
login never reads `staff_members`, so a 퇴직한 직원 keeps access to the 급여
탭 (PAY-4, ACC-15). There is no 휴면 state and nothing blocks an account for not
being used (ACC-18). `AccountStatus` is `JOINED`, `LINK_HOLD`, `WITHDRAWN`, and
a test pins that list so a new value has to come with a decision about login.

**A 관리자 cannot log in as an employee or read a password.** The only routes
under `/auth/account` are the six above, an `admin` token gets 403 on them,
and no response carries a password hash. A test pins the route list, so a new
route there means checking this policy first (WHALEERP-168).

## The lock

Five wrong passwords in a row lock the account for **five minutes, fixed** — no
escalation (`attempt-lock.ts`).[^attempt-lock] The 1 / 3 / 5-minute ladder in the
original mock was dropped (노영주, 2026-10-07): once the lock lifts the count goes
back to zero, so a ladder would need a separate "which lock is this" column
that 3팀 `accounts` does not have, and five tries per five minutes is the same
rate from the second lock on.

- A locked account is refused with **429** and a message that says to wait or
  reset the password — even with the right password, and **without verifying**
  it. Attempts during the lock neither count nor extend it; otherwise anyone
  could keep someone else locked out by hammering the account.
- The attempt that causes the fifth failure is answered with the same 429.
- After the lock lifts the first failure counts as one again. A **successful**
  login clears the count, so five typos spread over months do not lock a real
  user. A password reset clears both.
- The 429 is the one place the response differs by account state: after five
  failures it shows the address is registered. That was weighed against a user
  who cannot tell why login stopped, and the hint was kept.

**The count is taken under a row lock.** Counting is one transaction:
`SELECT … FOR UPDATE` on the account row, read the state, apply the rule,
write. Without the lock, concurrent wrong attempts all read the same count and
write the same value — eight parallel requests were all answered 401 and the
lock never engaged. A test with real parallel requests against PostgreSQL covers
it; a mocked test cannot.

# Password reset by PIN

비밀번호 찾기 (WHALEERP-169 – 171, decided 2026-10-08). The table is 3팀
`password_reset_pins`; no column was added.[^password-reset-service]

1. **Request** — a 6-character PIN (A–Z, 0–9, `crypto.randomInt`; about 2.2
   billion values) goes to the account's mailbox, and its scrypt hash is stored
   with `expires_at` = issue + **10 minutes**. The answer is **always 204**:
   unknown e-mail, 탈퇴 account, a request within a minute of the last one, the
   eleventh in 24 hours — none of them says so, because a different answer
   would show whether the address is registered. A rate-limited request simply
   issues nothing; the previous PIN stays valid until it expires. A new PIN
   closes every earlier open PIN of that account.
2. **Verify** — says only whether the PIN is right (204), so the 서버 쪽 화면 can
   move to the new-password page. It changes nothing on success.
3. **Reset** — the same PIN is sent **again** with the new password and checked
   again. On success, one transaction: new password hash, PIN consumed
   (`used_at`), every session ended (`revokeAll` with the transaction client),
   login failures and lock cleared, and an `account_change_histories` row
   (`PASSWORD`, `PIN_RESET`, no values).

Rules that are easy to break:

- **One clock.** The 10 minutes cover both entering the PIN and choosing the
  password. Two clocks would need a "verified at" column, which the table does
  not have, so time spent on the PIN is time taken from the password.
- **Re-verifying instead of a token.** Nothing records that step 2 succeeded;
  step 3 proves it again. No token to store, sign or leak, and every outcome
  comes from one row (expiry, attempts, `used_at`). The cost is that the PIN
  travels twice, which is acceptable because both pages are server-side and
  never put it in a URL or a log.
- **Five wrong PINs close the PIN; there is no cooldown.** Wrong guesses in
  step 2 and step 3 share the same `attempt_count`. The 1 / 3 / 5-minute cooldown
  in the original spec was dropped (WHALEERP-170): five tries per PIN, one PIN a
  minute and ten a day already cap a guesser at fifty tries a day against 2.2
  billion. 3팀 then dropped `cooldown_step` and `cooldown_expires_at`
  (`20261008000000_team3_password_reset_pin`, 재영 2026-10-08).
- **Count under a row lock.** Request, verify and reset all lock the account
  row (`SELECT … FOR UPDATE`) first. Without it, concurrent wrong PINs all read
  "fewer than five", and nine parallel requests push `attempt_count` past the
  CHECK (0–5) into a 500. A real-PostgreSQL test covers it.
- **Increment, then throw.** A wrong PIN's increment must commit, so the
  transaction returns an outcome and the error is thrown after it.
- **The PIN is judged before the password rule.** A wrong PIN is a 401 even when
  the password is also bad; otherwise the endpoint would describe the rule to
  anyone without a PIN. A bad password with a right PIN is a 400 with the
  reason, and the PIN is left unconsumed and uncounted so the user can try again.
- **Same message, same time.** Wrong, expired, closed, used, no PIN, unknown or
  withdrawn account: one 401 message, and a dummy scrypt verification wherever
  there is nothing real to check.

The new-password rule is WHALEERP-192's and shared by every place that sets a
password:[^password-policy] four kinds (upper, lower, digit, anything else);
three or more kinds need 8 characters, two need 10, one is refused; at most 20;
not the e-mail or the part before `@`, case-insensitive. Reuse and expiry are
deliberately not enforced.

Sending is behind `PasswordResetPinSender`. Until the mail base
(WHALEERP-320) exists, `NoopPasswordResetPinSender` sends nothing and does not
log the PIN either — the PIN is the right to change the password.

# Rate limiting

Login and refresh are reachable without a token, and each login spends ~30 ms of
scrypt on libuv's four-thread pool. `AuthModule` registers the limits on two
axes and `AccountAuthController` opts in with `@UseGuards(ThrottlerGuard)`.[^throttle]
Both are needed: an IP limit alone misses a botnet grinding one account, and an
account limit alone misses a single host cycling e-mail addresses to burn CPU.
`PasswordResetController` opts in the same way.
Requests over the limit are refused by the guard, before the handler and
therefore before scrypt — measured at 1 ms against 40 ms for an accepted
attempt. The limit's 429 and the lock's 429 are different things; the lock tests
switch the throttle guard off so they can be told apart.

Counters live in process memory, so a second instance doubles the effective
limit; a shared store is the fix when there is more than one.

# Passwords

scrypt from Node's `crypto`, stored as
`scrypt$<N>$<r>$<p>$<salt-b64>$<key-b64>`.[^password] No bcrypt/argon2
dependency was added. The cost parameters are written into the stored value and
read back on verify, and they are passed explicitly rather than left to Node's
defaults — otherwise raising the cost (or Node changing its defaults) locks out
every existing account with no way to tell which parameters produced a key.

Normalise the login key to lowercase on the way in and keep a CHECK on the
column (3팀 `accounts_email_lower` does) — otherwise two rows differing only in
case pass the unique index and login depends on how the user typed it.

# What 관리자 웹's login should keep

Not decided here — 1팀 owns it, and its `admin_sessions` has its own lifetimes
(access 1 hour, refresh 1 hour after last use). What carries over from the
account login, because each one was a real failure mode:

- a random `jti` in every token, and `typ` separating access from refresh;
- the refresh token's hash stored, never the token, with a per-session row so
  logout and forced expiry are possible;
- the same-message, same-time rejection for unknown and wrong;
- a session check in the guard if the access token outlives the session — the
  15-minute window above is the cost of skipping it;
- the lock must be counted under a row lock, not by reading and writing.

Whether to rotate is **its** decision: the account login does not, by policy.

[^jwt-auth-guard]: Global guard (bearer parsing, token type, session check, user type)
[^password]: scrypt password hashing and token hashing
[^jwt-secret]: Signing key validation at startup
[^throttle]: Login rate limiting (IP and account axes)
[^auth-types]: UserType slot and token payload (sid)
[^account-auth-service]: 직원 근무 앱 login · refresh · logout
[^attempt-lock]: Failed-attempt lock rule (5 wrong, 5 minutes)
[^auth-session-service]: Per-device sessions (issue · validate · isActive · revoke)
[^password-reset-service]: PIN password reset (request · verify · reset)
[^password-policy]: New-password rule (WHALEERP-192)
