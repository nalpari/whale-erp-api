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
* [BP admins](/api/bp-admins.md) - 관리자 웹 BP 관리자 관리(MN000012): who sees and edits BA · FM · FA accounts by role and mapped stores, one franchise master per store, and the deactivation and store-removal cascades of a franchise master's save.
* [BP masters](/api/bp-masters.md) - 관리자 웹 BP 마스터 계정 관리(MN000203): a customer BP and its one BP 마스터 handled as a pair — register in one transaction with 공통코드 copy and a mailed first password, 사업자정보 only from a verification token, history merged from two tables, 미사용 cascading to every account of the BP, delete only for an unused 오등록, 엑셀 like stores.
* [Platform menus](/api/platform-menus.md) - 관리자 웹 플랫폼 메뉴 관리(MN000215): service tabs from 공통코드 SERVICE, the per-service menu tree, global MN code numbering with a PM000001 row for each new menu, URL overlap refused among active menus, and moves that renumber siblings and carry the subtree.
* [Excel exports](/api/excel-exports.md) - 모든 화면의 엑셀 공통: 1만 건 미만은 바로 파일, 이상은 예약 생성(배치 excel-export 가 1분마다 만들어 S3 excel-exports/ 24시간, 등록한 이메일로 관리자 웹 링크, GET /excel-downloads/:id 는 요청한 본인만 · 기한 지나면 410), 같은 사람 · 같은 화면은 생성 중 409 · 1분 1회 429, 실패는 한 번 다시 시도 뒤 실패 메일, 모든 요청을 excel_download_logs 에 2년(excel-download-purge 매일 04:30).
* [Platform holidays](/api/public-holidays.md) - 관리자 웹 플랫폼 휴일 관리(MN000217): GET /public-holidays reads a year (목록) or a month (캘린더) of 공식 휴일 with the last successful synchronization and the 올해 · 다음 해 failure flag; read-only, no write route. 매월 1일 04:00 배치 public-holiday-sync 가 공휴일 API(특일 정보)로 올해 · 다음 해를 맞춘다(API 원문 이름, API 에 없는 그 해 행 삭제 — 무효 항목이 있으면 보류, 0건은 미발표).
* [BP holidays](/api/bp-holidays.md) - 관리자 웹 BP 휴일 관리(MN000015): holidays stored as rules and computed when read, month calendar · list · detail · history · overlap check, create, update, force termination (as of yesterday) and deletion (starting today or later); past dates never change — stores join from today and leave as of yesterday as period rows.
* [Platform role groups](/api/platform-role-groups.md) - 관리자 웹 플랫폼 권한 관리(MN000214): the seeded fixed roles (PM · BM · FM — no PA) and PA 추가 권한, per-menu CRUD capped by the caller's own rights, BP · 가맹 마스터 revocation cascading into every BA · FA group, and deletion that moves linked admins to a replacement.
* [BP code groups](/api/bp-code-groups.md) - 관리자 웹 BP 공통코드 관리(MN000014): read-only groups (in-use 플랫폼고정 and 플랫폼제공 groups), the BP's own rows for 플랫폼제공 groups (copied at signup and by BP에 적용) — status set freely and deletable — BP전용 codes that may not collide with live platform originals, re-registering a deleted code restores it, platform users read a picked BP only.
* [BP role groups](/api/bp-role-groups.md) - 관리자 웹 BP 권한 그룹 관리(MN000013): BA · FA groups scoped by the caller's role, names unique per (BP, 관리계정), menu cells capped by the fixed role ∩ the caller's rights; the screen combines menu rights with the api's role flags.
* [Notification templates](/api/notification-templates.md) - 알림 템플릿 관리 API: 운영 알림 · 앱 푸시 · 메일 · 알림톡 문구 수정 · 등록 · 되돌리기와 저장 검사.
* [Operations notifications](/api/notifications-api.md) - 운영 알림: 업무 쪽이 부르는 공통 함수 notify와 수신자 판정, 관리자 웹 운영 알림함 API.
* [Staff signup (직원 앱 가입)](/api/staff-signup.md) - POST /auth/account/invitations/check finds a live 가입 초대 by link token or phone + 초대 코드; POST /auth/account/signup creates the account on the invitation's phone, links the 직원 레코드, accepts the invitation, moves the waiting 근로계약 to 서명 대기 and returns a login session — 만 19세 미만 stops with 가입 불가 and an 운영 알림.
* [Staff member list](/api/staff-members.md) - GET /staff-members: the 관리자 웹 직원 목록 in one call, derived 가입·인증 상태, 본사 제공 동의 masking.
* [Staff retirement](/api/staff-retirement.md) - 관리자 퇴직 처리: the date is stored now and a midnight KST batch makes the record RETIRED the next day, clearing schedules, personal TO-DOs and unsigned contracts; contracts are never shortened.
* [Payslip list, detail and draft creation](/api/payslips.md) - GET /payslips(관리자 웹 급여명세서 목록 · 상세, 상태 건수, 본사 제공 동의 가림), POST /payslips · /payslips/bulk · GET /payslips/candidates(초안 작성) and GET /me/payslips(직원 근무 앱 — 발송된 내 명세서, 퇴직 뒤에도 3년).
* [Inquiry and lead handling](/api/inquiries.md) - 커뮤니티 관리 문의사항 · 도입문의 처리: platform-admin-only processing · reply · internal memo, concurrent saves are caught by an UPDATE conditioned on the updatedAt the operator read, only the first inquiry reply notifies the author (ops notification + mail).
* [Store management](/api/stores.md) - 관리자 웹 점포 정보 관리(MN000002): list · register · edit · status change · delete of 1팀 stores, 대표 이미지 upload and 엑셀 바로 받기; one-way 미운영 → 운영 → 폐점, operating needs 사업자 인증 and coordinates, the 사업자등록번호 is unique among live stores under an advisory lock, and the 국세청 check uses the same client as BP signup.
* [Notices and FAQ management](/api/posts.md) - 공지사항 · FAQ: platform-admin-only /posts CRUD (publishing needs an audience, concurrent edits are caught by an UPDATE conditioned on the updatedAt the editor read, deletion is a flag), plus the reading side — /public-posts for guests and /support-posts for signed-in admins, filtered by audience, status and KST publish window.
* [My profile (staff app)](/api/my-profile.md) - 직원 근무 앱 마이페이지: GET /me/profile(계정 칸 · 계정의 본사 제공 동의 · 위치정보 동의 상태), GET /me/memberships(재직 직원 기준 소속 근무지), 소속별 신고 정보(가린 주민등록번호 · 급여 계좌), 개인정보 칸의 AES-256-GCM 형식과 행 id 를 담은 AAD.
* [TO-DO](/api/todos.md) - 관리자 웹 TO-DO 리스트 관리(MN000026) · 직원 상세 · 직원 근무 앱 TO-DO: 배정 그룹 펼치기(첫 행 ID 가 그룹 ID), 업무 범위 밖 404, 한 명 수행 완료 선점(조건부 UPDATE, 409 TODO_ALREADY_DONE), 대기만 지우는 삭제, 5분마다 도는 수행 임박 알림(dedupe_key 에 수행 예정 일시, 앱 푸시는 발송 대기 행만).
* [Work schedules](/api/work-schedules.md) - 관리자 웹 근무스케줄 관리(/work-schedules, MN000010) 주간 · 월간 조회(30분 칸 인원, 자정 넘김은 다음 날 새벽 칸에도) · 등록 · 수정 · 삭제: 근무일 + 30분 단위 시각(자정 넘김, 근무일은 시작한 날), 같은 직원 레코드 겹침 409(EXCLUDE), 근무일 기준 계약 기간 · 가입 완료 · 퇴직일 판정, 변경 이력(조회 포함), 일괄 등록 · 지난 주 복사, 저장마다 그 직원에게 앱 푸시(수신 설정을 끄면 알림함에만).
* [Attendance](/api/attendance.md) - 직원 근무 앱 출퇴근(WHALEERP-207): GET /me/attendance · POST check-in · check-out(고른 근무지, 반경 100m 고정, 계정 행 잠금, 좌표 없이 확인 필요 사유만, 열린 출근은 계정에 하나, 계약 기간 밖 출근 422), 확인 필요 사유(반경 밖 출근 · 반경 밖 퇴근 · 위치 조작 감지, 위치 오차 초과는 안 씀), 3년 보존 뒤 파기 배치 attendance-purge(수신 시각 기준, 짝 출근 · 확인자료 연결을 비우고 보정 이력과 함께 지움).

