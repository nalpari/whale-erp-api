---
type: API
title: Work schedules
description: 관리자 웹 근무스케줄 관리(/work-schedules, MN000010)의 주간 · 월간 조회, 등록 · 일괄 등록 · 수정 · 삭제와 등록에 필요한 직원 선택지 · 계약 기본값 — 근무일 + 30분 단위 시각, 자정 넘김, 같은 직원 레코드 겹침 409(EXCLUDE), 근무일 기준 계약 기간 · 가입 · 퇴직일 판정, 변경 이력.
tags: [work-schedule, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-21T07:38:28Z }
sources:
  - id: service
    resource: ../../src/work-schedules/work-schedules.service.ts
    title: WorkSchedulesService — 선택지 · 기본값 · 등록 · 수정 · 삭제
    last_modified: 2026-10-21T07:38:28Z
  - id: rules
    resource: ../../src/work-schedules/work-schedule-rules.ts
    title: 근무일 + 시각 → 순간, 근무일 계산, 계약 휴게 → 분
    last_modified: 2026-10-21T07:38:28Z
  - id: controller
    resource: ../../src/work-schedules/work-schedules.controller.ts
    title: /work-schedules
    last_modified: 2026-10-21T07:38:28Z
  - id: notice
    resource: ../../src/work-schedules/work-schedule-notice.ts
    title: 저장 알림 — 직원 알림 · 앱 푸시 발송 대기(#201)
    last_modified: 2026-10-21T07:38:28Z
  - id: plan
    resource: ../../docs/plans/2026-10-21-work-schedules.md
    title: 근무스케줄 API 계획 (#198, 2026-10-21 재영 결정 1~10 · Q1~Q3)
    last_modified: 2026-10-21T07:38:28Z
---

# What it is

근무스케줄 관리 (#198). One controller, menu `/work-schedules` (MN000010).[^controller]
저장할 때마다 그 직원에게 저장 알림을 한 번 만든다(#201, 아래 「Notice」).[^notice]

| Route | Permission | What |
|---|---|---|
| `GET /work-schedules?storeId=&from=&to=` | read | 주간 · 월간 보기(42일 이하) — `{ staff, items, days }`, 아래 「List」 |
| `GET /work-schedules/assignable-staff?storeId=&workDate=` | create | 그 근무일에 받을 수 있는 직원(아래), 이름순 `{ items: { staffMemberId, name, phoneLast4, jobTitle }[] }` |
| `GET /work-schedules/defaults?staffMemberId=&workDate=` | create or update | 근무일을 덮는 계약의 그 요일 `contract_work_days` → `{ startTime, endTime, breakMinutes }`, 계약 근무일이 아니면 셋 다 null |
| `POST /work-schedules/bulk` | create | 일괄 등록(#199) `{ workDate, rows[1~100] }` → `{ created, failed[{ index, staffMemberId, statusCode, code, message }] }`, 아래 「Bulk」 |
| `POST /work-schedules` | create | `{ staffMemberId, workDate, startTime, endTime, breakMinutes }` → 201 근무스케줄 |
| `PATCH /work-schedules/:id` | update | 근무일 · 시각 · 휴게를 모두 다시 보낸다. 직원은 못 바꾼다 |
| `DELETE /work-schedules/:id` | delete | `is_deleted`. 계약 · 퇴직 조건을 보지 않는다 |

# Time

시각은 한국 시각 `HH:mm`, 30분 단위만(00분 · 30분, 2026-10-21 재영). 종료는 `24:00` 도 받는다.[^rules]
종료가 시작보다 이르거나 같으면 다음 날이다(자정 넘김) — 그래서 한 건은 24시간보다 짧고 `09:00`→`09:00` · `00:00`→`24:00` 은 400.
**근무일은 늘 시작 일시의 한국 날짜다.** 계약 기간 · 퇴직일 판정이 이것을 쓰고, 조회의 주 집계 · 월 달력도 이것을 써야 한다(결정 1).
응답의 `endTime` 은 자정에 끝나면 `00:00` 이라, 화면은 「종료가 시작보다 이르면 다음 날」로 읽는다.
휴게는 분이고 0 이상 · 근무 길이 미만만 본다(단위 없음). 계약의 휴게 시작 · 종료는 길이로 바꿔 기본값에 쓴다.

# Who can get a schedule on a date

`schedulable(workDate)` — 선택지 · 등록 · 수정이 같은 판정을 쓴다:[^service]

- 가입 완료(`join_status = JOINED`). 종이 계약으로 체결 완료여도 가입 전이면 400 `WORK_SCHEDULE_NOT_JOINED`(TO-DO 와 같다, 2026-10-21 재영).
- 근무일을 덮는 체결 완료 계약(`start_date <= 근무일`, `end_date` 가 비었거나 `>=`). 「체결 완료」는 한 번이라도 체결된 계약이다 — 지금 `SIGNED` 이거나, `ENDED` 이면서 상태 이력에 `SIGNED` 가 있는 것(대체 · 만료로 끝난 계약, 운영 정책 PAY-11 v181 · 2026-10-21 재영 A안). 날인 전에 끝난 계약은 넣지 않는다. 종료일이 비면 체결 완료는 기간의 정함이 없고, 종료된 계약은 종료 처리한 날(`ENDED` 로 바뀐 이력 시각의 한국 날짜)이 끝이다(PAY-11 v182 — where 로는 「그 시각 ≥ 근무일 한국 0시」). 없으면 400 `WORK_SCHEDULE_NO_CONTRACT`. 그 계약이 `source_contract_id` 로 한 번 남는다(STAFF-14).
- 퇴직일이 있으면 근무일 ≤ 퇴직일. 넘으면 400 `WORK_SCHEDULE_AFTER_RETIREMENT`(CTR-24). 이미 퇴직한 직원도 재직 중이던 지난 날짜는 받는다 — 지난 날짜도 경고 없이 고친다(결정 9).
- 본사 계정(BM · BA)이 가맹 점포를 보면 본사 제공 동의한 직원만. 선택지에서 빠지고 등록은 400, 그 직원의 근무스케줄 수정 · 삭제는 404(ATT-30).
- 업무 범위 밖 점포 · 직원 · 근무스케줄은 404.

# List

`GET /work-schedules` 은 날마다 「받을 수 있는 직원」(`schedulable`)을 같은 판정으로 찾는다 — 등록과 화면 행이 어긋나지 않게.[^service]

- `staff`: 기간 안 하루라도 받을 수 있는 직원, 이름순. `schedulableDates` 로 화면이 날마다 행을 둘지 가른다(STAFF-29, 휴무도 행은 있다). 본사 계정이 가맹 점포를 보면 동의 없는 직원은 `isMasked: true` 에 ID · 이름 · 번호 · 직무 · 고용 형태 null(화면은 행 key 를 순번으로), 뒤에 두고 그 안은 받을 수 있는 날짜순(결정 7 · ATT-30, Q5) — 이름순이면 명단을 아는 사람이 자리로 누구인지 맞춘다.
- `items`: 그 직원이 그날 받을 수 있는 근무스케줄만(Q6 — 계약이 끝나 행이 없는 날의 근무스케줄은 내지 않는다). 가린 직원 것은 없다.
- `days`: `headcount` 는 근무일(시작한 날)에 근무스케줄이 있는 직원 수, `coverage` 는 한국 00:00 부터 30분 칸 48개의 근무 중 인원. 둘 다 가린 직원을 센다. **자정을 넘는 근무는 다음 날 새벽 칸에도 센다**(Q4, 2026-10-21 재영) — 그래서 첫날 새벽을 채우려고 판정 · 읽기를 기간 하루 앞에서 시작하고, 그 하루는 행 · 항목에 넣지 않는다. 공백(그날 첫 근무 시작~마지막 근무 종료 사이 0 칸)은 화면이 `coverage` 로 그린다.
- ponytail: 날마다 쿼리 한 번(전날 포함 최대 43번), **차례로** — `Promise.all` 로 던지면 월간 조회 하나가 연결 풀을 다 잡아 다른 요청이 P2024 로 500 이 된다. 느려지면 계약 · 이력을 한 번 읽어 판정한다 — 그때도 `contractCovers` 와 같은 결과여야 한다.

# Overlap

같은 직원 레코드의 지우지 않은 근무스케줄끼리만 막는다 — 직원 레코드가 점포마다 따로라 「같은 점포 · 같은 직원」과 같다(결정 3). 다른 점포의 겹침은 계약 단계(CTR-26) 몫이다.
서버가 먼저 `start < 상대 end AND end > 상대 start` 로 찾아 409 `WORK_SCHEDULE_OVERLAP` 을 주고, 동시 저장은 DB 의 `work_schedules_no_overlap`(EXCLUDE, `tstzrange [)`)이 막아 오류 메시지의 제약 이름으로 같은 409 로 바꾼다. 맞닿는 근무(13:00 끝 · 13:00 시작)와 쪼갠 근무는 받는다.

# Bulk

`POST /work-schedules/bulk` 는 근무일 하나에 직원별 줄(직원 · 시작 · 종료 · 휴게)이다. 화면이 줄마다 계약 값으로 미리 채워 보내고 서버는 받은 값을 그대로 저장한다(#199, 2026-10-08 재영).[^service]

- 줄마다 한 건 등록과 같은 규칙 · 같은 잠금으로 **따로** 저장한다(줄마다 트랜잭션). 업무 규칙(400 · 404 · 409)에 걸린 줄은 `failed` 에 넣고 나머지는 저장한다. 예상 못 한 오류(트랜잭션 시간 초과 · 연결 등)도 그 줄만 `failed`(500, `WORK_SCHEDULE_SAVE_FAILED`)로 남기고 다음 줄로 간다 — 던지면 앞 줄은 저장됐는데 알림이 빠지고, 화면이 다시 보내면 저장된 줄이 겹침 409 로 보인다(api 리뷰). 그래서 `created` · `failed` 는 늘 실제 저장과 같다.
- 줄 형식(시각 30분 단위 · 줄 수 1~100 · 근무일)이 틀리면 DTO 가 요청 전체를 400 으로 막는다 — 아무 줄도 저장하지 않는다.
- 줄 순서대로 저장하므로 같은 직원의 겹치는 두 줄은 뒤 줄이 409 다. 겹치지 않으면 쪼갠 근무로 둘 다 저장한다.
- 알림은 다 저장한 뒤 바뀐 직원마다 한 번이다 — 같은 직원의 여러 줄은 알림 하나에 「…, …」로 묶는다(#201). 알림이 실패해도 저장은 되돌리지 않고 `work schedule notice FAILED` 로그만.

# Notice

등록 · 수정 · 삭제가 저장 트랜잭션 안에서 `noticeScheduleChange` 를 부른다 — 템플릿 `PUSH_SCHEDULE_CHANGED`(근무스케줄 변경, 수신 설정 묶음 `SCHEDULE`)로 직원 알림(`notification_target = STAFF`, `related_type = WORK_SCHEDULE`, `related_id` = 근무스케줄) · 받는 사람 하나 · 앱 푸시 발송 대기(`notification_deliveries`, `sent_at` 빈 행) 하나.[^notice]

- `#{변경내용}`: 등록 「10월 21일(수) 09:00~18:00 추가」, 삭제 「… 삭제」, 수정 「전 → 후」(근무일이 같으면 뒤 날짜를 뺀다), 시각이 같고 휴게만 바뀌면 「… 09:00~13:00 휴게 30분 → 60분」, 시각과 휴게가 함께 바뀌면 시각 변화만(Q7, 2026-10-21 재영). 자정을 넘으면 「22:00~익일 02:00」, 24:00 에 끝나면 「18:00~24:00」.
- 템플릿의 수신 설정 묶음(`preference_category`, 기본 근무스케줄 — 운영자가 바꿀 수 있다)을 끈 계정은 알림함 줄만 남고 발송 대기가 없다(NTF-14). 시간과 관계없이 곧바로다 — 근무시간 외 보류 규칙은 없다.
- 시작 · 종료 · 휴게가 모두 같은 수정은 알리지 않는다(변경 이력은 남는다, api #106 리뷰).
- 퇴직 처리가 퇴직일 뒤 근무스케줄을 지울 때는 부르지 않는다(PAY-14, 결정 6 — `retirement.service.ts` 는 이 함수를 모른다).
- 템플릿이 없거나 · 채널이 다르거나 · 사용 안 함이거나 · 렌더할 수 없거나 · 재직이 아닌(퇴직한) 직원 레코드이거나 · 받을 계정이 없거나 탈퇴(`WITHDRAWN`)했거나 · 점포가 없거나 이름이 비면 알림 없이 저장만 하고 보내지 않은 사실을 로그로 남긴다(`work schedule notice SKIPPED …`, 운영 정책 NTF-25). 운영자가 템플릿을 잘못 고쳐도 관리자 저장이 막히면 안 된다. DB 오류는 저장째 되돌린다.
- 실제 발송(FCM 등)은 #321 — 수행 임박 알림과 같이 발송 대기 행만 남긴다. `noticeScheduleChange` 는 변경 여러 건을 받아 「, 」로 묶는다 — 일괄 등록이 직원별로 묶어 부르고, 지난 주 복사(#200)도 그렇게 부른다.

# Traps

- **업무 범위는 트랜잭션 전에 읽는다.** `AdminScopeService` 는 `this.prisma` 를 쓴다. 트랜잭션 안에서 부르면 연결을 하나 더 잡고, 연결이 하나뿐이면(e2e `connection_limit=1`) 트랜잭션이 자기 연결을 기다리다 5초 뒤 P2028 로 500 이 된다.
- 저장은 직원 행을 `FOR NO KEY UPDATE` 로 잠그고 읽는다 — 퇴직 확정(`FOR UPDATE`)이 퇴직일 다음 날부터의 근무스케줄을 지운 뒤 새 근무스케줄이 생기지 않게, 그리고 같은 직원의 저장끼리 한 줄로 서게. `FOR SHARE` 면 겹치는 저장 둘이 함께 겹침 검사를 지나 EXCLUDE 에서 서로를 기다리다 교착(500)할 수 있다(api #100 리뷰). 수정 · 삭제는 그 뒤 근무스케줄 행을 `FOR UPDATE` 로 다시 읽는다 — 퇴직 확정과 같은 직원 → 근무스케줄 순서다.
- 변경 이력 값은 퇴직 처리의 삭제 이력과 같은 `{ startAt, endAt, breakMinutes }`(ISO). 변경 주체는 관리자 계정이다.
- 근무스케줄은 급여 계산에 쓰지 않는다(결정 8, PAY-12). 급여 쪽 코드가 이 표를 읽게 하지 않는다.

[^service]: `src/work-schedules/work-schedules.service.ts`
[^rules]: `src/work-schedules/work-schedule-rules.ts`
[^controller]: `src/work-schedules/work-schedules.controller.ts`
[^notice]: `src/work-schedules/work-schedule-notice.ts`
[^plan]: `docs/plans/2026-10-21-work-schedules.md`
