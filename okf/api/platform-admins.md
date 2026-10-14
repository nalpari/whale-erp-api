---
type: API
title: Platform admins
description: 관리자 웹 「플랫폼 관리자 관리」 — list, register, edit, delete and password reset of 플랫폼 마스터 · 플랫폼 관리자 accounts, judged by the menu's CRUD permission plus master and self protection; the first password only ever travels by mail.
tags: [admin, account, permission, mail]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-14T05:00:00Z }
sources:
  - id: platform-admins-service
    resource: ../../src/platform-admins/platform-admins.service.ts
    title: PlatformAdminsService (list · roleGroups · detail · histories · create · update · remove · resetPassword)
    last_modified: 2026-10-14T02:20:00Z
  - id: platform-admin-mail
    resource: ../../src/platform-admins/platform-admin-mail.ts
    title: createPlatformAdminMail — the password-mail sender, or none without MAIL_* · ADMIN_WEB_URL
    last_modified: 2026-10-14T01:20:18Z
  - id: platform-admins-controller
    resource: ../../src/platform-admins/platform-admins.controller.ts
    title: /platform-admins routes and the MN000213 permission per action
    last_modified: 2026-10-14T05:00:00Z
  - id: menu-permissions
    resource: ../../src/menu-permissions/menu-permissions.service.ts
    title: MenuPermissionsService — role_group_menus CRUD flags, active accounts only
    last_modified: 2026-10-14T05:00:00Z
  - id: admin-web-url
    resource: ../../src/common/admin-web-url.ts
    title: ADMIN_WEB_URL — 관리자 웹 주소, the mail button target (one rule for every mail)
    last_modified: 2026-10-14T01:20:18Z
---

# What it covers

The 관리자 웹 menu MN000213 「플랫폼 관리자 관리」 (`/platform/system/admins`):
list S-YTKWGG, register S-FOJJKB, detail S-BRSPGB, edit S-CZGHBS, 계정 삭제
S-NLVXWJ and 비밀번호 초기화 S-XKYOND. It manages 1팀's `admin_accounts` rows
whose `role_type_code` is `PM` or `PA` — never BP-side accounts — and a deleted
row (`is_deleted`) is gone from every route, detail included (404). So is a
`WITHDRAWN` one: this screen has no 탈퇴, and letting it reach a withdrawn row
would have an edit revive it as 사용 and write a history with no label for the old
status.[^platform-admins-service]

| Route | Menu permission |
|---|---|
| `GET /platform-admins` | 조회 — `{ items, total, inactiveCount }`, newest first. `inactiveCount` ignores the status filter (keyword and role still apply), so 「미사용 N」 shows even while only 사용 is selected |
| `GET /platform-admins/role-groups` | 조회 — the 사용자 권한 choices |
| `GET /platform-admins/:id`, `GET /platform-admins/:id/histories` | 조회 |
| `GET /platform-admins/login-id-availability?loginId=` | 등록 — `{ available }`. 등록 화면이 아이디 칸을 벗어나거나 Enter 를 칠 때 묻는다. 삭제한 계정의 아이디도 쓸 수 없다고 답한다. `:id` 보다 앞에 둔다 |
| `POST /platform-admins` | 등록 |
| `PUT /platform-admins/:id` | 수정 |
| `POST /platform-admins/:id/password-reset` | 수정 — `{ isMailSent, updatedAt }`. The reset moves `updatedAt`, so the detail screen saves its next edit with this value. It is always present |
| `DELETE /platform-admins/:id` | 삭제 |

# Three checks, in this order

**Menu permission first.** `MenuPermissionsService.assert(adminAccountId,
'MN000213', action)` reads the caller's role group's `role_group_menus` row on
every request, so a permission change applies from the next request without a
re-login.[^menu-permissions] It also refuses a caller that is deleted or not
`ACTIVE` — admin tokens have no session table behind them, so the guard never
reads the account, and this is the one place a 미사용 admin is stopped.
`MenuPermissionsService` is general; the next 관리자 웹 menu should use it rather
than re-deriving a role check (공통코드 still checks PM · PA directly).

**And the caller must be a platform account.** After the menu check the
controller refuses any caller whose `role_type_code` is not `PM` or `PA` (403).
Nothing in the data stops a 권한 그룹 of a BP from being given the MN000213 row, and
master protection reads "not `PM`" as `PA` — without this, a BP account holding
that row would manage platform admins with PA's powers. `MenuPermissionsService`
stays generic; the restriction belongs to this menu.

