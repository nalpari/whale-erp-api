---
type: API
title: Work schedules
description: 관리자 웹 근무스케줄 관리(/work-schedules, MN000010)의 등록 · 수정 · 삭제와 등록에 필요한 직원 선택지 · 계약 기본값 — 근무일 + 30분 단위 시각, 자정 넘김, 같은 직원 레코드 겹침 409(EXCLUDE), 근무일 기준 계약 기간 · 가입 · 퇴직일 판정, 변경 이력.
tags: [work-schedule, admin]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-21T06:34:45Z }
sources:
  - id: service
    resource: ../../src/work-schedules/work-schedules.service.ts
    title: WorkSchedulesService — 선택지 · 기본값 · 등록 · 수정 · 삭제
    last_modified: 2026-10-21T06:34:45Z
  - id: rules
    resource: ../../src/work-schedules/work-schedule-rules.ts
    title: 근무일 + 시각 → 순간, 근무일 계산, 계약 휴게 → 분
    last_modified: 2026-10-21T06:34:45Z
  - id: controller
    resource: ../../src/work-schedules/work-schedules.controller.ts
    title: /work-schedules
    last_modified: 2026-10-21T06:34:45Z
  - id: plan
    resource: ../../docs/plans/2026-10-21-work-schedules.md
    title: 근무스케줄 API 계획 (#198, 2026-10-21 재영 결정 1~10 · Q1~Q3)
    last_modified: 2026-10-21T06:34:45Z
---

# What it is

근무스케줄 관리 (#198). One controller, menu `/work-schedules` (MN000010).[^controller]
조회(주간 · 월간)와 저장 알림(#201)은 아직 없다 — 다음 PR 이다.[^plan]

| Route | Permission | What |
|---|---|---|
| `GET /work-schedules/assignable-staff?storeId=&workDate=` | create | 그 근무일에 받을 수 있는 직원(아래), 이름순 `{ items: { staffMemberId, name, phoneLast4, jobTitle }[] }` |
| `GET /work-schedules/defaults?staffMemberId=&workDate=` | create or update | 근무일을 덮는 계약의 그 요일 `contract_work_days` → `{ startTime, endTime, breakMinutes }`, 계약 근무일이 아니면 셋 다 null |
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

# Overlap

같은 직원 레코드의 지우지 않은 근무스케줄끼리만 막는다 — 직원 레코드가 점포마다 따로라 「같은 점포 · 같은 직원」과 같다(결정 3). 다른 점포의 겹침은 계약 단계(CTR-26) 몫이다.
서버가 먼저 `start < 상대 end AND end > 상대 start` 로 찾아 409 `WORK_SCHEDULE_OVERLAP` 을 주고, 동시 저장은 DB 의 `work_schedules_no_overlap`(EXCLUDE, `tstzrange [)`)이 막아 오류 메시지의 제약 이름으로 같은 409 로 바꾼다. 맞닿는 근무(13:00 끝 · 13:00 시작)와 쪼갠 근무는 받는다.

# Traps

- **업무 범위는 트랜잭션 전에 읽는다.** `AdminScopeService` 는 `this.prisma` 를 쓴다. 트랜잭션 안에서 부르면 연결을 하나 더 잡고, 연결이 하나뿐이면(e2e `connection_limit=1`) 트랜잭션이 자기 연결을 기다리다 5초 뒤 P2028 로 500 이 된다.
- 저장은 직원 행을 `FOR NO KEY UPDATE` 로 잠그고 읽는다 — 퇴직 확정(`FOR UPDATE`)이 퇴직일 다음 날부터의 근무스케줄을 지운 뒤 새 근무스케줄이 생기지 않게, 그리고 같은 직원의 저장끼리 한 줄로 서게. `FOR SHARE` 면 겹치는 저장 둘이 함께 겹침 검사를 지나 EXCLUDE 에서 서로를 기다리다 교착(500)할 수 있다(api #100 리뷰). 수정 · 삭제는 그 뒤 근무스케줄 행을 `FOR UPDATE` 로 다시 읽는다 — 퇴직 확정과 같은 직원 → 근무스케줄 순서다.
- 변경 이력 값은 퇴직 처리의 삭제 이력과 같은 `{ startAt, endAt, breakMinutes }`(ISO). 변경 주체는 관리자 계정이다.
- 근무스케줄은 급여 계산에 쓰지 않는다(결정 8, PAY-12). 급여 쪽 코드가 이 표를 읽게 하지 않는다.

[^service]: `src/work-schedules/work-schedules.service.ts`
[^rules]: `src/work-schedules/work-schedule-rules.ts`
[^controller]: `src/work-schedules/work-schedules.controller.ts`
[^plan]: `docs/plans/2026-10-21-work-schedules.md`
