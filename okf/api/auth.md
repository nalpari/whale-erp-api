---
type: API
title: Authentication
description: Deny-by-default JWT guard, signing-key check, rate limiting, and scrypt hashing kept for the coming 1팀 and 3팀 logins; the sample staff/customer login was removed, and the token rules it proved out are what a new login must keep.
tags: [auth, jwt, security, nestjs]
status: stable
generated: { by: claude-code/opus-5.5, at: 2026-10-07T05:37:17Z }
sources:
  - id: auth-module
    resource: ../../src/auth/auth.module.ts
    title: AuthModule (JwtModule, ThrottlerModule, global guard)
    last_modified: 2026-10-07T05:37:17Z
  - id: auth-types
    resource: ../../src/auth/auth.types.ts
    title: UserType slot and token payload
    last_modified: 2026-10-07T05:37:17Z
  - id: jwt-auth-guard
    resource: ../../src/auth/jwt-auth.guard.ts
    title: Global guard (bearer parsing, token type, user type)
    last_modified: 2026-08-31T01:49:15Z
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
---

# What it is — and what is not here yet

**There is no login endpoint today** (2026-10-07). The template's sample login
— `staff` and `customers` tables, `POST /auth/staff/login`,
`/auth/customer/login`, `/auth/refresh`, `/auth/logout`, and
`pnpm user:create` — was removed with the other samples (재영). The two real
logins are still to be built: 관리자 웹 by 1팀 against `admin_accounts`, 직원
근무 앱 by 3팀 against `accounts`. Until one lands, no token can be issued and
every protected route answers 401.

What stays is the frame both logins plug into: the global guard and its
decorators, the signing-key check, the rate-limit configuration, and scrypt
hashing. `UserType` is the slot for them — `'admin' | 'account'`, one value
per login table — and nothing issues either value yet.[^auth-types]

Requests carry `Authorization: Bearer <accessToken>`. There is no cookie, so
CORS stays simple and Next.js can call the API from either server or client.
Where the token is stored is the frontend's decision.

# Deny by default

`JwtAuthGuard` is registered as an `APP_GUARD`, so **every** route needs a
valid access token unless it is marked `@Public()`. The inverse arrangement —
opt-in protection — leaks a new controller the first time someone forgets the
decorator, and forgetting is the normal case.

Currently public: the leftover `GET /` and `GET /enums` (the 비로그인 홈 needs
it). A new login's login and refresh routes will be public too.
Swagger UI is not a Nest route, so the guard never sees it; it is closed in
production by the `APP_ENV` check in `main.ts` instead.

`@UserTypes('admin')` narrows a route to one kind of token (403 otherwise);
without it, any authenticated caller passes — so a route for 관리자 웹 only
must say so. An **empty** list (`@UserTypes()`) denies everyone rather than
allowing everyone: a decorator that looks like a restriction must not be a
no-op when its argument is forgotten. `@CurrentUser()` injects
`{id, type, email}` from the verified payload.

The `Authorization` scheme is matched case-insensitively, as RFC 7235 §2.1
requires — proxies do normalise header casing.

# Tokens — what a new login must keep

The sample login worked these out and was tested against them; the code went
with the samples (it is in git history before the cleanup), the rules did not.
Both new logins should follow them.

Access tokens short-lived, refresh tokens long-lived, both signed with the same
`JWT_SECRET` (HS256) and separated by a `typ` claim — the guard already rejects
anything but `typ: 'access'`, which is what stops a stolen refresh token from
being used as a bearer token.[^jwt-auth-guard] The sample used 15 minutes and 7
days; the agreed lifetimes differ per client (관리자 웹 access 1 hour and refresh
1 hour after last use, 직원 근무 앱 30 days after last use — see
[Naming conventions](/conventions/naming.md)).

Each issue needs a random `jti`. Without it, two issues inside the same second
produce byte-identical tokens, and rotation silently becomes a no-op.

Store the refresh token's sha256, never the token.[^password] That makes logout
and forced expiry possible and turns a leaked database into hashes. Rotate with
a single conditional write — the previous hash in the `where` — and decide
**only** there: comparing a hash read a moment earlier lets two concurrent
refreshes both pass. Zero rows matched means the token was already spent, a
replay or the losing half of a race; the two cannot be told apart and the first
is theft, so end the whole session rather than just the request. Both schemas
now have a session table for this — 1팀 `admin_sessions`, 3팀 `auth_sessions`
(one row per device) — instead of the sample's one hash per user row.

`JWT_SECRET` has no default **and is checked for length** — 32 bytes minimum,
enforced in `readJwtSecret`.[^jwt-secret] HS256 accepts a key of any size and
will happily sign with one byte, so an unchecked deployment can be broken from
a single captured token and used to forge any identity. Both an absent and a
too-short value throw during module construction rather than booting a server
whose tokens anyone can forge.

# Rate limiting

Login and refresh routes are reachable without a token, and each login spends
~30 ms of scrypt on libuv's four-thread pool. `AuthModule` registers the limits
on two axes; a login controller opts in with `@UseGuards(ThrottlerGuard)` — no
controller does today.[^throttle] Both are needed:
an IP limit alone misses a botnet grinding one account, and an account limit
alone misses a single host cycling e-mail addresses to burn CPU. Requests over
the limit are refused by the guard, before the handler and therefore before
scrypt — measured at 1 ms against 40 ms for an accepted attempt.

Counters live in process memory, so a second instance doubles the effective
limit; a shared store is the fix when there is more than one.

# Passwords

scrypt from Node's `crypto`, stored as
`scrypt$<N>$<r>$<p>$<salt-b64>$<key-b64>`.[^password] No bcrypt/argon2
dependency was added. The cost parameters are written into the stored value and
read back on verify, and they are passed explicitly rather than left to Node's
defaults — otherwise raising the cost (or Node changing its defaults) locks out
every existing account with no way to tell which parameters produced a key.

For a new login: wrong password and unknown account must return the same message
**and take the same time** — when no row is found, run the comparison against a
dummy hash anyway.
Matching only the message is not enough — skipping the ~30 ms derivation for
unknown emails answers "is this address registered?" through response latency. Normalise the login key to lowercase on the way in and keep a CHECK on the column
(3팀 `accounts_email_lower` does) — otherwise two rows differing only in case
pass the unique index and login depends on how the user typed it.

[^jwt-auth-guard]: Global guard (bearer parsing, token type, user type)
[^password]: scrypt password hashing and token hashing
[^jwt-secret]: Signing key validation at startup
[^throttle]: Login rate limiting (IP and account axes)
[^auth-types]: UserType slot and token payload
