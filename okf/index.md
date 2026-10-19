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
* [Contracts API](/api/contracts-api.md) - `GET` · `POST /contracts` (list, 근로계약서 초안 저장), 임시저장 이어 쓰기 · 삭제, and `GET /stores/options`; admin tokens only, filtered by the admin scope. The worked example for new modules.
* [Authentication](/api/auth.md) - 직원 근무 앱 login (login · refresh · logout, per-device sessions, 5-wrong-attempts lock), PIN password reset, and the deny-by-default guard that checks the session on every request.
* [BP signup (관리자 웹 회원가입)](/api/admin-signup.md) - POST /auth/signup creates a BP and its BP 마스터 in one transaction, records the two 약관 agreements, mails after commit, and returns a 10-minute signup token; 사업자 인증 and the session exchange come later.
* [Public 약관 API](/api/terms-versions.md) - GET /public-terms-versions (list) and /{termsTypeCode} (with Markdown body) without login; tabs follow 공통코드 TERMS_TYPE and the version shown is the one signup records.
* [Admin authentication](/api/admin-auth.md) - 관리자 웹 login over admin_sessions, temporary-password issuance and login, login-info (account · menus · stores · codes) fetched once per login, per-request menu-permission guard, the public 공통코드 API (platform BP only), and the 플랫폼 마스터's BP store list.
* [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) - Shared AlimtalkService reading ALIMTALK rows of notification_templates, one alimtalk_send_logs row per attempt, SMS fallback; accepted is not delivered, and templates must match Kakao exactly.
* [Mail (Gmail SMTP)](/api/mail.md) - Shared MailService: fills an EMAIL template's HTML, sends through Gmail, and logs every attempt to mail_send_logs with caller-chosen masking.
* [Attachment storage (S3)](/api/storage.md) - Shared StorageService: content-checked server-side upload, 5-minute presigned downloads, `{domain}/{id}/{uuid}.{ext}` keys in the bucket shared with 1차; no S3 settings means attachments return 503.
* [Platform admins](/api/platform-admins.md) - 관리자 웹 플랫폼 관리자 관리: menu CRUD permission plus master and self protection, one active master kept under a row lock, and a first password that only travels by mail.
* [Platform role groups](/api/platform-role-groups.md) - 관리자 웹 플랫폼 권한 관리(MN000214): the seeded fixed roles (PM · BM · FM — no PA) and PA 추가 권한, per-menu CRUD capped by the caller's own rights, BP · 가맹 마스터 revocation cascading into every BA · FA group, and deletion that moves linked admins to a replacement.
* [Notification templates](/api/notification-templates.md) - 알림 템플릿 관리 API: 운영 알림 · 앱 푸시 · 메일 · 알림톡 문구 수정 · 등록 · 되돌리기와 저장 검사.
* [Operations notifications](/api/notifications-api.md) - 운영 알림: 업무 쪽이 부르는 공통 함수 notify와 수신자 판정, 관리자 웹 운영 알림함 API.
* [Staff member list](/api/staff-members.md) - GET /staff-members: the 관리자 웹 직원 목록 in one call, derived 가입·인증 상태, 본사 제공 동의 masking.
* [Staff retirement](/api/staff-retirement.md) - 관리자 퇴직 처리: the date is stored now and a midnight KST batch makes the record RETIRED the next day, clearing schedules, personal TO-DOs and unsigned contracts; contracts are never shortened.
* [Inquiry and lead handling](/api/inquiries.md) - 커뮤니티 관리 문의사항 · 도입문의 처리: platform-admin-only processing · reply · internal memo, concurrent saves are caught by an UPDATE conditioned on the updatedAt the operator read, only the first inquiry reply notifies the author (ops notification + mail).
* [Store management](/api/stores.md) - 관리자 웹 점포 정보 관리(MN000002): list · register · edit · status change · delete of 1팀 stores, 대표 이미지 upload and 엑셀 바로 받기; one-way 미운영 → 운영 → 폐점, operating needs 사업자 인증 and coordinates, the 사업자등록번호 is unique among live stores under an advisory lock, and the 국세청 check uses the same client as BP signup.
* [Notices and FAQ management](/api/posts.md) - 공지사항 · FAQ: platform-admin-only /posts CRUD (publishing needs an audience, concurrent edits are caught by an UPDATE conditioned on the updatedAt the editor read, deletion is a flag), plus the reading side — /public-posts for guests and /support-posts for signed-in admins, filtered by audience, status and KST publish window.
* [TO-DO](/api/todos.md) - 관리자 웹 TO-DO 리스트 관리(MN000026) · 직원 상세 · 직원 근무 앱 TO-DO: 배정 그룹 펼치기(첫 행 ID 가 그룹 ID), 업무 범위 밖 404, 한 명 수행 완료 선점(조건부 UPDATE, 409 TODO_ALREADY_DONE), 대기만 지우는 삭제, 5분마다 도는 수행 임박 알림(dedupe_key 에 수행 예정 일시, 앱 푸시는 발송 대기 행만).

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
