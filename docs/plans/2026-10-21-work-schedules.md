# 근무스케줄 API 계획

**목표:** 관리자 웹 근무스케줄 관리가 쓰는 등록·수정·삭제 API를 만든다(#198). 조회·알림·일괄 등록·지난 주 복사는 다음 PR로 잇는다.

**Plane 일감 (#196 근무스케줄 관리 아래):** #198 등록·수정·삭제(이 PR) · #199 여러 직원 일괄 등록 · #200 지난 주 복사 · #201 저장 알림(따로 PR, 2026-10-21 재영) · #608 변경 이력 조회 · #609 3년 보존 뒤 파기 배치 · #206 권한 점검. 화면 #202·#203·#204·#343 은 front, #205 는 staff 다.

**작업 위치:** 워크트리 `~/.whale-erp-worktrees/whale-erp-api/colosseum`, 브랜치 `hitmonlee` (origin/main `9cacfe9` 에서 시작)

## 근거

| 근거 | 쓰는 곳 |
|---|---|
| Manyfast 「근무스케줄 관리」 · 「근무스케줄 주간·월간 보기」 · 「여러 명 일괄 등록과 지난 주 복사」 | 등록 칸 · 기본값 · 겹침 · 계약 기간 |
| 운영 정책 v176 PAY-10~14 · RET-02 · NTF-09 | 계약 기간 밖 거부(PAY-11) · 급여에 안 씀(PAY-12) · 3년 보존(RET-02) |
| Plane #198 완료 조건 (2026-10-21 고침) | 아래 규칙 전부 |
| front 목업 `docs/mockup/staff/index.html` 근무스케줄 탭 · STAFF-14·26·29·30 | 기본값은 등록 때 한 번, 미체결 직원은 선택지에서 뺀다, 근무 유형 없음 |
| 2026-10-21 재영 결정 1~10 (기획 세션 전달) | 자정 넘김 · 쪼갠 근무 · 겹침 범위 · 휴게 분 · 지난 날짜 경고 없음 |
| 퇴직 처리 `src/staff-members/retirement.service.ts` | 퇴직일 다음 날부터의 근무스케줄을 지우고 삭제 이력을 남긴다. 이미 있다. 알림 없음(결정 6) |

## 데이터

스키마는 이미 있다: `work_schedules` · `work_schedule_histories`, enum `WorkScheduleChangeType(CREATED·UPDATED·DELETED)`. 마이그레이션은 만들지 않는다.

- 겹침은 DB 가 막는다: `work_schedules_no_overlap` EXCLUDE(`staff_member_id` =, `tstzrange(start_at, end_at)` &&, 지우지 않은 것만). 직원 레코드는 점포마다 따로라 「같은 점포 · 같은 직원 레코드」와 같다(결정 3). 서버는 저장 전에 먼저 찾아 409 를 주고, 동시 저장은 제약 위반(23P01)을 409 로 바꾼다.
- `end_at > start_at`, `break_minutes >= 0` CHECK 도 이미 있다.
- `store_id` 는 직원 레코드의 점포를 그대로 쓴다. 요청으로 받지 않는다.
- `source_contract_id` 는 근무일을 덮는 체결 완료 계약이다. 기본값을 어디서 왔든 등록 때 한 번 남긴다(STAFF-14).

## 근무일과 시각

- 요청은 근무일(`YYYY-MM-DD`) · 시작(`HH:mm`) · 종료(`HH:mm`) · 휴게(분)다. 화면 칸과 같다. 시작 · 종료는 30분 단위(00분 · 30분)만, 나머지는 400 이다(Q3).
- 시각은 한국 시각이다. 시작 일시 = 근무일 + 시작. 종료가 시작보다 이르거나 같으면 다음 날로 본다(자정 넘김, 결정 1). 그래서 근무는 24시간보다 짧다. 종료 `24:00` 은 다음 날 `00:00` 과 같다.
- 근무일은 늘 시작 일시의 한국 날짜다. 계약 기간 확인 · 퇴직일 확인 · 주 집계 · 월 달력 모두 이 날짜를 쓴다(결정 1).
- 휴게는 0 이상이고 근무 길이보다 짧아야 한다. 단위는 걸지 않는다(Q3).

## 받을 수 있는 직원

근무일 하나에 대해 아래를 모두 만족하는 직원 레코드다. 등록 · 수정 · 선택지가 같은 함수를 쓴다.

1. 관리자의 업무 범위 안 점포의 직원 레코드다(밖이면 404).
2. 가입을 마쳤다(`join_status = JOINED`). 종이 계약으로 체결 완료여도 가입 전이면 뺀다(Q1, TO-DO 와 같다).
3. 근무일을 덮는 체결 완료 근로계약이 있다: `start_date <= 근무일` 이고 `end_date` 가 비었거나 `>= 근무일`(PAY-11 · STAFF-29). 「체결 완료」는 한 번이라도 체결된 계약 — 지금 `SIGNED` 이거나, 상태 이력에 `SIGNED` 가 있는 `ENDED`(대체 · 만료로 끝남). 날인 전에 끝난 계약은 넣지 않는다(PAY-11 v181, 2026-10-21 재영 A안). 종료일이 빈 종료 계약은 종료 처리한 날(ENDED 로 바뀐 시각의 한국 날짜)까지다(PAY-11 v182).
4. 퇴직일이 정해져 있으면 근무일이 퇴직일 이하다(CTR-24). 이미 퇴직한 직원도 재직 중이던 지난 날짜는 받는다.
5. 본사 계정이 가맹 점포를 보면 본사 제공에 동의한 직원만이다(ATT-30, Q2). 등록은 400, 그 직원의 근무스케줄 수정 · 삭제는 404.

## API

관리자 쪽 (`@UserTypes('admin')`, 메뉴 「근무스케줄 관리」 `/work-schedules`(MN000010))

| 메서드 · 경로 | 하는 일 | 권한 |
|---|---|---|
| `GET /work-schedules/assignable-staff?storeId=&workDate=` | 등록의 직원 선택지. 위 「받을 수 있는 직원」을 이름순으로, 끝 4자리 번호 · 직무와 함께 | create |
| `GET /work-schedules/defaults?staffMemberId=&workDate=` | 그 근무일을 덮는 계약의 그 요일 근무시간. 시작 · 종료 · 휴게(분, 계약 휴게 시작~종료 길이, 결정 4). 그 요일이 계약 근무일이 아니면 빈 값. 「계약 값으로 되돌리기」도 이것을 다시 부른다 | create |
| `POST /work-schedules` | 등록. `{ staffMemberId, workDate, startTime, endTime, breakMinutes }` → 이력 CREATED | create |
| `PATCH /work-schedules/:workScheduleId` | 수정. 근무일 · 시각 · 휴게. 직원은 못 바꾼다. 바뀐 값으로 「받을 수 있는 직원」과 겹침을 다시 본다 → 이력 UPDATED(변경 전후) | update |
| `DELETE /work-schedules/:workScheduleId` | `is_deleted` 로 지운다 → 이력 DELETED(변경 전). 계약 · 퇴직 조건은 보지 않는다 | delete |

- 지난 날짜도 경고 없이 등록 · 수정 · 삭제한다(결정 9). 근무스케줄은 급여 계산에 쓰지 않는다(결정 8, PAY-12).
- 저장은 직원 행을 FOR NO KEY UPDATE 로 잠근다(같은 직원 저장이 한 줄로 선다, api #100 리뷰). 수정 · 삭제는 직원 행 → 근무스케줄 행(FOR UPDATE) 순으로 잠그고 다시 읽는다. 퇴직 확정과 같은 순서라 교착하지 않고, 그사이 지워졌으면 404 다.
- 이력의 값 모양은 퇴직 처리와 같다: `{ startAt, endAt, breakMinutes }` (ISO 문자열). 변경 주체는 관리자 계정.
- 오류: 계약 기간 밖 · 퇴직일 뒤 · 가입 전 400(코드 `WORK_SCHEDULE_NO_CONTRACT` · `WORK_SCHEDULE_AFTER_RETIREMENT` · `WORK_SCHEDULE_NOT_JOINED`), 겹침 409 `WORK_SCHEDULE_OVERLAP`, 범위 밖 · 없는 · 지운 근무스케줄 404.

## 조회 (#343 · #202, 두 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/parthenon`, 브랜치 `hitmontop`(origin/main `5ebace4`). 등록 · 수정 · 삭제(#198)는 api #100 으로 머지됐다.

`GET /work-schedules?storeId=&from=&to=` (read). 주간(7일) · 월간(달력 6주 42일)이 같은 경로를 쓴다. `from ≤ to`, 42일 이하가 아니면 400. 점포가 업무 범위 밖이면 404.

```
{
  storeId, from, to,
  staff: [{ staffMemberId, name, phoneLast4, jobTitle, employmentType, isMasked, schedulableDates[] }],
  items: [{ workScheduleId, staffMemberId, storeId, workDate, startTime, endTime, startAt, endAt, breakMinutes }],
  days:  [{ workDate, headcount, coverage[48] }]
}
```

- **staff** — 기간 안 하루라도 근무스케줄을 받을 수 있는 직원(「받을 수 있는 직원」과 같은 판정, 날마다). `schedulableDates` 는 그 날짜들이다 — 화면은 날마다 이 직원을 행으로 둘지 이것으로 가른다(STAFF-29, 휴무도 행은 있다). 이름순.
- **본사 제공 동의 없는 가맹 직원**(본사 계정, 결정 7 · ATT-30): 행은 두되 `isMasked: true` 에 `staffMemberId` · 이름 · 번호 · 직무 · 고용 형태는 null(화면은 행 key 를 순번으로), 그 직원 근무스케줄은 `items` 에 넣지 않는다. 인원(`headcount` · `coverage`)에는 센다. 가린 행은 뒤에 두고, 그 안은 이름이 아니라 받을 수 있는 날짜로 줄 세운다(이름순이면 자리로 누구인지 맞춘다, api 리뷰).
- **items** — 지우지 않은 근무스케줄 중 근무일이 기간 안이고, 그 직원의 `schedulableDates` 에 그 근무일이 있는 것. 계약이 그 뒤 끝나 받을 수 없게 된 날의 근무스케줄은 행이 없으니 내지 않는다.
- **days** — 기간의 날마다. `headcount` 는 그날 근무스케줄이 있는 직원 수(가린 직원 포함). `coverage` 는 그날 한국 00:00부터 30분 칸 48개마다 근무 중인 인원 — 칸 [t, t+30분) 과 근무가 겹치면 센다. 자정을 넘는 근무는 다음 날 새벽 칸에도 센다 — 22:00~익일 02:00 이면 시작한 날 22~24시와 다음 날 00~02시 칸 모두(Q4, 2026-10-21 재영). 막대 · `headcount` 는 시작한 날로 센다. 그래서 첫날 새벽 칸을 채우려고 판정 · 읽기를 기간 하루 앞에서 시작한다(그 하루는 행 · 항목에 넣지 않는다). 화면은 공백(그날 첫 근무 시작~마지막 근무 종료 사이 0인 칸)과 혼자 근무를 이것으로 그린다.
- Q5(가린 행) · Q6(받을 수 없게 된 날의 근무스케줄은 내지 않음)는 위 기본값대로(2026-10-21 재영).
- ponytail: 날마다 「받을 수 있는 직원」 쿼리를 한 번씩(최대 43번, 차례로 — 한꺼번에 던지면 연결 풀을 다 잡는다) 돈다 — 판정을 한 곳(`schedulable`)에만 두려고. 느려지면 계약 · 이력을 한 번 읽어 JS 로 판정한다.
- 같은 기간의 출퇴근 기록(#202 완료 조건)은 출퇴근 API 가 생길 때 붙인다 — 이 PR 밖이다.

## 저장 알림 (#201, 세 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/pantheon`, 브랜치 `hitmonchan`(origin/main `1836c9a`).

- 등록 · 수정 · 삭제가 저장 트랜잭션 안에서 그 직원에게 직원 알림 하나 · 받는 사람 하나 · 앱 푸시 발송 대기 하나를 만든다(STAFF-15). 템플릿 `PUSH_SCHEDULE_CHANGED`(`#{근무지}` · `#{변경내용}`), `related_type = WORK_SCHEDULE`.
- `#{변경내용}`: 등록 「10월 21일(수) 09:00~18:00 추가」 · 삭제 「… 삭제」 · 수정 「전 → 후」(같은 근무일이면 뒤 날짜 생략), 자정 넘김 「익일 02:00」, 24:00 끝 「24:00」, 휴게만 바뀌면 「… 휴게 30분 → 60분」, 시각 · 휴게가 함께 바뀌면 시각 변화만(Q7, 2026-10-21 재영).
- 수신 설정 묶음 근무스케줄을 끈 계정은 알림함에만(NTF-14). 시간과 관계없이 곧바로. 퇴직 정리 삭제는 알리지 않는다(PAY-14).
- 템플릿을 쓸 수 없거나(없음 · 채널 · 사용 안 함 · 렌더 실패) 받을 계정이 없으면 알림 없이 저장만 하고 로그를 남긴다(NTF-25). 앱 푸시를 끌지는 템플릿의 수신 설정 묶음으로 본다. DB 오류는 저장째 되돌린다.
- 실제 발송은 #321(FCM 등) — 수행 임박 알림처럼 발송 대기 행만.
- 함께: 조회 응답 `employmentType` 을 openapi enum 으로, 가린 행은 화면이 key 를 순번으로(api #103 리뷰 참고).

## 일괄 등록 (#199, 네 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/stonehenge`, 브랜치 `primeape`(origin/main `f693867`).

- `POST /work-schedules/bulk` (create) `{ workDate, rows: [{ staffMemberId, startTime, endTime, breakMinutes }] }`, 1~100줄. 화면이 줄마다 계약 값으로 미리 채워 보내고 서버는 받은 값을 그대로 저장한다.
- 줄마다 한 건 등록과 같은 규칙(계약 기간 · 가입 · 퇴직일 · 겹침 · 범위 · 본사 동의)으로 따로 저장한다. 걸린 줄만 `failed: [{ index, staffMemberId, statusCode, code, message }]`, 저장한 줄은 `created`. 예상 못 한 오류도 그 줄만 실패(500 `WORK_SCHEDULE_SAVE_FAILED`)로 남기고 계속한다 — 응답이 늘 실제 저장과 같게. 줄 형식 오류는 전체 400.
- 알림은 다 저장한 뒤 바뀐 직원마다 한 번, 같은 직원의 여러 줄은 시작 시각순으로 「, 」로 묶는다. **알림은 줄 저장과 다른 트랜잭션**이다(직원마다 하나) — 한 건 등록 · 수정 · 삭제와 달리 저장이 커밋된 뒤라, 알림이 실패해도 저장은 남고 로그만 남는다.

## 지난 주 복사 (#200 · 화면 #204, 다섯 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/petra`, 브랜치 `poliwrath`(origin/main `adf49b9`). 근거: Plane #200 완료 조건, 목업 STAFF-13 미리보기(직원 · 지난 주 · 이번 주 · 처리).

- `GET /work-schedules/copy-last-week?storeId=&weekStart=` (create) — 미리보기. `POST /work-schedules/copy-last-week` `{ storeId, weekStart }` (create) — 복사. `weekStart` 는 복사해 넣을 주의 월요일(YYYY-MM-DD), 월요일이 아니면 400. 원본은 직전 주(월~일) 고정.
- **빈 주에서만**: 그 점포에 그 주(근무일 기준) 지우지 않은 근무스케줄이 한 건이라도 있으면 409 `WORK_SCHEDULE_WEEK_NOT_EMPTY` — 미리보기 · 복사 둘 다.
- 원본 한 건마다 근무일 +7일 · 같은 시각 · 같은 휴게로 만든다. 한 건 등록과 같은 판정(가입 · 계약 기간 · 퇴직일 · 겹침 · 범위 · 본사 동의)에 걸리면 그 건만 뺀다 — 사유 코드: `WORK_SCHEDULE_NO_CONTRACT`(제외 · 근로계약 미체결) · `WORK_SCHEDULE_AFTER_RETIREMENT`(제외 · 퇴직, 퇴직일 함께) · `WORK_SCHEDULE_NOT_JOINED` · `WORK_SCHEDULE_OVERLAP`. 넣는 사이 동의가 철회되면(`WORK_SCHEDULE_HIDDEN`) 복사 전체를 409 `WORK_SCHEDULE_COPY_HIDDEN_STAFF` 로 막는다. 제외는 날짜 단위로 모은다.
- 응답(미리보기 · 복사 같은 모양): `{ storeId, sourceWeekStart, weekStart, staff: [{ staffMemberId, name, retiredDate, source: { days, minutes }, copied: { days, minutes }, excluded: [{ workDate, code }] }], newcomers: [{ staffMemberId, name }] }`. `minutes` 는 휴게를 뺀 근무 분. `newcomers` 는 이번 주에 받을 수 있지만 지난 주에 근무스케줄이 없는 직원(「지난 주 없음 · 따로 넣는다」).
- **본사 계정 · 가려진 직원**(Q9, 2026-10-21 재영 · PAY-13): 원본 주에 본사에게 가려진 직원(본사 제공 동의 없는 가맹 직원)이 있으면 본사 계정은 미리보기 · 복사 모두 409 `WORK_SCHEDULE_COPY_HIDDEN_STAFF`(「가맹 점포 관리자가 복사해 주세요」) — 그 직원만 빠져 빈 주가 망가지지 않게. 가린 줄을 보이면 몇 명인지 드러나므로 미리보기도 막는다. `newcomers` 에서도 가려진 직원은 뺀다.
- Q8(받을 수 있는 날만 복사, 나머지는 제외 사유) · Q10(트랜잭션 하나, 같은 트랜잭션에서 직원마다 알림)은 기본값대로(2026-10-21 재영).
- 복사는 트랜잭션 하나다 — 점포 · 주 단위 advisory lock(배타)을 잡고 빈 주를 다시 본 뒤 차례로 넣는다(동시에 두 번 눌러도 한 번만). 한 건 · 일괄 등록 · 수정은 넣을 주의 같은 키를 공유로 직원 행보다 먼저 잡는다(빈 주 직렬화, api #110 리뷰). 복사는 원본 직원 행을 ID 순으로 잠그고, TO-DO 등록의 점포 직원 행 잠금도 ID 순으로 맞췄다(교착 방지). 미리보기 권한 create 는 의도(복사할 수 있는 사람만 연다). 넣을 때 다시 판정해 그사이 바뀐 건은 뺀다. 알림은 같은 트랜잭션에서 복사로 근무스케줄이 생긴 직원마다 한 번(같은 직원 여러 건은 시작 시각순으로 묶음).

## 변경 이력 조회 (#608, 여섯 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/alhambra`, 브랜치 `golduck`(origin/main `d851aeb`). 근거: Plane #608 완료 조건, 목업 근무스케줄 관리 「변경 이력」(시각 · 추가/수정/삭제 · 「서지안 09-04 13:00-21:30 → 09:00-17:00 · 정하윤」).

- `GET /work-schedules/histories?storeId=&from=&to=&staffMemberId=&page=&pageSize=` (read). 점포는 업무 범위 안(밖이면 404). `pageSize` 20 · 50 · 100(기본 20), `page` 1부터. 새것부터(변경 일시 · ID 내림차순).
- 기간 `from` · `to` 는 **변경 일시의 한국 날짜**(둘 다 포함, 선택) — Q11, 2026-10-21 재영 확정.
- 응답 `{ items, total }`, 한 줄 `{ workScheduleHistoryId, workScheduleId, changeType, changedAt, changedBy: { adminAccountId, name }, staffMemberId, staffName, before, after }`. `before` · `after` 는 `{ workDate, startTime, endTime, breakMinutes }` 또는 null(등록은 before 없음, 삭제는 after 없음). 퇴직 처리로 지운 것도 `DELETED` 로 보인다(처리한 관리자가 주체).
- 본사 계정이 가맹 점포를 보면 본사 제공 동의 없는 직원의 이력은 **빼고 센다**(개인 단위로 보이지 않음, ATT-30) — 직원 필터로 그 직원을 고르면 404. Q12, 2026-10-21 재영 확정. 근무스케줄 화면은 가린 행을 보이지만(ATT-30 A안), 이력 줄은 가려도 근무 시각이 드러나므로 이력에서는 아예 뺀다.

## 파기 배치 (#609, 일곱 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/angkorwat`, 브랜치 `seaking`(origin/main `310bc38`). 근거: Plane #609 완료 조건, 운영 정책 RET-02, 쟁점 STAFF-42.

- `work-schedule-purge` 배치 — 매일 한국 시각 03:00, `BatchLockService.runExclusive` 안. 자정 배치(퇴직 확정 · 도입문의 파기)와 비켜 둔다.
- 생성일(`created_at`)의 한국 날짜로 3년이 지난 근무스케줄을 지운다: `created_at < 3년 전 오늘의 한국 0시`(생성일 당일부터 3년째 되는 날까지 남는다, 도입문의 파기와 같은 꼴). 삭제 표시된 것도 같은 기준.
- 하루에 5,000건까지, 생성일이 오래된 것부터(이관 · 밀린 분량이 60초 제한에 계속 걸리지 않게, api #112 리뷰).
- 대상을 먼저 `FOR UPDATE` 로 잠그고, 그 ID 로 변경 이력(외래키 RESTRICT) → 근무스케줄 순으로 지운다 — 잠그기 전 스냅샷으로 이력을 지우면 그사이 수정 · 삭제가 커밋한 이력을 놓쳐 23503 으로 배치째 실패한다(api 리뷰). 지운 건수는 배치 로그에 남는다.
- 그 근무스케줄을 가리키는 저장 알림(`related_type = WORK_SCHEDULE`, 본문에 근무지 · 근무일 · 시각)도 받는 사람 · 발송까지 같은 트랜잭션에서 지운다(Q13, 2026-10-21 재영 — 도입문의 파기와 같다). 「직원 알림함 14일」은 화면 표시 기간이고 행은 남기 때문이다. 묶음 알림은 첫 근무스케줄을 가리키므로 그것이 지워질 때 함께 지워진다.

## 폐점 점포 생성 거절 (WHALEERP-614, 여덟 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/alhambra`, 브랜치 `poliwag`(origin/main `5dd3388`). 근거: 재영 결정(2026-10-22 — 폐점 점포는 점포 선택에 그대로 보이되 근무스케줄 생성은 막는다), 운영 정책 ATT-33, Plane WHALEERP-614.

- 근무스케줄을 새로 만드는 요청 셋을 폐점 점포(`stores.store_status_code = CLOSED`)면 400 `WORK_SCHEDULE_STORE_CLOSED` 「폐점 점포는 근무스케줄을 등록할 수 없습니다」로 거절한다.
  - 등록 `POST /` — 한 건 등록의 몸통(`insert`)이 직원의 근무지로 본다.
  - 여러 명 일괄 `POST /bulk` — 같은 몸통이라 그 줄이 `failed` 에 같은 코드로 남는다.
  - 지난 주 복사 `GET · POST /copy-last-week` — 점포를 받으므로 빈 주를 세기 전에 통째로 거절한다(미리보기도 — 할 수 없는 복사를 보이지 않는다).
- 폐점 판정은 점포 행(`stores.store_status_code`)을 따로 읽는다 — 관리 범위(`getManageableStores`)는 여러 기능이 같이 쓰고 점포 상태를 주지 않아 넓히지 않는다. 등록 · 일괄은 저장 트랜잭션 안(직원의 근무지가 정해진 뒤), 복사는 빈 주를 세기 전에 읽는다. 점포 행은 잠그지 않는다 — 요청 도중 폐점 처리가 끼면 그 요청은 지나간다(폐점은 드물고 사람이 하는 일이다).
- 막지 않는 것: 조회 · 변경 이력 조회(완료 조건), 수정 · 삭제(이미 있는 근무스케줄의 정리 — 관리자 웹도 막지 않는다, front #95). 받을 수 있는 직원 · 기본값 조회도 그대로 둔다(읽기만).
- e2e: 폐점 점포에서 등록 · 일괄(줄 실패 코드) · 복사 미리보기 · 복사가 400 `WORK_SCHEDULE_STORE_CLOSED`, 같은 점포의 조회 · 이력 조회 · 수정 · 삭제는 된다.

## 권한 점검 (#206, 아홉 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/angkor-wat`, 브랜치 `magnemite`(origin/main `203d916`). 근거: Plane WHALEERP-206, 2026-10-22 재영(테스트만 더한다).

- 점검 결과 제품 코드는 고치지 않는다. 모든 경로가 `AdminScopeService.getManageableStores` 로 범위를 정하고 범위 밖은 404, 직원 앱 토큰은 메뉴 권한 가드가 403, 본사 가림은 이미 e2e 로 고정돼 있다. 직원이 자기 근무스케줄을 보는 것은 API 가 아직 없어 #205 에서 본다.
- 지금 e2e 는 전체 점포 BP 마스터 한 명으로만 돌아 셋이 비어 있다. 이것을 더한다.
  - 매핑 관리자(가맹관리자, `is_all_stores = false`)가 매핑 밖 점포의 조회 · 선택지 · 이력 · 복사 미리보기를 부르면 404, 매핑된 점포는 200. 본사 역할(BP 관리자)로 보면 범위 밖 점포를 「유형 모름」으로 한 번 더 가려 404 가 나서, 범위 필터를 빼도 시험이 통과했다(범위 필터를 지워 확인) — 가림이 없는 가맹 역할로 범위 필터만 본다.
  - 매핑 밖 직원의 기본값 · 등록, 매핑 밖 근무스케줄의 수정 · 삭제가 404 이고 근무스케줄 · 이력이 그대로다(지금 「범위 밖 404」 시험은 없는 ID 만 쓴다).
  - 직원 앱 토큰(실제 접속 상태)으로 조회 · 등록 · 수정 · 삭제하면 403.
- 공용 DB 의 가맹마스터 고정 권한 그룹(FM000001) 근무스케줄 삭제 권한은 재영 지시로 켰다(2026-10-22, 테스트 데이터). 1팀 초기 데이터 마이그레이션은 그대로다.

## 직원 근무 앱 월 달력 조회 (#205, 열 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/acropolis`, 브랜치 `seel`(origin/main `2b81910`). 근거: Plane WHALEERP-205, 목업 staff `docs/mockup/app/work.html`(WORK-1 · WORK-4), 2026-10-22 재영(재직 소속만 · 예정만 · 근무지는 앱 전역으로 저장).

- `GET /me/work-schedules?staffMemberId=&month=YYYY-MM` — 직원 앱 토큰만(`@UserTypes('account')`, 관리자 토큰 403). 내 소속 하나(= 직원 레코드, `GET /me/memberships` 의 `staffMemberId`)의 그 달 근무스케줄을 시작 일시순으로 `{ items }` 로 준다. 항목 모양은 관리자 쪽 `WorkScheduleDto` 그대로(근무일 · 시작 · 종료 · 휴게 · 순간).
- 소속 기준은 내 소속 근무지 · TO-DO 와 같은 `ACTIVE_STAFF`(체결 완료 계약 · 가입 완료 · 재직). 남의 레코드 · 퇴직한 레코드 · 없는 id 는 모두 같은 404 「소속을 찾을 수 없습니다」. 퇴직 예정이면 그대로 보인다(퇴직일 뒤 근무스케줄은 퇴직 확정 때 지워진다).
- 달은 근무일(시작 일시의 한국 날짜) 기준이다 — `[그 달 1일 한국 0시, 다음 달 1일 한국 0시)` 에 시작한 것. 앞달 말일 밤에 시작해 1일로 넘어온 근무는 앞달 것이다(관리자 화면 막대와 같다).
- 지운 것은 빼고 본사 제공 동의와는 상관없다(본인 것이다). 쓰기 경로는 없다 — 고치기는 관리자 웹만.
- 실제 출근 · 실제 근무 막대(목업의 채운 칠)는 출퇴근 기록이 생길 때 붙인다(2026-10-22 재영 — 이번에는 예정만).
- 시험: 규칙 단위(달 → 범위, 12월 → 다음 해), e2e(내 재직 소속의 그 달 것만 · 시작순 · 지운 것 · 앞달 말일 자정 넘김 제외, 남의 · 퇴직 · 없는 소속 404, 형식 400, 관리자 토큰 403).

## 다음 PR

staff #205 — 근무 탭의 근무지 카드 · 시트(앱 전역 현재 근무지, 쿠키)와 월 달력 · 고른 날 상세.

## 질문과 답 (기획 세션, 2026-10-21 재영)

- **Q1** 종이 계약 체결 완료 · 가입 전 직원도 받나? → 받지 않는다. 가입 완료한 직원만(TO-DO 와 같다). 선택지에서 빼고 서버도 거부한다.
- **Q2** 본사 계정이 동의 없는 가맹 직원의 근무스케줄을 다루나? → 못 한다. 선택지에서 빼고 요청은 거부한다.
- **Q3** 시각 단위? → 시작 · 종료는 30분 단위만. 휴게에는 단위를 걸지 않고 0 이상 · 근무 길이 미만만 본다.
- 해석 넷(자정 넘김 · 24시간 미만, 휴게 < 근무 길이, 삭제는 조건 없음, 수정은 바뀐 값으로 다시 확인)과 PR 나누기(#198 → 조회 → #201)는 그대로.

## 확인

- 단위 시험 `src/work-schedules/*.spec.ts` — 시각 계산 · 판정 · 이력 모양.
- e2e `test/work-schedules.e2e-spec.ts` — 일회용 DB(마이그레이션 전부 적용)에서 겹침 409 · 맞닿음 · 쪼갠 근무 · 자정 넘김 겹침, EXCLUDE 제약 이름, 30분 단위 · 24시간 · 휴게 400, 계약 종료일 · 가입 전 · 퇴직일 · 동의 없는 가맹 직원, 기본값, 수정 · 삭제 이력.
