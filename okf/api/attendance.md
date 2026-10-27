---
type: API
title: Attendance
description: 직원 근무 앱 출퇴근(WHALEERP-207) — GET /me/attendance/records(내 기간 기록 · 보정 이력, 221 · 222) · GET /me/attendance(고른 근무지 좌표 · 반경 100m · 동의 · 출근을 막는 까닭 · 열린 출근 · 오늘 근무스케줄), POST /me/attendance/location-reads(버튼을 누를 때마다 위치 읽음 — 확인자료 수집 · 이용) · check-in · check-out(계정 행 잠금, 서버 수신 시각, 확인 필요 사유만, 위치 읽음을 기록에 연결), 확인 필요 사유 값, 3년 보존 뒤 파기 배치 attendance-purge.
tags: [attendance, staff-app, batch]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-23T04:55:33Z }
sources:
  - id: records
    resource: ../../src/attendance/attendance-records.service.ts
    title: 관리자 웹 일별 출퇴근 GET /attendance-records/daily(WHALEERP-217)
    last_modified: 2026-10-23T04:55:33Z
  - id: day-status
    resource: ../../src/attendance/attendance-day-status.ts
    title: 일별 출퇴근 상태 판정(API 전용 enum AttendanceDayStatus)
    last_modified: 2026-10-23T04:55:33Z
  - id: service
    resource: ../../src/attendance/my-attendance.service.ts
    title: MyAttendanceService — 출퇴근 화면 · 출근 · 퇴근
    last_modified: 2026-10-22T09:27:05Z
  - id: rules
    resource: ../../src/attendance/attendance-rules.ts
    title: 반경 100m · 확인자료 수집 방법 · 받는 사유
    last_modified: 2026-10-22T09:27:05Z
  - id: purge
    resource: ../../src/attendance/attendance-purge.ts
    title: 3년 보존 뒤 파기 배치 attendance-purge(WHALEERP-209)
    last_modified: 2026-10-22T08:58:15Z
  - id: migration
    resource: ../../prisma/migrations/20261026174710_team3_attendance_review_reasons/migration.sql
    title: 반경 밖 출근 · 확인 필요 기록 포함 enum 값(WHALEERP-209, ATT-11)
    last_modified: 2026-10-22T08:58:15Z
---

# What it is

직원이 직원 근무 앱에서 출근 · 퇴근을 등록한 기록(`attendance_records`)이다. 위치 판정은 휴대전화 안에서 하고, 좌표와 판정
결과(반경 안 · 밖, 오차)는 서버로 오지도 저장되지도 않는다(운영 정책 ATT-05 · ATT-19). 확인 필요가 붙은 기록에만 사유를 남기고,
관리자가 보정하거나 「이상 없음」으로 검토를 마치면 지운다.

# Staff app API

근무지는 앱 전역에서 고른 소속 하나다(`staffMemberId`, ATT-07) — 가장 가까운 곳을 고르지 않는다. 소속 규칙은 `GET /me/memberships`
와 같은 `ACTIVE_STAFF` 이고 아니면 모두 같은 404 다. 관리자 토큰은 403.[^service]

| 경로 | 하는 일 |
|---|---|
| `GET /me/attendance?staffMemberId=` | 고른 근무지(좌표 · 반경 · 위치 적용), 위치정보 동의(`state` · `needsReconsent` · 지금 약관 버전), 출근을 막는 까닭(`checkInBlock`), 열린 출근, 오늘 근무스케줄 |
| `POST /me/attendance/location-reads` | 위치 읽음 — `{ staffMemberId }`, 확인자료 수집 · 이용을 남기고 `locationReadId` (ATT-22) |
| `POST /me/attendance/check-in` | 출근 — `{ staffMemberId, reviewReason?, locationReadId? }`, 사유는 `OUT_OF_RADIUS_CHECKIN` 만, 위치를 보는 점포는 `locationReadId` 필수 |
| `POST /me/attendance/check-out` | 퇴근 — `{ staffMemberId, reviewReason?, locationReadId? }`, 사유는 `OUT_OF_RADIUS_CHECKOUT` · `MOCK_LOCATION` |

