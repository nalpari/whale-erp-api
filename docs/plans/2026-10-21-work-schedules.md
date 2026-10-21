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
- 알림은 다 저장한 뒤 바뀐 직원마다 한 번, 같은 직원의 여러 줄은 「, 」로 묶는다. 알림 실패는 로그만(저장은 남는다).

## 다음 PR

- 지난 주 복사(#200) — 저장 알림을 직원별로 묶어 한 번씩 부른다(일괄 등록과 같다).
- 변경 이력 조회(#608) · 파기 배치(#609).

## 질문과 답 (기획 세션, 2026-10-21 재영)

- **Q1** 종이 계약 체결 완료 · 가입 전 직원도 받나? → 받지 않는다. 가입 완료한 직원만(TO-DO 와 같다). 선택지에서 빼고 서버도 거부한다.
- **Q2** 본사 계정이 동의 없는 가맹 직원의 근무스케줄을 다루나? → 못 한다. 선택지에서 빼고 요청은 거부한다.
- **Q3** 시각 단위? → 시작 · 종료는 30분 단위만. 휴게에는 단위를 걸지 않고 0 이상 · 근무 길이 미만만 본다.
- 해석 넷(자정 넘김 · 24시간 미만, 휴게 < 근무 길이, 삭제는 조건 없음, 수정은 바뀐 값으로 다시 확인)과 PR 나누기(#198 → 조회 → #201)는 그대로.

## 확인

- 단위 시험 `src/work-schedules/*.spec.ts` — 시각 계산 · 판정 · 이력 모양.
- e2e `test/work-schedules.e2e-spec.ts` — 일회용 DB(마이그레이션 전부 적용)에서 겹침 409 · 맞닿음 · 쪼갠 근무 · 자정 넘김 겹침, EXCLUDE 제약 이름, 30분 단위 · 24시간 · 휴게 400, 계약 종료일 · 가입 전 · 퇴직일 · 동의 없는 가맹 직원, 기본값, 수정 · 삭제 이력.
