---
type: API
title: TO-DO
description: 관리자 웹 TO-DO 리스트 관리(MN000026)와 직원 상세 · 직원 근무 앱의 TO-DO API — 배정 그룹 펼치기, 한 명 수행의 완료 선점(409 TODO_ALREADY_DONE), 대기만 지우는 삭제, 5분마다 도는 수행 임박 알림 배치.
tags: [todo, admin, staff-app, batch, notification]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-21T01:46:17Z }
sources:
  - id: todos-service
    resource: ../../src/todos/todos.service.ts
    title: TodosService — 등록 · 목록 · 상세 · 수정 · 상태 변경 · 삭제 · 내 TO-DO
    last_modified: 2026-10-20T03:47:38Z
  - id: todo-rules
    resource: ../../src/todos/todo-rules.ts
    title: 재직 직원 기준 · 정렬 · 묶음 상태 · 수행 예정 일시 계산
    last_modified: 2026-10-19T03:20:00Z
  - id: todos-controllers
    resource: ../../src/todos/todos.controller.ts
    title: /todos · /staff-members/:id/todos · /me/todos
    last_modified: 2026-10-21T01:46:17Z
  - id: due-soon
    resource: ../../src/todos/todo-due-soon.service.ts
    title: 수행 임박 알림 배치(todo-due-soon)
    last_modified: 2026-10-19T02:50:00Z
  - id: template-migration
    resource: ../../prisma/migrations/20261019114505_team3_todo_due_soon_template/migration.sql
    title: PUSH_TODO_ASSIGNED → PUSH_TODO_DUE_SOON
    last_modified: 2026-10-19T02:50:00Z
  - id: plan
    resource: ../../docs/plans/2026-10-19-todos.md
    title: TO-DO API 계획 (T-1 ~ T-4, 2026-10-19 재영)
    last_modified: 2026-10-19T02:50:00Z
---

# What it is

