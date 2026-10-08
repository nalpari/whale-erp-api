---
okf_version: "0.2"
---

# Whale ERP API — Knowledge Bundle

Knowledge about the `whale-erp-api` service: what it is, and the conventions
that govern how code is written in it.

The service runs on NestJS 11 over PostgreSQL via Prisma. The template's samples
(items, staff/customer login) were removed on 2026-10-07; the first real domain
module becomes the worked example.

# Service

* [Whale ERP API](/api/whale-erp-api.md) - NestJS 11 HTTP service backed by PostgreSQL through Prisma.
* [Items API](/api/items-api.md) - (deprecated) The removed template sample.
* [Authentication](/api/auth.md) - 직원 근무 앱 login (login · refresh · logout, per-device sessions, 5-wrong-attempts lock), PIN password reset, and the deny-by-default guard that checks the session on every request; 관리자 웹 login still to come.
* [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) - Shared AlimtalkService reading ALIMTALK rows of notification_templates, one alimtalk_send_logs row per attempt, SMS fallback; accepted is not delivered, and templates must match Kakao exactly.
* [Mail (Gmail SMTP)](/api/mail.md) - Shared MailService: fills an EMAIL template's HTML, sends through Gmail, and logs every attempt to mail_send_logs with caller-chosen masking.

# Design

* [Employment Contract Batch (Expiry & Reminder)](/api/employment-contract-batch.md) - Multi-instance-safe batch design for contract auto-expiry and expiry reminders via a PostgreSQL advisory lock; not yet implemented.

# Conventions

* [Testing conventions](/conventions/testing.md) - API code is written test-first; two separate Jest configurations split unit tests from e2e tests by directory.
* [TypeScript and lint conventions](/conventions/typescript.md) - Deliberately loose compiler strictness and the ESLint/Prettier rules that back it.
* [Naming conventions](/conventions/naming.md) - One Korean term maps to one English identifier across the three repositories; per-layer casing follows from that.

# Domain

* [Team 1 physical schema](/domain/team1-physical-schema.md) - The PostgreSQL schema for 1팀's 27 tables (auth · BP · stores · system settings) and the migrations that load its reference data; what Prisma cannot carry and why the platform master has no password.
* [Team 3 physical schema](/domain/team3-physical-schema.md) - The PostgreSQL schema for 3팀's 41 tables, generated from the logical ERD; what it depends on, what it adds, and what Prisma cannot carry.

# Not yet written

ERP domain concepts (orders, inventory, accounting) belong under a
`domain/` subdirectory once the corresponding modules exist. Attested
Computations (§10) are the right home for any financial figure the API
reports.