- **좌표 · 거리 · 반경 안밖은 받지 않는다**(ATT-05 · ATT-19). 앱이 휴대전화 안에서 판정하고, 확인 필요가 붙을 때만 사유를 보낸다.
  위치 조작 감지는 앱이 출근을 막으므로 출근 본문의 `MOCK_LOCATION` 은 400 이다(ATT-21). 본문에 좌표 · 오차 · 반경 안밖 같은 칸이
  오면 전역 `ValidationPipe`(`forbidNonWhitelisted`)가 400 으로 막는다(e2e).
- **1차의 한계(ATT-24, 2026-09-29)**: 앱 무결성 확인(Play Integrity · App Attest)은 하지 않는다. 반경 밖 사유는 앱이 스스로 붙여
  보내는 것이라, 변조한 앱이나 api 를 직접 부르면 사유 없이 등록할 수 있다 — 2차에서 다시 본다. 또 지금 직원 근무 앱은 웹
  Geolocation 으로 위치를 읽어 운영체제의 모의 위치 여부를 알 수 없다 — 위치 조작 감지(`MOCK_LOCATION`)는 값과 막는 규칙만 있고
  실제로는 판정되지 않는다(앱 포장 뒤 네이티브 위치로 붙인다).
- **반경은 모든 점포 100m** 다(`DEFAULT_GEOFENCE_RADIUS_M`).[^rules] 1차는 모든 점포 100m 고정이고 넓히는 기능은 두지 않는다
  (운영 정책 ATT-02, 2026-10-23 재영 — 1팀 `stores` 에 반경 칸도 없다).
