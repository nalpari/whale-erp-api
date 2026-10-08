---
type: API
title: Authentication
description: The 직원 근무 앱 login (login · refresh · logout over per-device sessions, 5-wrong-attempts lock, no refresh rotation) and its PIN password reset, the deny-by-default guard that checks the session on every request, and the rules the still-to-come 관리자 웹 login must keep.
tags: [auth, jwt, security, nestjs, session]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-08T04:19:34Z }
sources:
  - id: auth-module
    resource: ../../src/auth/auth.module.ts
    title: AuthModule (JwtModule, ThrottlerModule, global guard, account login)
    last_modified: 2026-10-08T04:19:34Z
  - id: auth-types
    resource: ../../src/auth/auth.types.ts
    title: UserType slot and token payload (sid)
    last_modified: 2026-10-08T04:19:34Z
  - id: jwt-auth-guard
    resource: ../../src/auth/jwt-auth.guard.ts
    title: Global guard (bearer parsing, token type, session check, user type)
    last_modified: 2026-10-08T04:19:34Z
  - id: jwt-secret
    resource: ../../src/auth/jwt-secret.ts
    title: Signing key validation at startup
    last_modified: 2026-08-31T01:49:15Z
  - id: throttle
    resource: ../../src/auth/throttle.ts
    title: Rate limiting (IP axis; e-mail, token or IP account axis)
    last_modified: 2026-10-08T04:19:34Z
  - id: password
    resource: ../../src/auth/password.ts
    title: scrypt password hashing and token hashing
    last_modified: 2026-10-08T04:19:34Z
  - id: account-auth-service
    resource: ../../src/auth/account-auth.service.ts
    title: 직원 근무 앱 login · refresh · logout
    last_modified: 2026-10-08T04:19:34Z
  - id: account-auth-controller
    resource: ../../src/auth/account-auth.controller.ts
    title: POST /auth/account/login · refresh · logout
    last_modified: 2026-10-08T04:19:34Z
  - id: attempt-lock
    resource: ../../src/auth/attempt-lock.ts
    title: Failed-attempt lock rule (5 wrong, 5 minutes)
    last_modified: 2026-10-08T02:05:10Z
  - id: password-reset-service
    resource: ../../src/auth/password-reset.service.ts
    title: PIN password reset (request · verify · reset)
    last_modified: 2026-10-08T04:19:34Z
  - id: password-policy
    resource: ../../src/auth/password-policy.ts
    title: New-password rule (WHALEERP-192)
    last_modified: 2026-10-08T02:05:10Z
  - id: pin
    resource: ../../src/auth/pin.ts
    title: PIN generation and normalisation
    last_modified: 2026-10-08T01:03:32Z
  - id: password-reset-controller
    resource: ../../src/auth/password-reset.controller.ts
    title: POST /auth/account/password-reset-pins · verify · password-reset
    last_modified: 2026-10-08T04:19:34Z
  - id: password-reset-pin-sender
    resource: ../../src/auth/password-reset-pin-sender.ts
    title: PIN sender slot (send · isAvailable)
    last_modified: 2026-10-08T02:05:10Z
  - id: noop-password-reset-pin-sender
    resource: ../../src/auth/noop-password-reset-pin.sender.ts
    title: Sender that sends nothing (unavailable in production)
    last_modified: 2026-10-08T04:19:34Z
  - id: auth-session-service
    resource: ../../src/auth-session/auth-session.service.ts
    title: Per-device sessions (issue · validate · isActive · revoke)
    last_modified: 2026-10-08T04:19:34Z
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
| `POST /auth/account/password-reset-pins` | yes | e-mail → a 6-character PIN to that mailbox; 204 whatever the account (503 when no sender is available) |
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
no-op when its argument is forgotten. `@CurrentUser()` injects an `AuthUser`
built from the verified payload, a union by `type`: `account` always carries
`sid`, `admin` carries none (a `sid` claim on an admin token is dropped). When
1팀 gives admins a session, the field goes on `AdminUser` and the guard fills
it — an optional field on one shape would let "an account with no session" be
written.

The `Authorization` scheme is matched case-insensitively, as RFC 7235 §2.1
requires — proxies do normalise header casing.

## The guard checks the session, not just the signature