**Then master protection.** A `PM` account is edited, deleted and reset only by
a `PM`, and a `PA` can neither register a `PM` nor hand out a `PM` role group —
`GET /role-groups` already leaves `PM` groups out for a `PA`, and the server
refuses them anyway.

Delete and reset judge a row they read earlier, so their write is an
`updateMany` that also requires the row to be undeleted and to still have the
`role_type_code` that was judged — a reset also the `email` it read, so a password
never goes to an address that was replaced meanwhile. If a PM promoted the target
or someone deleted it in between, zero rows match and the answer is 409 with nothing written — no
second `계정 → 삭제` history, no temporary password issued for an account that has
since become a master.

**Then self protection.** On your own account you edit basic information only:
role group and status are refused (403), and you cannot delete yourself or reset
your own password here (내 정보 does that).

# One active master must remain

Making a `PM` 미사용, demoting it to a `PA` group, or deleting it first locks
every active `PM` row (`SELECT … FOR NO KEY UPDATE`) and counts the others. Two
masters demoting each other at once queue on the lock, and the later one re-reads
the first's change through its `WHERE`, so the count never reaches zero. The check
is 409, not a disabled button — the screen does not pre-empt it.

**`FOR NO KEY UPDATE`, not `FOR UPDATE`.** `admin_accounts.updated_by` is a
foreign key into the same table, so any edit that names a PM as its editor takes
`FOR KEY SHARE` on that PM's row. `FOR UPDATE` conflicts with it, and a count
waiting on one PM while that edit waits on another deadlocks (40P01, a 500).
`FOR NO KEY UPDATE` lets the key check through and still serialises the counts
against each other.

# Edits are compared, not overwritten

`PUT` carries the `updatedAt` the detail returned, and the update is one
`updateMany` that requires `updated_at` to fall in **that millisecond**
(`gte t, lt t + 1ms`). Zero rows means someone saved in between, and the answer
is 409 with nothing written. Do not "simplify" it to equality: the column keeps
microseconds and a JS `Date` only milliseconds, so a row written by an SQL default
— the seeded `whaleadmin` among them — would never match and every save would be
409. Writes through Prisma land on whole milliseconds and match either way. Each changed field becomes
one `admin_change_histories` row (이름, 연락처, 이메일, 소속 부서, 직책, 주소,
사용자 권한 as `name code`, 계정 상태 as 사용/미사용); unchanged fields write
nothing. Creation writes `계정 → 사용 · 권한`, deletion `계정 → 삭제`, a reset
`초기 비밀번호 → 초기화`. Every one of them is written in the same transaction as
the change it records — a reset is a security event kept five years, and an audit
row written after the commit could be lost to one failed write. Whether the mail
went out is not history: the unsent flag and `mail_send_logs` carry it. Passwords
are never written there.

# The first password only travels by mail

A registered account is `ACTIVE`, `PLATFORM_REGISTERED`, and its
`password_hash` is `'!'` — no password logs in (the same convention as the seeded
master). A 12-character password (upper, lower and digit, no look-alike glyphs, so
it always passes the new-password rule) goes into `temporary_passwords` as
`INITIAL` for one hour, and only the mail carries it; `mail_send_logs` keeps it
masked. A reset does the same with `RESET`, invalidates any unused earlier one,
and sets `password_hash` back to `'!'` so the old password stops working at once.
Sessions are not cut and the status does not change.

**Unsent until proven sent.** Registration and reset both write
`is_initial_password_unsent = true` inside their transaction, and only a mail that
went out clears it afterwards. A failed mail therefore needs no further write: the
account (or the reset) stays and the list shows 「초기 비밀번호 미발송」 — the way
to resend is another reset. If clearing the flag itself fails, the account wrongly
shows 미발송, which costs one extra reset; the opposite order would have let a
failed mail look delivered.

**Only the password that was mailed may clear it.** The clear requires the
temporary password it issued to be still valid (`invalidated_at IS NULL`). Two
resets at once — or a reset right after registration — issue A, then B (which voids
A); if A's mail goes out and B's fails, an unconditional clear by A would show the
account as delivered while the only working password never left.

Changing an account's email voids its unused temporary passwords in the same
transaction: a password mailed — or being mailed — to the old address must not
stay usable by whoever reads that inbox. Voiding one also turns 미발송 back on,
because for a registered or reset account that password was the only way in; left
off, the account would look fine while nobody can sign in.

