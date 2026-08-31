---
type: API
title: Authentication
description: JWT bearer authentication for the staff and customer clients; deny-by-default global guard with rotating refresh tokens.
tags: [auth, jwt, security, nestjs]
status: stable
generated: { by: claude-code/opus-5, at: 2026-08-31T01:49:15Z }
sources:
  - id: auth-service
    resource: ../../src/auth/auth.service.ts
    title: Token issue, refresh rotation, logout
    last_modified: 2026-08-31T01:49:15Z
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
  - id: auth-migration
    resource: ../../prisma/migrations/20260828120000_auth_staff_customers/migration.sql
    title: staff and customers tables
    last_modified: 2026-08-31T01:49:15Z
---

# What it is

Two clients call this API: `whale-erp-staff` (internal) and `whale-erp-front`
(customer-facing). Each authenticates against its own table — `staff` and
`customers` — and receives a JWT pair.[^auth-migration] The two tables carry
identical columns, which invites merging them into one table with a `role`
column; they are kept apart because the login endpoints and the access scope
differ, and a shared table makes "customer that can reach staff data" a
one-line mistake rather than an impossible one.

Requests carry `Authorization: Bearer <accessToken>`. There is no cookie, so
CORS stays simple and Next.js can call the API from either server or client.
Where the token is stored is the frontend's decision.

# Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /auth/staff/login` | public | `{email, password}` → token pair + user |
| `POST /auth/customer/login` | public | same, against `customers` |
| `POST /auth/refresh` | public | `{refreshToken}` → **new** pair; the old refresh token dies |
| `POST /auth/logout` | bearer | clears the stored refresh hash; 204 |

Login answers `200`, not `201` — it creates no resource.

The bearer requirement is declared per controller in the OpenAPI document, not
globally: a global `security` requirement would mark the login and refresh
routes — the only way to obtain a token — as needing one, and generated clients
would attach an `Authorization` header to login.

There is no signup endpoint. Accounts are made with
`pnpm user:create <staff|customer> <email> <name>`, which upserts, so
re-running it resets a password. The password is never passed as an argument —
it is prompted with the echo turned off, or read from stdin when piped. An
argv password survives in shell history, in `ps` output, and in CI logs.

# Deny by default

`JwtAuthGuard` is registered as an `APP_GUARD`, so **every** route needs a
valid access token unless it is marked `@Public()`. The inverse arrangement —
opt-in protection — leaks a new controller the first time someone forgets the
decorator, and forgetting is the normal case.

Currently public: the login and refresh routes, and the leftover `GET /`.
Swagger UI is not a Nest route, so the guard never sees it; it is closed in
production by the `APP_ENV` check in `main.ts` instead.

`@UserTypes('staff')` narrows a route to one kind of token (403 otherwise);
without it, any authenticated caller passes — which is why `ItemsController`
carries it. An **empty** list (`@UserTypes()`) denies everyone rather than
allowing everyone: a decorator that looks like a restriction must not be a
no-op when its argument is forgotten. `@CurrentUser()` injects
`{id, type, email}` from the verified payload.

The `Authorization` scheme is matched case-insensitively, as RFC 7235 §2.1
requires — proxies do normalise header casing.

# Tokens

Access lives 15 minutes, refresh 7 days; both are signed with the same
`JWT_SECRET` (HS256) and separated by a `typ` claim.[^auth-service] The claim
is what stops a stolen refresh token — the long-lived one — from being used as
a bearer token against the API.

Each issue includes a random `jti`. Without it, two issues inside the same
second produce byte-identical tokens (same payload, same `iat`), and rotation
silently becomes a no-op: the "replaced" token still validates.

The refresh token's sha256 is stored on the user row.[^password] Three
consequences:

* Logout and forced expiry are possible at all — a purely stateless refresh
  token cannot be revoked.
* A leaked database yields hashes, not usable tokens.
* Rotation is a single conditional write (`updateMany` with the previous hash
  in the `where`), and the decision is made **only** there. Comparing the hash
  read a moment earlier does not work: two concurrent refreshes with the same
  token both pass that read.
* Matching zero rows means the presented token was already spent — a replay of
  a rotated token, or the losing half of a concurrent pair. The two cannot be
  told apart, and the first is a theft signal, so the stored hash is cleared
  and the whole session dies. Rejecting only the failed request would bounce
  the legitimate user while whoever spent the token first — possibly the thief
  — keeps the account. The price is that a client firing two refreshes at once
  logs itself out; serialising refreshes is the client's job.
* Only one device stays logged in per account. Multiple devices need a separate
  `refresh_tokens` table.

`JWT_SECRET` has no default **and is checked for length** — 32 bytes minimum,
enforced in `readJwtSecret`.[^jwt-secret] HS256 accepts a key of any size and
will happily sign with one byte, so an unchecked deployment can be broken from
a single captured token and used to forge a staff identity. Both an absent and
a too-short value throw during module construction rather than booting a server
whose tokens anyone can forge.

# Rate limiting

The login and refresh routes are the only ones reachable without a token, and
each login spends ~30 ms of scrypt on libuv's four-thread pool. `AuthController`
carries a `ThrottlerGuard` configured on two axes.[^throttle] Both are needed:
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

Wrong password and unknown account return the same message **and take the same
time**: when no row is found, the comparison runs against a dummy hash anyway.
Matching only the message is not enough — skipping the ~30 ms derivation for
unknown emails answers "is this address registered?" through response latency. Email is normalised to lowercase on the
way in, and a CHECK constraint keeps the column lowercase — otherwise two rows
differing only in case pass the unique index and login depends on how the user
typed it.

[^auth-service]: Token issue, refresh rotation, logout
[^jwt-auth-guard]: Global guard (bearer parsing, token type, user type)
[^password]: scrypt password hashing and token hashing
[^jwt-secret]: Signing key validation at startup
[^throttle]: Login rate limiting (IP and account axes)
[^auth-migration]: staff and customers tables