# Design

* [Employment Contract Batch (Expiry & Reminder)](/api/employment-contract-batch.md) - Multi-instance-safe batch design for contract auto-expiry and expiry reminders via a PostgreSQL advisory lock; not yet implemented.

# Conventions

* [Testing conventions](/conventions/testing.md) - API code is written test-first; two separate Jest configurations split unit tests from e2e tests by directory.
* [TypeScript and lint conventions](/conventions/typescript.md) - Deliberately loose compiler strictness and the ESLint/Prettier rules that back it.
* [Naming conventions](/conventions/naming.md) - One Korean term maps to one English identifier across the three repositories; per-layer casing follows from that.

# Domain

* [Team 1 physical schema](/domain/team1-physical-schema.md) - The PostgreSQL schema for 1팀's 27 tables (auth · BP · stores · system settings) and the migrations that load its reference data; what Prisma cannot carry and why the platform master has no password.
* [Team 3 physical schema](/domain/team3-physical-schema.md) - The PostgreSQL schema for 3팀's 48 tables, generated from the logical ERD; what it depends on, what it adds, and what Prisma cannot carry.

# Not yet written

ERP domain concepts (orders, inventory, accounting) belong under a
`domain/` subdirectory once the corresponding modules exist. Attested
Computations (§10) are the right home for any financial figure the API
reports.