**The clear locks the row before it checks.** It is a small transaction: lock the
`admin_accounts` row (`FOR NO KEY UPDATE`), then — in a new statement — check the
temporary password, read `updated_at`, and clear the flag. Reset and email change
write that row before they void a password, so once the lock is granted the next
statement sees the void. A single `UPDATE … WHERE EXISTS (…)` does not work: the
`EXISTS` is judged on the snapshot taken when the statement began, and after waiting
on the lock it still sees the password as valid.

**The reset hands back a new `updatedAt` only if nobody saved in between.** The
clear reads `updated_at` just before it writes. If that equals the value the reset
transaction read, the response carries the time after the clear. If not, another
admin saved while the mail was going out; the response keeps the older time, so the
screen's next save is a 409 instead of silently overwriting that save.

**What runs after the commit cannot fail the request.** Clearing that flag is the
only write after the transaction and the mail. If it fails it is logged as an
error (name and code, never the message — Prisma messages carry the arguments) and
the response still reports the account or the mail result — a 500 there would send
the screen to register again (and meet the login-id 409) or to reset again (and
void the password just mailed). The reset's `updatedAt` is then the one read inside
the transaction, which is still correct because nothing else was written; when the
clear does go through, it is the time after the clear — unless someone saved in
between (above). The stack is logged without its
first line, which repeats the message.

A failed SMTP send (the error carries a `code`) is logged by template code, error
name and code only: the SMTP message names the recipient, and `MailService` has
already logged it with the address masked. A failure before SMTP — a missing or
disabled template, an undeclared variable, a bad link — has no `code`, is not
logged by `MailService` and leaves no `mail_send_logs` row, so its message and stack
are logged here; those messages carry no address.

Logging in with a temporary password is 1팀's login to build: it must accept an
unused, unexpired `temporary_passwords` row, mark `used_at`, and force the
password change (`is_password_change_required`).

**The mails carry a 바로가기 button to 관리자 웹.** Both templates declare the
button link `#{링크}` required. The api fills it with `ADMIN_WEB_URL`, validated
by the one rule in `src/common/admin-web-url.ts` that BP 회원가입 (`admin-signup`) and the 문의 답변 mail also
use: an http(s) address, https only in production, trailing `/` dropped, a sub-path kept.[^admin-web-url]
`EMAIL_PLAT_ADMIN_CREATE` and `EMAIL_PASSWORD_RESET` both send `링크: ADMIN_WEB_URL`.
An earlier draft made the link optional by migration and sent no button; it was
dropped on 2026-10-13 to match BP 회원가입, so the templates stay as seeded.

**Mail settings are optional; the api boots without them.** `PlatformAdminsModule`
does not import `MailModule`, which stops the boot when `MAIL_*` is empty — main
decided (PR #28) that an environment without mail must still serve everything else.
`createPlatformAdminMail` reads `MAIL_*` with `readOptionalMailConfig` and builds a
`MailService` on `createMailTransport`, as `AuthModule` does for the reset link.[^platform-admin-mail]
If `MAIL_*` or `ADMIN_WEB_URL` is empty there is no sender. Registration still
succeeds, nothing is mailed, a warning is logged, and the account stays
「초기 비밀번호 미발송」 — the same state as a failed mail. **A reset is refused with
503 before writing anything**: it would void the current password while the new
one could reach no one, and two masters resetting each other would leave nobody
able to sign in until the database is edited by hand. Half a mail setting, or an
`ADMIN_WEB_URL` that is not an http(s) address (or not https in production), still stops the boot: those are
mistakes, not absences.

# Not done here

- Login with the temporary password, 계정 찾기, and 관리자 웹 login itself (1팀).
- e2e tests: the row lock and the `updatedAt` comparison are only proven against a
  real database; none was available.
- 아이디 requires a letter (`LOGIN_ID_PATTERN`), stricter than the CHECK, which
  also accepts digits only. Names are 한글 · 영문 2–20 in the DTO; the database
  checks only the length.

[^platform-admins-service]: PlatformAdminsService
[^menu-permissions]: MenuPermissionsService
[^admin-web-url]: ADMIN_WEB_URL — 관리자 웹 주소, the mail button target (one rule for every mail)
[^platform-admin-mail]: createPlatformAdminMail — the password-mail sender, or none without MAIL_* · ADMIN_WEB_URL
