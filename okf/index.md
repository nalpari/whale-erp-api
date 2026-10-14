---
okf_version: "0.2"
---

# Whale ERP API — Knowledge Bundle

Knowledge about the `whale-erp-api` service: what it is, and the conventions
that govern how code is written in it.

The service runs on NestJS 11 over PostgreSQL via Prisma. The template's samples
(items, staff/customer login) were removed on 2026-10-07; the worked example for list
responses is the [staff member list](/api/staff-members.md).

# Service

* [Whale ERP API](/api/whale-erp-api.md) - NestJS 11 HTTP service backed by PostgreSQL through Prisma.
* [Items API](/api/items-api.md) - (deprecated) The removed template sample.
* [Contracts API](/api/contracts-api.md) - `GET` · `POST /contracts` (list, 근로계약서 초안 저장), 임시저장 이어 쓰기 · 삭제, and `GET /stores`; admin tokens only, no scope filter until login. The worked example for new modules.
* [Authentication](/api/auth.md) - 직원 근무 앱 login (login · refresh · logout, per-device sessions, 5-wrong-attempts lock), PIN password reset, and the deny-by-default guard that checks the session on every request.
* [BP signup (관리자 웹 회원가입)](/api/admin-signup.md) - POST /auth/signup creates a BP and its BP 마스터 in one transaction, records the two 약관 agreements, mails after commit, and returns a 10-minute signup token; 사업자 인증 and the session exchange come later.
* [Admin authentication](/api/admin-auth.md) - 관리자 웹 login over admin_sessions, temporary-password issuance and login, login-info (account · menus · stores · codes) fetched once per login, per-request menu-permission guard, the public 공통코드 API (platform BP only), and the 플랫폼 마스터's BP store list.
* [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) - Shared AlimtalkService reading ALIMTALK rows of notification_templates, one alimtalk_send_logs row per attempt, SMS fallback; accepted is not delivered, and templates must match Kakao exactly.
* [Mail (Gmail SMTP)](/api/mail.md) - Shared MailService: fills an EMAIL template's HTML, sends through Gmail, and logs every attempt to mail_send_logs with caller-chosen masking.
* [Attachment storage (S3)](/api/storage.md) - Shared StorageService: content-checked server-side upload, 5-minute presigned downloads, `{domain}/{id}/{uuid}.{ext}` keys in the bucket shared with 1차; no S3 settings means attachments return 503.
* [Platform admins](/api/platform-admins.md) - 관리자 웹 플랫폼 관리자 관리: menu CRUD permission plus master and self protection, one active master kept under a row lock, and a first password that only travels by mail.
* [Notification templates](/api/notification-templates.md) - 알림 템플릿 관리 API: 운영 알림 · 앱 푸시 · 메일 · 알림톡 문구 수정 · 등록 · 되돌리기와 저장 검사.
* [Operations notifications](/api/notifications-api.md) - 운영 알림: 업무 쪽이 부르는 공통 함수 notify와 수신자 판정, 관리자 웹 운영 알림함 API.
* [Staff member list](/api/staff-members.md) - GET /staff-members: the 관리자 웹 직원 목록 in one call, derived 가입·인증 상태, 본사 제공 동의 masking.
* [Staff retirement](/api/staff-retirement.md) - 관리자 퇴직 처리: the date is stored now and a midnight KST batch makes the record RETIRED the next day, clearing schedules, personal TO-DOs and unsigned contracts; contracts are never shortened.
* [Inquiry and lead handling](/api/inquiries.md) - 커뮤니티 관리 문의사항 · 도입문의 처리: platform-admin-only processing · reply · internal memo, concurrent saves are caught by an UPDATE conditioned on the updatedAt the operator read, only the first inquiry reply notifies the author (ops notification + mail).
* [Notices and FAQ management](/api/posts.md) - 커뮤니티 관리 공지사항 · FAQ: platform-admin-only /posts CRUD, publishing needs an audience, concurrent edits are caught by an UPDATE conditioned on the updatedAt the editor read, deletion is a flag.

# Design

* [Employment Contract Batch (Expiry & Reminder)](/api/employment-contract-batch.md) - Multi-instance-safe batch design for contract auto-expiry and expiry reminders via a PostgreSQL advisory lock; not yet implemented.

# Conventions

* [Testing conventions](/conventions/testing.md) - API code is written test-first; two separate Jest configurations split unit tests from e2e tests by directory.
* [TypeScript and lint conventions](/conventions/typescript.md) - Deliberately loose compiler strictness and the ESLint/Prettier rules that back it.
* [Naming conventions](/conventions/naming.md) - One Korean term maps to one English identifier across the three repositories; per-layer casing follows from that.

# Domain

* [Team 1 physical schema](/domain/team1-physical-schema.md) - The PostgreSQL schema for 1팀's 27 tables (auth · BP · stores · system settings) and the migrations that load its reference data; what Prisma cannot carry and why the platform master has no password.
* [Team 3 physical schema](/domain/team3-physical-schema.md) - The PostgreSQL schema for 3팀's 47 tables, generated from the logical ERD; what it depends on, what it adds, and what Prisma cannot carry.

# Not yet written

ERP domain concepts (orders, inventory, accounting) belong under a
`domain/` subdirectory once the corresponding modules exist. Attested
Computations (§10) are the right home for any financial figure the API
reports.
