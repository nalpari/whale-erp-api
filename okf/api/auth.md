---
type: API
title: Authentication
description: JWT bearer authentication for the staff and customer clients; deny-by-default global guard with rotating refresh tokens.
tags: [auth, jwt, security, nestjs]
status: stable
generated: { by: claude-code/opus-5, at: 2026-08-28T08:00:53Z }
sources:
  - id: auth-service
    resource: ../../src/auth/auth.service.ts
    title: Token issue, refresh rotation, logout
    last_modified: 2026-08-28T08:00:00Z
  - id: jwt-auth-guard
    resource: ../../src/auth/jwt-auth.guard.ts
    title: Global guard (bearer parsing, token type, user type)
    last_modified: 2026-08-28T08:00:00Z
  - id: password
    resource: ../../src/auth/password.ts
    title: scrypt password hashing and token hashing
    last_modified: 2026-08-28T08:00:00Z
  - id: auth-migration
    resource: ../../prisma/migrations/20260828120000_auth_staff_customers/migration.sql
    title: staff and customers tables
    last_modified: 2026-08-28T08:00:00Z
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

There is no signup endpoint. Accounts are made with
`pnpm user:create <staff|customer> <email> <password> <name>`, which upserts,
so re-running it resets a password.

# Deny by default

`JwtAuthGuard` is registered as an `APP_GUARD`, so **every** route needs a
valid access token unless it is marked `@Public()`. The inverse arrangement —
opt-in protection — leaks a new controller the first time someone forgets the
decorator, and forgetting is the normal case.

Currently public: the login and refresh routes, and the leftover `GET /`.
Swagger UI is not a Nest route, so the guard never sees it; it is closed in
production by the `APP_ENV` check in `main.ts` instead.

`@UserTypes('staff')` narrows a route to one kind of token (403 otherwise);
without it, any authenticated caller passes. `@CurrentUser()` injects
`{id, type, email}` from the verified payload.

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
* Only the newest refresh token works, so a replayed one is rejected — but
  also only one device stays logged in per account. Multiple devices need a
  separate `refresh_tokens` table.

`JWT_SECRET` has no default. A missing value throws during module
construction rather than booting a server that signs tokens anyone can forge.

# Passwords

scrypt from Node's `crypto`, stored as `scrypt$<salt-b64>$<key-b64>`.[^password]
No bcrypt/argon2 dependency was added; the scheme prefix is what lets a future
parameter change coexist with old hashes.

Wrong password and unknown account return the same message, so the response
cannot be used to enumerate accounts. Email is normalised to lowercase on the
way in, and a CHECK constraint keeps the column lowercase — otherwise two rows
differing only in case pass the unique index and login depends on how the user
typed it.

[^auth-service]: Token issue, refresh rotation, logout
[^jwt-auth-guard]: Global guard (bearer parsing, token type, user type)
[^password]: scrypt password hashing and token hashing
[^auth-migration]: staff and customers tables