- **열린 출근**은 계정의 지금 쓸 수 있는 소속(`ACTIVE_STAFF`, 내 소속과 같은 판정)에서만 찾는다 — 퇴직한 소속에 남은 열린 출근은
  직원이 그 소속을 고를 수 없어 닫지 못하니 다른 근무지 출근을 막지 않고, 관리자 화면에 퇴근 미등록으로 남는다(PR #159 리뷰).
- **대신 등록 겹침**: 그 직원의 기록과 시간이 겹치면(열린 출근은 이미 있는 것이든 지금 출근만 넣는 것이든 지금까지 근무 중으로 — 다만 3개월보다 오래 열린 것은 그 시각만, 출근 없는 퇴근은 그 시각 한 점으로, 맞닿기만 한 짝은 받는다) 409 `ATTENDANCE_OVERLAP`(겹친 날 · 열린 출근이면 그 시각을 문구에) — 다시 누르기 · 두 관리자의 같은 등록이 같은 짝을 두
  벌 만들지 않게. 계정이 없는 직원(가입 전)은 직원 행을 잠그고 열린 출근을 그 직원 레코드에서 본다.
- **좌표 없는 점포**: 위치 적용이 켜진 점포에 위도 · 경도가 없으면 앱 출근을 막고 「근무지 위치가 없습니다」를 보인다. 서버도 출근을
  422 `STORE_LOCATION_MISSING` 으로 막는다 — 직원 위치가 필요 없는 검사라 ATT-24 한계와 다르다(2026-10-26 재영). 퇴근은 막지 않고
  위치 읽음 · 동의 없이 받는다(열린 출근을 닫아야 한다). 위치 읽음도 422 `STORE_LOCATION_MISSING`(앱이 화면을 다시 받는다). 위치 읽음이
  필요한데 없으면 400 `LOCATION_READ_REQUIRED`(그사이 좌표가 생긴 낡은 화면 — 앱이 다시 받는다). 위치 적용이 꺼진 점포는 막지 않는다(운영 정책 ATT-36, 2026-10-23 재영).
- **잠금**: 출근 · 퇴근은 계정 행을 `FOR UPDATE` 로 잠그고 판정한다 — 위치정보 동의 바꾸기와 같은 자물쇠라 같은 계정의 요청이 한
  줄로 선다. 동시 출근 다섯은 201 하나 · 409 넷, 동시 퇴근 셋은 201 하나 · 409 둘(e2e).
- **열린 출근은 계정에 하나**(운영 정책 ATT-35, 2026-10-23 재영): 짝 퇴근이 없는 출근을 계정의 지금 쓸 수 있는 소속(`ACTIVE_STAFF`)에서 찾는다(대신 등록 포함 — 퇴직한 소속에 남은 것은 아래 「열린 출근」, 재영 확인 대기). 있으면 출근 409
  `ALREADY_CHECKED_IN`(그 출근을 `openCheckIn` 으로), 퇴근은 고른 소속의 것이어야 하고 아니면 409 `NO_OPEN_CHECK_IN`(다른 소속의
  것이면 함께). 오래 열린 출근도 그대로 막는다 — 관리자 보정으로 닫는다. 퇴근은 출근한 다음 날(한국)까지 받는다 — 그 뒤면 409
  `CHECK_OUT_EXPIRED`(며칠이 출근한 날 하루의 근무로 급여에 들어가지 않게, 2026-10-27 ⑥ 리뷰). 화면 · 409 의 `openCheckIn.isCheckOutExpired`
  로 앱이 퇴근 버튼 대신 관리자 보정 안내를 보인다. 다음 날 끝까지 받으므로 한 짝은 최대 48시간 가까이 된다(길이 상한 · 확인 필요
  사유는 재영 확인 대기).
- **동의**: 위치를 보는 점포(`is_location_applied`)면 동의가 살아 있고 지금 약관 버전이어야 하고 멈추지 않았어야 한다 — 아니면 403
  `LOCATION_CONSENT_REQUIRED` · `LOCATION_PAUSED`(ATT-06 · ATT-23 · ATT-26). 위치를 보지 않는 점포는 동의를 보지 않고, 사유가 오면 400,
  확인자료도 남기지 않는다(운영 정책 ATT-36, 2026-10-23 재영).
- **계약(ATT-12, 2026-10-08 재영)**: 출근은 오늘(근무일)을 덮는 체결 완료 근로계약이 있어야 한다 — 근무스케줄과 같은
  `contractCovers`(한 번이라도 체결된 계약의 기간). 없으면 422 — 서명 대기 계약이 있으면 `CONTRACT_PENDING_SIGNATURE` 와
  `contractId`, 없거나 퇴직일이 지났으면 `NO_CONTRACT`. 퇴근은 계약을 보지 않는다 — 열린 출근을 닫지 못하면 기록이 더 망가진다.
- **위치 읽음 `POST /me/attendance/location-reads { staffMemberId }`(운영 정책 ATT-22, 2026-10-26 재영)**: 앱은 화면을 열 때 위치를
  읽지 않고 출근 · 퇴근 버튼을 누를 때만 읽는다. 읽을 때마다 이 경로로 확인자료(`location_access_logs`) 수집 · 이용 두 줄(같은 처리
  일시, `method` 「기기 GPS · 휴대전화 안 판정」, 위치 없음)을 남기고 수집 줄 id 를 `locationReadId` 로 돌려준다 — 위치 읽기나 등록의
  성공 · 실패와 관계없다. 계정 행 잠금 안에서 쓴다. 위치를 보지 않는 점포는 400, 동의가 없거나 멈췄으면 403(이때 앱은 읽지 않는다).
- **기록**: 기록 시각 = 서버 수신 시각(209), `entry_method = SELF`. 위치를 보는 점포의 출근 · 퇴근은 이번 위치 읽음(`locationReadId`,
  아직 기록에 잇지 않은 내 것)이 있어야 하고(없으면 400), 등록에 성공하면 그 수집 · 이용 두 줄을 기록에 잇는다. 위치를 보지 않는
  점포에 `locationReadId` 가 오면 400. `has_unsigned_warning` 은 쓰지 않는다 — ATT-12 로 경고 뒤 허용이 막기로 바뀌었다.
- **내 기록 `GET /me/attendance/records?staffMemberId&from&to`**(WHALEERP-221 · 222, 직원 앱 출퇴근 현황) — 내 소속 하나의 기간
  (366일 이하, 끝이 앞이면 400) 기록을 관리자 웹 기간 조회와 같은 하루 줄(예정 · 출퇴근 짝 · 상태 · `isPayslipConfirmed`)로, 근무스케줄이나
  기록이 있는 날만 준다. 보정 · 대신 등록한 날은 `edits`(관리자 웹 이력과 같은 모양, 새것부터 — 「이상 없음」만 받은 날은 빈 배열,
  ATT-19)가 붙는다. 보기만 하고 위치 동의는 보지 않는다(대신 등록을 받는 동의 없는 직원도 본다). 내 소속이 아니면 404.
  근무 시간 · 연장은 급여 계산과 같은 값(`payInputOf` · `weekStats` — 휴게 뺌, 주 40시간 초과 포함)으로 기간 합 `totals` 와 기간에
  걸친 월 ~ 일 주마다 `weeks` 를 준다. 앱은 그대로 보인다(2026-10-26 재영).

[^service]: `src/attendance/my-attendance.service.ts`
[^rules]: `src/attendance/attendance-rules.ts`

# Admin daily view

관리자 웹 「출·퇴근 현황 조회」(메뉴 `/attendance-records`, MN000025, 읽기 권한, WHALEERP-217 · 219).[^records] 두 경로 모두 점포 조건
`storeIds`(쉼표 · 반복, 1000개까지)와 `storeTypes`(DIRECT · FRANCHISE — 폐점 점포는 뺌)를 받는다 — 상단 점포 범위 ↔ 필터의 점포, TO-DO
목록과 같은 규칙이다. 둘 다 없으면 업무 범위 전체이고, 업무 범위 밖 점포는 오류 없이 빠진다. 계정을 쓸 수 없으면 403.

- `GET /attendance-records/daily?date=` — 그날. 줄은 근무스케줄을 받을 수 있는 직원(근무스케줄 관리의 `schedulable`)과 그날 근무스케줄 ·
  출퇴근 기록이 있는 직원이다 — 퇴직한 직원도 그날 기록이 있으면 나온다. 점포 · 이름순.
- `GET /attendance-records?from=&to=&staffMemberId=` — 기간(92일 이하, 관리자 보정 범위 최근 3개월). 근무스케줄이나 기록이 있는 직원 ·
  날만(휴무 줄 없음), 날짜 내림차순. 직원을 주면 그 직원만이고, 점포 조건 안의 직원이 아니거나 본사에게 가려지는 직원이면 404.
- 줄: 날 · 직원(이름 · 번호) · 점포 · 고용 형태 · 재직 · 예정 · 출근과 짝 퇴근(자정을 넘긴 퇴근도 출근한 날) · 확인 필요 사유 · 등록 방식 ·
  보정됨(`isCorrected`, 보정 이력 있음) · 상태. 필터 7개(STAFF-31)는 화면이 받은 줄을 거른다.
- 상태 `AttendanceDayStatus`(API 전용 enum, STAFF-31 의 여섯)는 기록에서 만든다.[^day-status] 판정 기준은 정책에 없어 가장 단순하게
  정했고 재영 답으로 그대로 확정했다(운영 정책 ATT-34, 2026-10-23 — 지각 유예 없음, 근무스케줄 없는 날 출근은 정상): 근무스케줄 · 기록 없음 = 휴무, 짝 없는 퇴근 = 출근 미등록, 퇴근을 더 기다리지 않는 날의 퇴근 없는 출근 = 퇴근 미등록(퇴근은 다음 날까지 받으므로 어제 출근은 근무스케줄이 모두 자정 전에 끝났을 때만, 그 전 날은 모두 — `checkOutDue`, 밤샘 근무가 근무 중에 퇴근 미등록으로 보이지 않게),
  첫 출근 분이 첫 근무스케줄 시작 분보다 늦으면 지각(유예 없음), 기록 없이 시작이 지난 근무스케줄 = 미출근, 시작 전이면 null.
- 본사 계정에게 동의 없는 가맹 직원(ATT-30)은 줄째로 빼고 `counts`(상태별 인원)에만 센다 — 목업 STAFF-31 · Plane 219 「기록은 보이지
  않고 점포별 숫자에만 센다」. 근무스케줄 관리(줄은 두고 이름을 비움, STAFF-39)와 다르다.

[^records]: `src/attendance/attendance-records.service.ts`
[^day-status]: `src/attendance/attendance-day-status.ts`

# Corrections, review, proxy

`src/attendance/attendance-edit.service.ts`(WHALEERP-218, 데모 「보정이 필요한 기록」). 대상은 출근과 그 짝 퇴근(출근 없는 퇴근이면 퇴근
하나)이고 어느 쪽 ID 로 불러도 같은 짝이다. 업무 범위 밖 · 본사에게 가려지는 직원은 404, 고칠 수 있는 것은 짝의 날 기준 최근 3개월.

| 경로 | 권한 | 하는 일 |
|---|---|---|
| `POST /attendance-records/:id/correction` | 수정 | 출근 · 퇴근 HH:mm(퇴근이 출근보다 이르거나 같으면 다음 날), 사유 필수. 지금보다 뒤 시각은 400(「아직 오지 않은 시각」 — 오늘 출근의 다음 날 퇴근을 미리 넣는 것 포함). 비었던 쪽은 새로 만든다 — 대신 등록이 아니라 이 보정 한 건이다(등록 방식 직원 등록, 이력 한 건, 2026-10-26 재영). 보정 이력(`attendance_corrections`, 전후 값 JSON)을 짝의 원래 기록에 남기고 확인 필요 사유를 지운다(ATT-19). 화면이 본 시각(`expectedCheckInAt` · `expectedCheckOutAt`)과 다르면 409 `ATTENDANCE_CHANGED` |
| `POST /attendance-records/:id/review` | 수정 | 「이상 없음」 — 값은 그대로, 사유만 지우고 검토자 · 시각. 사유가 없으면 409 |
| `POST /attendance-records/proxy` | 등록 | 대신 등록(ATT-20 · 26) — 위치를 보는 점포에서 위치정보 동의가 없거나(미동의 · 철회 · 약관 바뀜 · 가입 전) 일시 중지한 직원. 그 밖의 직원(위치정보 동의함)은 그날 출근 · 퇴근을 모두 안 찍었을 때만 두 시각을 함께(퇴근 없으면 400) 넣어 **보정**으로 채운다 — 직원 등록 기록 둘과 「출근 없음 · 퇴근 없음 →」 보정 이력 한 건, 직원 앱 연필. 그날 기록이 있으면 409 `ATTENDANCE_EXISTS`(그 줄을 보정, 2026-10-26 재영). 공통으로 그날 체결 완료 계약 · 퇴직일 전(422 `NO_CONTRACT`), 최근 3개월 · 오늘까지. 퇴근이 출근보다 이르거나 같으면 다음 날 퇴근이고, 출근 · 퇴근이 지금보다 뒤면 400(아무것도 남기지 않는다). 퇴근 없이 열린 출근이 있으면 409 |
| `GET /attendance-records/proxy-staff?date=` | 등록 | 대신 등록 선택지 — 점포 조건 안에서 그날 체결 완료 계약이 있는 직원, `isProxy`(false 면 기록 없는 날 보정). 그날이 확정 · 발송된 급여명세서 기간이면 `isPayslipConfirmed`(등록 전 경고) |
| `GET /attendance-records/:id/history` | 읽기 | 보정 이력과 대신 등록(처리자 · 일시 · 사유 · 전후 값), 새것부터 |

기간 조회(`GET /attendance-records`)의 줄에는 `edits`(보정 · 대신 등록 이력, 새것부터 — 이력 창과 같은 모양)가 붙는다. 보정이 필요한 기록의 「수정됨 08-30 정하윤」 · 「대신 등록 사유 · 정하윤」 꼬리를 그린다. 이력의 `byRole` 은 처리한 관리자의 권한 그룹 이름이다(데모 「정하윤 (BP 마스터)」).
기간이 월요일 ~ 일요일 한 주이면 `weekStaff`(줄에 나온 직원마다 근무 분 · 연장 분 · 주휴 대상)도 준다 — 급여 계산과 같은 입력(`payInputOf`)
· 규칙(`weekStats`)이라 근태 요약과 급여명세서 숫자가 어긋나지 않는다. 계약은 그 주에 걸친 체결 완료 계약 가운데 가장 늦게 시작한 것.
대신 등록 409(열린 출근)는 그 출근이 범위 밖 · 가려진 근무지면 보정을 권하지 않고 「다른 근무지에 퇴근하지 않은 출근이 있어…」로만
알린다(ATT-35 — 열린 출근은 계정에 하나라 막는 것은 그대로, e2e).

- 결과마다 `isPayslipConfirmed` — 그날이 확정 · 발송된 급여명세서 기간이면 true, 화면이 「급여에 영향이 갈 수 있다」고 알린다(218). 줄(`AttendanceDayItemDto`)에도 같은 값이 있어 패널을 열 때 미리 알린다.
- 짝을 `FOR UPDATE` 로 잠그고 다시 읽는다 — 동시 보정은 뒤 요청이 앞 결과를 보고 409.
- 보정이 만든 기록은 대신 등록이 아니라 보정 한 건이다(2026-10-26 재영). 「주휴 · 연장」 등 요약 계산은 급여 계산과 같다.
- 동의하지 않은 가맹 직원은 본사 화면의 근태 요약 숫자에도 넣지 않는다 — 근로계약 목록 상태별 개수(WHALEERP-133)와 같은 기준(ATT-30,
  2026-10-26 재영).

# Review reasons

`attendance_review_reason` 은 넷이지만 쓰는 것은 셋이다(쟁점 ATT-11 · ATT-4, 2026-10-20 재영).[^migration]

| 값 | 뜻 | 쓰임 |
|---|---|---|
| `OUT_OF_RADIUS_CHECKIN` | 반경 밖 출근 | 반경 밖에서도 출근을 받고 이 사유를 붙인다 |
| `OUT_OF_RADIUS_CHECKOUT` | 반경 밖 퇴근 | 반경 밖 퇴근도 받고 이 사유를 붙인다 |
| `MOCK_LOCATION` | 위치 조작 감지 | 출근은 막고, 퇴근은 받고 이 사유를 붙인다(ATT-21) |
| `ACCURACY_EXCEEDED` | 위치 오차 초과 | 더 쓰지 않는다. 운영 데이터가 없고 enum 값 삭제는 타입을 다시 만들어야 해서 값만 남겼다 |

확인 필요 출근 · 퇴근도 급여 계산에 그대로 들어가고, 그런 기록이 든 급여명세서에는 검토 대기 사유
`ATTENDANCE_NEEDS_REVIEW`(확인 필요 기록 포함)를 붙인다 — 초안을 만들 때 급여 기간의 사유가 남은(검토 전) 기록을 세어 「급여 기간에 확인 필요 출퇴근 기록이 N건 있습니다」로 붙인다([Payslips](/api/payslips.md)).

근무지(`store_id`)는 자동으로 고르지 않고 직원이 고른 곳이다(운영 정책 ATT-07, 2026-10-20 재영).

# Purge

`attendance-purge` 가 매일 한국 시각 03:30 에 `runExclusive` 안에서 돈다 — 03:00 근무스케줄 파기 뒤다.[^purge]

- 생성일은 서버 수신 시각(`received_at`)이다 — 기록 시각(`recorded_at`)은 대신 등록이면 지난 시각일 수 있다. 한국 날짜로 3년이
  지난 것을 지운다(근무스케줄 파기와 같은 꼴). 한 번에 `PURGE_BATCH_SIZE`(5000)건, 오래된 것부터.
- 대상을 `FOR UPDATE` 로 잠근 뒤, 대상을 가리키는 외래키(모두 RESTRICT)를 먼저 푼다.
  - 짝 출근(`check_in_attendance_record_id`)을 비운다 — 밤샘 근무의 퇴근은 출근보다 하루 늦게 기한이 차서 그날은 남는다.
    RESTRICT 는 행마다 바로 보므로, 같은 문장에서 함께 지우는 짝도 먼저 비운다.
  - 위치정보 확인자료(`location_access_logs.attendance_record_id`)는 연결만 비운다 — 확인자료는 계정 · BP 탈퇴 가운데 늦은
    쪽까지 남는다(RET-08 · ATT-22).
  - 보정 이력(`attendance_corrections`)은 기록과 함께 지운다.
- 일회용 DB 에서 확인했다(2026-10-22): 기한 지난 출근 · 대상끼리 짝인 출근 · 퇴근 3건이 지워지고, 하루 늦은 밤샘 퇴근은 짝만 비운 채
  남고, 확인자료는 연결만 비운 채 남는다.

[^purge]: `src/attendance/attendance-purge.ts`
[^migration]: `prisma/migrations/20261026174710_team3_attendance_review_reasons/migration.sql`

# 점검 (WHALEERP-216 · 223, 2026-10-23)

코드로 확인한 것과 남은 것. 남은 것은 정책 확인 대기다.

* **216 등록 권한 · 좌표 비저장** — 직원 토큰만(`@UserTypes('account')`), 소속은 토큰의 계정 것만(아니면 404), 근무지는 소속의
  점포(본문에서 받지 않음), 비로그인은 직원 앱 proxy 가 로그인으로 보낸다. 기기 좌표는 휴대전화 안 거리 계산에만 쓰고 서버 · 로그 ·
  분석으로 보내지 않는다. 본문에 좌표 · 오차 · 반경 안밖 칸이 오면 400(e2e). 확인자료(`location_access_logs`)는 위치를 보는 점포에서
  버튼을 눌러 위치를 읽을 때마다 수집 · 이용 두 줄이고(실패한 등록의 읽음도 남는다, e2e), 고치거나 지우는 api 가 없다(파기 배치는 기록
  연결만 비운다). 검토를 마친 사유는 지운다. 동의 시트는 「반경 밖이면 확인 필요 표시만 남고 관리자 검토 뒤 지웁니다」로 고쳐 법무
  검토(ATT-8)로 넘겼다(ATT-06, 2026-10-26 재영).
  * 남은 것: 관리자 · 본사 조회는 위치정보 「제공」으로 보지 않아 `PROVIDE` 줄을 남기지 않는다 — 법무 확인 대기(2026-10-26 재영).
    DB 수준의 수정 · 삭제 막기(트리거 · 권한)는 없다, ATT-24 한계(위 「1차의 한계」).
* **223 조회 · 보정 권한** — 경로마다 메뉴 권한(읽기: 일별 · 기간 · 이력, 등록: 대신 등록 · 선택지, 수정: 보정 · 이상 없음), 모든 경로가
  관리 범위(`getManageableStores`)로 거르고, 본사에게 가려지는 가맹 직원은 일별 · 기간 줄(이력 포함) · 이력 · 보정 · 이상 없음 · 대신 등록 ·
  선택지 모두 빠지거나 404(e2e). 직원 토큰은 관리자 경로 403, 직원은 내 소속 기록만 보고 고치는 경로가 없다. 메뉴는 읽기 권한이 없으면
  헤더에서 빠지고 주소로 들어와도 막힌다. 직원 앱 이력은 이름 없는 관리자를 로그인 아이디 대신 「관리자」로, 권한 그룹 없이 내린다.
  * 가맹마스터(FM000001)의 MN000025 에 등록 · 수정을 열었다 — 1차에는 가맹도 보정 · 대신 등록을 한다(운영 정책 ATT-37, 2026-10-26
    재영, 마이그레이션 `20261026174730_team3_franchise_attendance_permission`). 가맹관리자는 가맹마스터를 상한으로 권한 그룹에서
    켠다. 1팀 초기 데이터 요청서(R)와 다른 점은 1팀 전달 목록 26번이다.
  * 남은 것: 플랫폼 관리자는 메뉴가 보이지만 점포가 없어 빈 화면(WHALEERP-301, 다른 3팀
    화면과 같다). 대신 등록 409(열린 출근)는 계정 전체를 봐 다른 BP 점포 출근 여부를 드러낼 수 있다(열린 출근은 계정에 하나 규칙).