An access token is valid for 15 minutes by signature alone. If the guard stopped
there, **logging out, or resetting the password, would leave the token working
for up to 15 minutes** — and "a logged-out user is sent no 근무 정보" would be
false. So a `type: 'account'` token carries `sid` (the `auth_sessions` id it
came from) and the guard asks `AuthSessionService.isActive(sid, accountId)` on
**every** request: not revoked, not expired, and owned by the token's subject.
Anything else — including a session whose account has since been 탈퇴 — is a
401 with one message.[^jwt-auth-guard]

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
`sid`. The guard rejects anything but `typ: 'access'`. Today the refresh token is
not a JWT at all, so it could never pass as a bearer token anyway; the check is
there for the next JWT this key signs (관리자 웹's refresh, a link token) — a
signed token of another kind must not open the API. The `jti` is not decoration:
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
ended refresh token, or one whose account is 탈퇴, all answer the **same**
message, because telling them apart would show whether a token was ever valid.
`revoke` refuses a non-integer id outright: Prisma drops an `undefined` filter,
and an `updateMany` with no `authSessionId` would end every session there is.

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
   password, unknown account and 탈퇴 must return the same message **and do the
   same scrypt work** — the ~30 ms derivation. Matching only the message is not
   enough: skipping it for unknown e-mails answers "is this address registered?"
   through latency. Only that dominant cost is equalised; a few ms of database
   round trips still differ (a wrong password on an existing account runs the
   failure-count transaction), which was accepted — the per-e-mail limit (10 per
   10 minutes) leaves too few samples to read it. The other paths differ more —
   a locked account skips the derivation, a success writes a session — but each
   of those already says the account exists.
5. **On success, lock the row and look again** — one transaction: `SELECT …
   FOR UPDATE`, re-read, then clear stored failures, issue the session and write
   the success history. If the row changed while the password was being checked
   it is refused: locked meanwhile by a concurrent fifth failure → 429 (clearing
   it would undo that lock); password hash changed by a reset, or 탈퇴 → 401
   (otherwise a reset's `revokeAll` could be followed by a fresh session made
   with the old password). Every attempt writes a `login_histories` row, with a
   reason on failure: `PASSWORD_MISMATCH`, `ACCOUNT_NOT_FOUND` or `LOCKED`. Each
   race is recorded as it would have been without the race: a lock meanwhile as
   `LOCKED`, a 탈퇴 meanwhile as `ACCOUNT_NOT_FOUND` with no account, a reset
   meanwhile as `PASSWORD_MISMATCH` (the value typed is not the current
   password) — without adding to the failure count, since it was right a moment
   ago.

An account whose 가입 연결 is on hold (`LINK_HOLD`) **can log in**; the status is
in the response so the app can show "관리자 확인 중". 퇴직 does not block either: the
login never reads `staff_members`, so a 퇴직한 직원 keeps access to the 급여
탭 (PAY-4, ACC-15). There is no 휴면 state and nothing blocks an account for not
being used (ACC-18). `AccountStatus` is `JOINED`, `LINK_HOLD`, `WITHDRAWN`, and
a test pins that list so a new value has to come with a decision about login.

**A 관리자 cannot log in as an employee or read a password.** The only routes
under `/auth/account` are the six above; the one that takes a token (logout)
answers an `admin` token with 403, the rest take no token at all, and no
response carries a password hash. A test pins the route list, so a new
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
   with `expires_at` = issue + **10 minutes**. The answer is **204** (or 503,
   below):
   unknown e-mail, 탈퇴 account, a request within a minute of the last one, the
   eleventh in 24 hours — none of them says so, because a different answer
   would show whether the address is registered. A rate-limited request simply
   issues nothing; the previous PIN stays valid until it expires. A new PIN
   closes every earlier open PIN of that account. Hitting the daily cap is
   logged (`warn`, account id only) — it is both why "the mail never came" and
   the sign of someone requesting PINs for another person's address; the
   one-minute interval is ordinary double-clicking and is not logged.
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
- **Count under a row lock, verify outside it.** Request, verify and reset all
  lock the account row (`SELECT … FOR UPDATE`) before they write. Without it,
  concurrent wrong PINs all read "fewer than five", and nine parallel requests
  push `attempt_count` past the CHECK (0–5) into a 500. The scrypt comparison —
  and, for a reset, hashing the new password — happens **before** the lock, so
  one account's requests do not queue behind 30 ms each; under the lock the PIN
  row is read again and the result is applied only if it is still the same,
  usable PIN (time taken after the lock), and the account is checked again for
  탈퇴. Parallel guesses are all derived, but
  only the first five applied count, and a right guess that arrives after the
  fifth wrong one is discarded. Real-PostgreSQL tests cover parallel wrong PINs,
  parallel requests (one PIN issued) and two parallel resets with one PIN (one
  succeeds).
- **Increment, then throw.** A wrong PIN's increment must commit, so the
  transaction returns an outcome and the error is thrown after it.
- **The PIN is judged before the password rule.** A wrong PIN is a 401 even when
  the password is also bad; otherwise the endpoint would describe the rule to
  anyone without a PIN. A bad password with a right PIN is a 400 with the
  reason, and the PIN is left unconsumed and uncounted so the user can try again.
  That 400, too, is given only after the PIN is re-checked under the lock — a
  PIN closed or replaced meanwhile answers 401, never "right PIN, bad password".
- **Same message, same scrypt work.** Wrong, expired, closed, used, no PIN,
  unknown or withdrawn account: one 401 message, and a dummy scrypt
  verification wherever there is nothing real to check. As with login, the PIN
  lookup and transaction an existing account runs still add a few ms; that
  residue was accepted. The dummy hash is computed once at startup
  (`AuthModule.onModuleInit`), not on the first unknown e-mail — otherwise that
  one request runs scrypt twice and each instance gives the answer away once; a
  failure there stops the boot rather than 500-ing only unknown accounts.
- **A PIN closed by its fifth wrong guess is logged** (`warn`, account id
  only, never the PIN), so guessing leaves more than a number in
  `attempt_count`.

The new-password rule is WHALEERP-192's and shared by every place that sets a
password:[^password-policy] four kinds (upper, lower, digit, anything else);
three or more kinds need 8 characters, two need 10, one is refused; at most 20;
not the e-mail or the part before `@`, case-insensitive. Reuse and expiry are
deliberately not enforced.

Sending is behind `PasswordResetPinSender`, **after** the PIN row is committed
and **without waiting**: awaiting the mail would make an existing account's
answer slower by the send time, and a send failure is only logged — the user can
ask again a minute later. A database error while storing the PIN is logged and
still answered 204, because that transaction only runs for an existing account
and a 500 there would say so; only Prisma's errors (request and connection) are
swallowed, a code error still surfaces.

Until the mail base (WHALEERP-320) exists, `NoopPasswordResetPinSender` is wired
in. **No PIN mail is sent yet.** It sends nothing and does not log the PIN
either — the PIN is the right to change the password. Outside production it
reports itself available, so the flow can be run end to end (the e2e tests
capture the PIN with a fake sender). In production (`isProduction()`) it reports
itself **unavailable**, and then every PIN request is a **503**, decided before
the account is even looked up so the answer cannot vary by account. Booting is
not blocked: a missing mailer must not take login down with it. Instead the
Noop sender logs one `error` at startup in production, so a deployment that
forgot the mailer shows up before the first user reports it.

# Rate limiting

Login, refresh and the reset routes are reachable without a token, and each
login or PIN check spends ~30 ms of scrypt on libuv's four-thread pool.
`AuthModule` registers the limits on two axes — `ip` 30 a minute, `account` 10
per 10 minutes — and `AccountAuthController` and `PasswordResetController` opt
in with `@UseGuards(ThrottlerGuard)`.[^throttle] Both axes are needed: an IP
limit alone misses a botnet grinding one account, and an account limit alone
misses a single host cycling e-mail addresses to burn CPU. Buckets are per
route.

The `account` axis picks its key by what the request carries, not by route: a
body `email` (normalised) first, then the sha256 of a body refresh token, then of
the bearer token, and only then the IP. The hash, not the token, is the key, so
the counter store never holds a credential.

**The IP is `req.ip`, and trust proxy is not set.** Behind a proxy or load
balancer that is the proxy's address, and every user shares one `ip` bucket.
Refresh is called by every app every 15 minutes, so 30 a minute shared by
everyone would have users throttling each other as their number grows; its `ip`
limit is raised to 600 a minute (`REFRESH_IP_LIMIT`, `@Throttle`). It is not
removed: the token axis opens a new bucket per token, so without any IP limit a
caller sending a fresh random token each time would not be limited at all.
Logout skips the `ip` axis (`@SkipThrottle({ ip: true })`): it is reached only
with a valid access token — the global JWT guard runs first — so there is
nothing for an IP limit to stop. For
login and the reset routes the shared bucket is still in force; whether the
API runs behind a proxy, and which hop to trust, is an infrastructure question
still open — settle it before relying on the `ip` axis there.
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
[^throttle]: Rate limiting (IP axis; e-mail, token or IP account axis)
[^auth-types]: UserType slot and token payload (sid)
[^account-auth-service]: 직원 근무 앱 login · refresh · logout
[^attempt-lock]: Failed-attempt lock rule (5 wrong, 5 minutes)
[^auth-session-service]: Per-device sessions (issue · validate · isActive · revoke)
[^password-reset-service]: PIN password reset (request · verify · reset)
[^password-policy]: New-password rule (WHALEERP-192)
