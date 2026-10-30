---
type: API
title: BP admins
description: 관리자 웹 「BP 관리자 관리」(MN000012) — BP 관리자 · 가맹 마스터 · 가맹 관리자 accounts of the tab's BP; who sees and edits whom by role and mapped stores, one franchise master per store, and the cascades a franchise master's save drags along.
tags: [admin, account, permission, store, mail]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-30T02:34:58Z }
sources:
  - id: bp-admin-rules
    resource: ../../src/bp-admins/bp-admin-rules.ts
    title: sideOf · canSee · creatableRoles · actionsOf · assertSelfEdit · planStores · shrinkCascade — the role rules as pure functions
    last_modified: 2026-10-30T00:58:40Z
  - id: bp-admins-service
    resource: ../../src/bp-admins/bp-admins.service.ts
    title: BpAdminsService (list · roleGroups · storeOptions · isLoginIdAvailable · isEmailAvailable · detail · histories · updateImpact · create · update · resetPassword)
    last_modified: 2026-10-30T02:34:58Z
  - id: bp-admins-controller
    resource: ../../src/bp-admins/bp-admins.controller.ts
    title: /bp-admins routes — menu permission by path (`/bp-admins`, MN000012) and the target BP from X-Bp-Code-Id
    last_modified: 2026-10-29T05:17:36Z
  - id: admin-password
    resource: ../../src/platform-admins/admin-password.ts
    title: temporary password issue · mail · unsent-flag clear, shared with platform admins
    last_modified: 2026-10-27T07:48:04Z
---

# What it covers

The 관리자 웹 menu MN000012 「BP 관리자 관리」 (`/bp-admins`): list S-AJHXFU, register
S-NIMSMQ, detail S-EBIPGZ, edit S-OENTFQ and 비밀번호 초기화 S-TKSRJX. It manages the
tab BP's `admin_accounts` rows whose role is `BA` · `FM` · `FA`; a BP 마스터 belongs to
the platform's BP management and is a 404 here, like a deleted or `WITHDRAWN` row.
There is no delete and no unlock route — accounts are not reclaimed (2026-09-29); a
lock ends after five minutes, with a temporary password, or with an operator's password
reset.[^bp-admins-service]

| Route | Menu permission |
|---|---|
| `GET /bp-admins` | 조회 — `{ items, total, inactiveCount }`, newest first |
| `GET /bp-admins/role-groups?roleTypeCode=` | 조회 — the role-group choices for the filter and the form, without needing MN000013 |
| `GET /bp-admins/store-options?roleTypeCode=&adminAccountId=` | 조회 — only the caller's stores that can be picked (no 폐점; for FM, none another master holds) |
| `GET /bp-admins/login-id-availability?loginId=` | 등록 |
| `GET /bp-admins/email-availability?email=` | 등록 — `{ available }`, the save's 409 rule: taken by an undeleted 사용 · 미사용 admin account (platform included); lower-cased, bad format 400 |
| `GET /bp-admins/:id`, `GET /bp-admins/:id/histories` | 조회 — the detail carries `actions` |
| `GET /bp-admins/:id/update-impact?accountStatus=&storeIds=` | 수정 — counts for the franchise master's confirm dialog |
| `POST /bp-admins` | 등록 — `{ adminAccountId, isMailSent }` |
| `PUT /bp-admins/:id` | 수정 — 204 |
| `POST /bp-admins/:id/password-reset` | 수정 — `{ isMailSent, updatedAt }` |

The menu is found by the controller path, and the target BP is the guard's
`@TargetBp()` — a BP or franchise account its own BP, a platform account the tab's
customer BP. A platform account calling without the header targets the platform BP,
which this service answers with the one string 400 「관리자 계정을 볼 BP 를 골라 주세요.」;
관리자 웹 shows a string 400 on a read route as the target-BP refusal, so no other
business 400 on `GET /bp-admins` or `GET /bp-admins/:id` may be a bare string.

The phone is 「연락처」 everywhere here — the 400 message, the self-edit 403 and the
change-history `field` — as in every other admin account API and 관리자 웹. It was
「휴대전화」 until 2026-10-29 (사용자 결정); history rows written before keep that label.[^bp-admins-service]