TO-DO (#109). Three controllers over one service:[^todos-controllers]

| Route | Who | What |
|---|---|---|
| `GET /todos` | menu `/todos` (MN000026) read | list — filters `storeId` · `status[]` · `assigneeType` · `staffMemberId` · `dueDateFrom`/`dueDateTo` · `isUrgent`, `{ items, total }` |
| `GET /todos/assignable-staff?storeId=` | `/todos` create | 등록의 직원 고르기: `ACTIVE_STAFF` of that store, by name → `{ items: { staffMemberId, name, phoneLast4, jobTitle }[] }`; store outside scope 404; a 본사 role on a 가맹 store sees only consented 직원 (ATT-30) |
| `GET /todos/:todoId` | `/todos` read | detail: assignees, status history, per-staff rows of the group |
| `POST /todos` | `/todos` create | register; expands the assignment (201 `{ todoIds, assignmentGroupId }`) |
| `PATCH /todos/:todoId` | `/todos` update | title · body · due date/time · urgent; the whole group |
| `PATCH /todos/:todoId/status` | `/todos` update | 관리자 changes status for the 직원 (T-1); that row only |
| `DELETE /todos/:todoId` | `/todos` delete | 대기 only; a group deletes only its 대기 rows (T-2) → `{ deleted, remaining }` |
| `GET /staff-members/:id/todos` | menu `/staff-members` (MN000005) read | 직원 상세의 TO-DO 영역 (#118) |
| `GET /me/todos` | `account` token | 내 TO-DO (근무 탭 · 홈 카드) |
| `PATCH /me/todos/:todoId/status` | `account` token | 대기 ↔ 진행 중 ↔ 완료 |

# Rows, groups and why there is no group table

The schema already had `todos` · `todo_assignees` · `todo_status_histories`;
nothing was added.[^plan] An assignment is expanded at registration:

| 배정 | `todos` rows | `todo_assignees` | `assignment_group_id` |
|---|---|---|---|
| 개인, one person | 1 | that person | null |
| 개인, several | one per person | one each | the first row's id |
| 근무지 전체 · 각자 수행 | one per 재직 직원 now | one each | the first row's id |
| 근무지 전체 · 한 명 수행 | 1 shared | everyone | null |

The group id is simply the first row's `todo_id` — there is no sequence and no
group table, and the id can never collide with an unrelated row because it is
one of the group's own rows. 개인 with 한 명 수행 is rejected (400): 한 명 수행 only
means something for 근무지 전체.

**재직 직원** here is a 직원 레코드 that has a 체결 완료 (`SIGNED`) 근로계약 at
its store, has joined (`join_status = JOINED`, i.e. has an account), and is not
retired (`employment_status = EMPLOYED`) — 퇴직 예정 included (`ACTIVE_STAFF`,
운영 정책 PAY-16 · CTR-29, 2026-10-19 재영).[^todo-rules] One constant decides it
for every use — 개인 배정 check (400 otherwise, like a retired 직원), 근무지 전체
expansion, 수행 임박 알림 recipients, the 직원 근무 앱's own TO-DOs, and the
등록 staff picker. The join check is not redundant: a 종이 계약 is 체결 완료 before
the 직원 has signed up, and such a 직원 cannot open the app, so they get no
TO-DO until they join (2026-10-19 재영). A contract past its end date still
counts while its status is `SIGNED` — no rule turns a contract's status over
when its term ends. A 직원 레코드 belongs to one store and its contracts are that
store's, so "a signed contract at that store" is just
`contracts: { some: { status: 'SIGNED' } }`. People who qualify only after a
근무지 전체 TO-DO was registered do not get it (T-4).

Registration reads the assignees inside its own transaction after
`SELECT … FROM staff_members WHERE store_id = ? FOR SHARE`, so it cannot
interleave with a retirement being finalized (row `FOR UPDATE` / conditional
UPDATE): whichever waits re-reads the committed row, and a just-retired 직원 is
never assigned after the retirement cleanup ran.

Assignment type and execution mode cannot change after registration — the
update DTO does not have them, and the global `forbidNonWhitelisted` pipe turns
them into a 400.

# Scope

A 관리자 sees TO-DOs of the stores they manage (`getManageableStores`); anything
else is the same 404 as a missing id. The scope is resolved first and the row is
looked up inside it, so a foreign id costs the same queries as a missing one.
Scope is per store, then **narrowed by 본사 제공 동의** (운영 정책 ATT-30 v143,
2026-10-19 재영). TO-DO is not added to the consent items; instead, when a 본사
role (BP 마스터 · BP 관리자) looks at a 가맹 store, 직원 who have not consented
are treated like the 직원 목록 treats them, with the same `hidesPersonalData`.
Consent is read from the 직원's account (one value per person, 2026-10-20); a
record with no account — even one marked 가입 완료 — counts as not consented:

- `GET /todos/assignable-staff` leaves them out;
- `POST /todos` 개인 배정 naming one is the usual 400 (「배정할 수 없는 직원」);
- `GET /todos?staffMemberId=` on one is 404 — the same `canManageStaffMember`
  as 직원 상세, which also already 404s `GET /staff-members/:id/todos`;
- every 직원 name in list · detail · status responses is masked.

So such a store only gets 근무지 전체 assignments from 본사 — the expansion
itself ignores consent and still reaches everyone. 가맹마스터 · 가맹관리자 and
직영 stores see everyone; 직원 근무 앱 never masks (동료 이름 공개, WORK-3).

**Masked shape** (front matches this): wherever a 직원 appears as
`TodoStaffDto` (`assignees[]`, `performer`, detail `assignees[]`, the 409
`performer`) it is `{ staffMemberId: null, staffMemberName: null, isMasked: true }`
— like a masked 직원 목록 row, the id goes too. Shown 직원 carry
`isMasked: false`. `groupTodos[]` rows have the same three fields. History rows
keep their flat fields and add `isStaffMemberMasked` /
`isUnassignedStaffMemberMasked`; when true, the matching `…Id` and `…Name` are
null.

직원 근무 앱 sees TO-DOs assigned to their own 재직 staff records only — a record
outside `ACTIVE_STAFF` (no 체결 완료 contract at its store, not joined, or retired)
contributes nothing (운영 정책 CTR-29); anything else, including
`PATCH /me/todos/:todoId/status` on such a record's TO-DO, is 404.

# Lists are sorted in memory

Order: 미완료 긴급 → 미완료 나머지 → 완료, then due date, then due time (date-only
after timed on the same day), then id (`compareTodos`). The first key is a CASE,
which Prisma's `orderBy` cannot express, and the admin list also has to fold a
group into one line before paging. So every list reads all matching rows and
sorts, groups and pages in memory — marked `ponytail:` in the service, with the
SQL replacement (`COALESCE(assignment_group_id, todo_id)` + CASE) named.

Filters apply per row, then matching rows of a group fold into one line: status
is 완료 if all are done, 대기 if all are pending, otherwise 진행 중, with
`todoCount` / `doneCount`. Filtering by 직원 therefore shows only that person's
row of a group. Filtering by status works the same way: a group line's status,
`todoCount` and `doneCount` are computed from the rows that passed the filter
only, so `status=DONE` shows a mixed group as 완료 with just its done rows.

# Status changes and the shared-completion race

Any status may go to any other; the same status is a no-op (double tap).
The UPDATE is conditioned on the status that was read
(`WHERE todo_id = ? AND status = <read>`), which for 완료 implies
`status <> 'DONE'` — so when two 직원 complete one 한 명 수행 TO-DO at once only
the first commit gets one row; the other gets zero and answers **409
`TODO_ALREADY_DONE`** with the `performer` who won. Anything else that moved
under the request is 409 `TODO_STATUS_CONFLICT`. Conditioning on the read status
(stricter than the plan's `<> 'DONE'`) keeps `from_status` in the history row
true.[^todos-service] When a 직원 reopens a 한 명 수행 TO-DO they completed, the
UPDATE is also conditioned on `performer_staff_member_id = <me>`: if a 관리자
reopened it and another 직원 completed it in between, the stale reopen matches
zero rows and answers 409 `TODO_ALREADY_DONE` instead of undoing the other
직원's completion.

On 완료: `completed_at`, and for 한 명 수행 `performer_staff_member_id` and that
직원's `todo_assignees.is_completed`; for 각자 수행 the row's assignee. Leaving 완료
clears all three. A 직원 cannot reopen or re-complete a 한 명 수행 TO-DO they did
not complete themselves — completed by another 직원 or by a 관리자 (no performer)
— (409 `TODO_ALREADY_DONE`); a 관리자 can. A TO-DO deleted while the change was
in flight answers 404, not 409.

Every change writes one `todo_status_histories` row — `changed_by` for 관리자,
`staff_member_id` for 직원 (the CHECK allows one). Registration writes
`null → PENDING`; changing 긴급 writes `status → same status` with
`is_urgent_changed` for each row whose flag actually changed.

# Deletion

Only 대기, as `is_deleted`. For a group, only its 대기 rows go and the response
says how many went and how many stayed; nothing to delete is 409. The UPDATE is
conditioned on 대기, so a row started meanwhile stays.

# 수행 임박 알림

`todo-due-soon` (`BATCH_JOB.TODO_DUE_SOON`) runs every 5 minutes, Asia/Seoul,
under `BatchLockService.runExclusive`.[^due-soon] Targets: not deleted, 대기 or
진행 중, and

- with a time: from one hour before the due time,
- date only: from 09:00 KST of the due date,

**until the due moment passes** (date only: the end of that day). The upper
bound is not in the plan; without it the first run after deploy would notify
every overdue open TO-DO at once.

Recipients: each assignee's account (한 명 수행: everyone), only 재직 records (체결 완료
contract, joined, not retired) with an account. One `notifications` row (`STAFF`, `related_type = 'TODO'`, 긴급 copied)
plus one `notification_recipients` row per account, keyed
`todo-due-soon:<todoId>:<due>:<accountId>` with `<due>` = `2026-10-19T18:00` or
`2026-10-19` (T-3: moving the due time sends once more; moving it back to a
time already notified does **not** send again — the key is the same). Inserts use
`skipDuplicates` (`ON CONFLICT DO NOTHING` on the partial unique index), so a
rerun or a second instance creates nothing new.

앱 푸시 follows 수신 설정 묶음 TODO — no preference row means on. Enabled
recipients get a `notification_deliveries` row with `channel = PUSH` and empty
`sent_at` · `result` (발송 대기); the inbox row is created regardless. Nothing
is sent: there is no FCM or push token yet. The service has a `TODO(#321)`
marking where sending goes.

The template is the seeded `PUSH_TODO_ASSIGNED`, renamed by
`20261019114505_team3_todo_due_soon_template` to `PUSH_TODO_DUE_SOON`
(「TO-DO 수행 임박 알림」, title 「곧 수행할 TO-DO가 있습니다」, body unchanged
「#{TO-DO제목} · #{수행예정일시}」, `default_title` kept in step).[^template-migration]
If the template is missing (before that migration), turned off by an
operator, or on another channel, the batch logs `todo due soon SKIPPED` (warn)
and creates **nothing — not even the inbox row**: the inbox text comes from the
template, and the next run tries again (dedupe keeps that safe). A database
error while reading the template is not a skip: it is logged as
`todo due soon FAILED template lookup` (error) and rethrown, so
`BatchLockService` records the run as FAILED and the transaction rolls back.

Registering a TO-DO creates no notification at all.

# Not here

반복 설정 (2차), actual push sending (#321), 관리자 수행 임박 알림.

`test/todos.e2e-spec.ts` covers ATT-30 masking and exclusion, 가입 전 직원,
the shared-completion 409 and the partial-index dedupe against a real database
(run on a local PGlite, never the shared one). PGlite serves one session at a
time, so there the two completions run one after the other and the loser takes
the "already DONE" path, not the zero-row UPDATE; the true overlap needs real
PostgreSQL.

[^todos-service]: `src/todos/todos.service.ts`
[^todo-rules]: `src/todos/todo-rules.ts`
[^todos-controllers]: `src/todos/todos.controller.ts`, `staff-member-todos.controller.ts`, `my-todos.controller.ts`
[^due-soon]: `src/todos/todo-due-soon.service.ts`, `todo-due-soon.scheduler.ts`
[^template-migration]: `prisma/migrations/20261019114505_team3_todo_due_soon_template/migration.sql`
[^plan]: `docs/plans/2026-10-19-todos.md`
