# Directory Update Log

## 2026-08-31
* **Update**: [Testing conventions](/conventions/testing.md) — the single-case example no longer shows the `pnpm test -- -t` form that CLAUDE.md forbids, and the concept now says which tests belong in e2e.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) — the frontmatter description called the service a skeleton with no domain code, contradicting its own body.
* **Update**: [Authentication](/api/auth.md) — losing the rotation race now revokes the session too, the signing key is length-checked at startup, the login routes are rate limited on IP and account axes, and `user:create` no longer takes the password as an argument.
* **Update**: [Authentication](/api/auth.md) — refresh reuse now revokes the whole session, rotation became a single conditional write, login runs the password comparison even for unknown accounts, and scrypt parameters are stored in the hash.
* **Update**: [Items API](/api/items-api.md) — the item routes are staff-token-only (`@UserTypes('staff')`); a customer token gets 403.

## 2026-08-28
* **Creation**: Added the [Authentication](/api/auth.md) concept: staff/customer tables, the deny-by-default global guard, and rotating refresh tokens.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) no longer describes the service as unauthenticated; every route now needs a bearer token unless marked `@Public()`.
* **Update**: Added update and delete endpoints to [Items API](/api/items-api.md); deletion is restricted by the movement foreign key rather than cascading.
* **Update**: Narrowed id columns from bigint to integer; responses now carry numeric ids ([Items API](/api/items-api.md)).
* **Update**: Default listen port moved from 3000 to 8000 in [Whale ERP API](/api/whale-erp-api.md).
* **Update**: Noted the Swagger endpoints and their production cut-off on [Items API](/api/items-api.md).
* **Creation**: Added the [Items API](/api/items-api.md) concept covering derived stock, the row lock, and the two-layer constraints.
* **Update**: Recorded the ConfigModule wiring and the APP_ENV profile scheme in [Whale ERP API](/api/whale-erp-api.md); the service is no longer config-less.
* **Update**: Recorded the test-first policy for API code in [testing conventions](/conventions/testing.md); the directive itself lives in CLAUDE.md.
* **Initialization**: Established the bundle root, targeting OKF v0.2.
* **Creation**: Added the [Whale ERP API](/api/whale-erp-api.md) service concept.
* **Creation**: Added [testing](/conventions/testing.md) and [TypeScript/lint](/conventions/typescript.md) convention concepts.