**An edit's unique-violation 409 says 「이메일」 only when the email index fired.** The
pre-check catches a taken address; a P2002 that still escapes the edit transaction is the
email only if the pg adapter names `admin_accounts_email_key` (or, with no name, the
`email` column) in `meta.driverAdapterError.cause.constraint` — any other, such as a
store mapping inserted by a parallel edit, is 「다른 사용자가 이 계정을 먼저 바꿨습니다.」.
관리자 웹 turns a 409 into the email field's error only when the message has
「관리자 계정의 이메일」, so the two wordings must stay apart (2026-10-30, front 요청).
Register's own P2002 is still the one 「이미 사용 중인 아이디 또는 이메일입니다.」.[^bp-admins-service]

# Who sees and edits whom

The rules are pure functions in `bp-admin-rules.ts`, tested without a database; the
service reads the caller and the target and asks them.[^bp-admin-rules]

- **Sides.** BP 마스터, BP 관리자 and platform users (PM · PA of the platform BP) are
  본사; then 가맹 마스터 and 가맹 관리자. A role on the wrong kind of BP is 403.
- **Seeing.** 본사 sees all three roles — a BP 관리자 with some stores is not narrowed
  by them (CONFIG-1). The franchise side sees itself and the 가맹 관리자 accounts whose
  mapped stores overlap its own (own account added 2026-10-23). A 가맹 마스터 also sees
  every 가맹 관리자 linked to it whatever their stores — otherwise one the shrink cascade
  left with no store would be visible to nobody who may edit it (PR #160 review,
  2026-10-27). Anything else is 404, never 403, so an id does not reveal that an account
  exists.
- **Registering.** 본사 registers BA and FM, a 가맹 마스터 only FA, a 가맹 관리자 nothing.
- **Editing.** BA and FM accounts are edited by 본사; an FA account only by its
  linked 가맹 마스터 — 본사 reads it (CONFIG-2). Your own account: basic information
  only (name, phone, email); role group, status and stores are 403, and so is resetting
  your own password. A 가맹 관리자 cannot edit even its own account.
- **The linked 가맹 마스터 is not a column.** It is the FA role group's
  `manager_admin_account_id`. An FA's group may only be one whose manager is that
  master, so the link never changes; moving an FA means registering it again.

# Role groups

A BA gets any undeleted BA group of the BP — there is no escalation check here; the
ceiling is applied when the group is made in BP 권한 그룹 관리, and attaching it is in
the history (2026-10-23). An FM always gets `FM000001`, which lives on the platform BP
and is shared by every BP's masters, like `BM000001`. An FA gets a group managed by its
master. Anything else is 400 「선택할 수 없는 권한입니다.」.

# Stores

`planStores` decides what is saved:

- **전체 점포** only for a BA, and only by a caller who manages all stores. A platform
  user counts as managing every store of the tab BP (2026-10-23).
- **Picked stores** must be within the caller's stores; for an FA, the master's.
  Outside is 400 「점포 범위를 벗어나 저장하지 않았습니다.」.
- **범위 밖 매핑 stays.** Mappings outside the caller's stores are kept even though the
  request does not list them — the form shows them read-only (2026-09-29). A caller with
  some stores editing an all-stores BA keeps it all-stores; turning it partial is 403.
- **Closed stores are not newly mapped** (2026-10-23) — 400 「폐점한 점포는 새로 맡길 수
  없습니다.」. A closed store already mapped is kept only if the request sends it again —
  leaving it out removes it. The form takes it from the detail's `stores`, since the
  options never list a closed store.
- **`store-options` lists only what can be picked** (2026-10-23): no closed store, and
  for an FM none that another `ACTIVE` master holds. The 등록 · 수정 form draws its
  candidates from it — dimming a 폐점 store belongs to the header scope and list
  filters, not here. So an already-mapped closed store is drawn from the detail's
  `stores`, never from the options. The save still checks both, because two people
  saving at once both see the store as a candidate.
- **At least one store** remains, or 400.

Mappings are `(admin_account_id, store_id)` rows with `is_deleted`. A removed store is
flagged, a store re-added revives its flagged row, and only a first-time pair is
inserted — the composite key would refuse a second row.

**Register and edit lock the BP first.** Both transactions open with
`SELECT account_status_code, is_deleted FROM bp_codes … FOR SHARE` on the tab's BP and
re-read it: deleted is 404 (`BP 를 찾을 수 없습니다.`, the guard's wording), and a BP that is
not 사용 — 미사용 or 탈퇴 alike — is 409 `BP 가 사용 중이 아니라 사용 계정을 둘 수 없습니다.` for a
register and for any edit that saves 사용 — re-activating included. Editing a 미사용 account of a 미사용 BP, staying 미사용,
still works. Restoring 사용 is the BP 마스터's job (WHALEERP-414), so the platform can no
longer pick a 미사용 BP in the header and add a 사용 account there. The lock exists because
a register's foreign-key check (`FOR KEY SHARE`) is not enough — it does not conflict with
미사용 전환 (`FOR NO KEY UPDATE`) at all, and against delete it waits but then passes, since
delete only flags the row (an edit never changes `bp_code_id`, so it has no FK check): without it a 사용 BA · FM · FA could be
left under a 미사용 BP — the guard checks only the account's own status, so it logs in — or
a live account under a deleted BP whose delete had just checked 「no sub-admins」
(PR #163 review, 2026-10-27).

미사용 전환 and delete live in [BP masters](/api/bp-masters.md) (`/bp-masters`, PR #163,
merged 2026-10-28): `changeStatus` updates `bp_codes` (an implicit `FOR NO KEY UPDATE`) and
`remove` takes `FOR UPDATE`, both before `admin_accounts`. This BP lock therefore comes first
in our order too — **BP → 가맹 마스터 → 권한 그룹** — or the two would deadlock; if either side
changes its order, the argument breaks. So one side wins: 미사용 전환 first → register or 사용 save 409, register or
edit first → 미사용 전환 turns that account 미사용 too; delete first → 404, register first →
delete sees the sub-admin and its `deletionReasons` 409s. A still-사용 edit was already safe as long as 미사용 전환
lowers accounts through Prisma, so that `@updatedAt` moves and the optimistic check fails
(a raw SQL `UPDATE` would not move it); re-activation had no such guard, and now both get the
409 anyway.

A save that runs past the transaction limit (5 s, Prisma's default) ends in P2028 — mostly
waiting on the BP lock while 미사용 전환 or delete holds it, but a wait on the 가맹 마스터 or
권한 그룹 lock, or for a pool connection, ends the same way; that is a 503 `다른 작업이 끝나기를 기다리다 시간이 지났습니다. 잠시 뒤 다시 저장해
주세요` with the BP in the log, not a bare 500 — retrying is the answer, as with store
registration. Prisma's timeout does not interrupt a query already waiting on a lock, so
this is not a 5-second cap: the request waits until the holder commits, then fails on its
next statement.

`test/bp-admins-bp-lock.e2e-spec.ts` runs six orders — register × (미사용 전환, delete) and
edit × 미사용 전환, each side first — on real PostgreSQL only (`E2E_REAL_POSTGRES=1`; without
it every case is skipped and the run still exits 0, so a green `pnpm test:e2e` proves
nothing here). It imitates 미사용 전환 and delete in SQL with the same lock order (written before `/bp-masters`
landed; switching it to the real routes is a follow-up) — so for
register-then-delete it shows delete sees the new sub-admin, not delete's 409. All six
passed on a throwaway PostgreSQL 18 (2026-10-28), and each edit case fails with the edit's
`lockBp` removed. The register-first case releases 미사용 전환 before awaiting the response:
the register's after-commit `markSent` locks the new account row, which 미사용 전환 is
holding, so awaiting first waits on itself. It counts
only sessions blocked by the connection it holds (`pg_blocking_pids`), so other suites' lock
waits on the same database cannot release it early.

**A 가맹 관리자 save locks its master.** Saving a 가맹 관리자 takes `FOR SHARE` on the linked
가맹 마스터's row and re-reads that master's status and stores inside the transaction.
본사's edit of the master `UPDATE`s that row before its cascade reads the linked 가맹
관리자, so the two line up: master first → the 가맹 관리자 save sees the removed store
(400) or 미사용 (403); 가맹 관리자 first → the cascade sees the new mapping and removes it
(PR #160 adversarial review, 2026-10-27). Only this pair is locked — a 본사 caller's own
row is not, because its stale read leaves no lasting rule broken and locking every
caller would deadlock two admins editing each other. The chosen role group is locked
the same way (`FOR SHARE`, re-checked not deleted) for every role, after the master, so
a group deleted meanwhile is a 400 rather than an account stuck on a deleted group;
플랫폼 관리자 관리 still has that gap.

**One franchise master per store.** A store held by another `ACTIVE` 가맹 마스터 is 409.
The check runs under a per-BP advisory lock (`bp-admins:franchise-master-stores:{bp}`)
so two saves cannot both read the store as free. Re-activating a 가맹 마스터 checks all
its stores, since another master may have taken one while it was 미사용.

# A franchise master's save cascades

Both cascades run in the edit's transaction, and each affected 가맹 관리자 gets its own
history row whose 처리자 is **the person who saved the master** — the schema comment on
`admin_change_histories.changed_by` says so for 연쇄 미사용, and the store cascade follows
the same rule by the 2026-10-23 decision. The table has no reason column, so the reason
is appended to the after-value.

- **미사용.** Setting a master 미사용 turns every linked `ACTIVE` 가맹 관리자 미사용
  (`미사용 (가맹 마스터 미사용)`). Their role groups stay — groups have no status
  (CONFIG-6). Turning the master back 사용 does not revive them.
- **Removing stores.** Removing stores from a master removes those stores from every
  linked 가맹 관리자 too (`… (가맹 마스터 점포 제외)`). One left with no store keeps its
  status; the at-least-one-store rule bites the next time it is edited, and its master
  still sees it (see Seeing). Its `updated_by` (and through `@updatedAt` its
  `updated_at`) moves to the saver, so its detail shows the change and an edit form
  opened before the cascade fails the optimistic check with 409 instead of a confusing
  scope 400 (PR #160 review, 2026-10-27).

`GET /:id/update-impact` returns both counts and the first login id of each, so one
confirm dialog can show 「moriyn 외 1명」 for either or both. It counts stores the same
way the save does — mappings outside the caller's stores are not removed.

# Passwords

Registration and reset follow [platform admins](/api/platform-admins.md) through the
shared `admin-password.ts`: `password_hash = '!'`, a 12-character
temporary password for one hour (`INITIAL` · `RESET`), the unsent flag written in the
transaction and cleared only after the mail of a still-valid password went out.
Registration mails `EMAIL_BP_ADMIN_CREATE` (관리자이름 · BP이름 = `trade_name` ·
로그인아이디 · 임시비밀번호 · 링크) and keeps the account when the mail fails
(`isMailSent: false`). `trade_name` is read before the transaction: read after the
commit, a failure would answer 500 for an account that exists, and the screen's retry
would hit the login id's 409. Reset mails `EMAIL_PASSWORD_RESET` and works on a 미사용
account, like the platform screen, and clears the login lock
(`failed_login_count`, `lock_expires_at`) as the 플랫폼 관리자 · BP 마스터 resets do. Its conditional write re-checks deleted,
withdrawn, role and email, so a target changed after the read is a 409 with nothing
sent. It is 503 with nothing written when mail is not configured.
[^admin-password]

# Traps

- **The mapping rows decide visibility.** `canSee` for the franchise side reads live
  mappings (mapping and store both undeleted). The list's franchise filter checks only
  the mapping flag — safe because `caller.storeIds` never holds a deleted store. Keep it
  that way, or add `store: { isDeleted: false }`.
- **The unit spec's fake prisma follows single relations.** `matches` checks a relation
  the row carries as an object (`roleGroup.managerAdminAccountId`), so a cascade that
  reached another master's 가맹 관리자 fails the spec — the fixtures include one (32, under
  master 21). List relations, `OR` and `AND` are still skipped.
- **`_count` on a relation takes `where` only.** Passing the mapping select
  (`{ where, select }`) type-checks but Prisma rejects it at run time with
  `SelectionSetOnScalar` — the list was a 500 until 2026-10-26. The fake prisma in the
  unit spec cannot see it, so the spec pins the argument's shape.
- **`?storeIds=` is an empty list, not a 400.** The query transform drops empty parts;
  `update-impact` sends it when a master is saved with every store removed.
- **Store filters always include all-stores accounts.** `storeIds` / `storeTypeCode`
  find accounts that manage those stores: mapped ones **or** `is_all_stores`. Dropping
  the `OR` hides every all-stores BA from a store search.
- **Not proven against a database yet.** Concurrency (two masters taking a store, the
  cascade racing an FA edit) is only covered by mocks; the e2e suite is still to be
  written.

[^bp-admin-rules]: 역할 규칙 순수 함수
[^bp-admins-service]: BpAdminsService
[^admin-password]: 임시 비밀번호 발급 · 메일 · 미발송 해제 (플랫폼 관리자와 공용)
