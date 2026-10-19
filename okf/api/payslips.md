---
type: API
title: Payslip list, detail and draft creation
description: GET /payslips 는 점포(storeIds) · 직원명(staffName) 필터도 받는다; POST /payslips · /payslips/bulk · GET /payslips/candidates — 초안 작성(직원별 · 그 달 일괄, 유효 계약 없으면 안 만들고 이미 있으면 건너뜀, 출퇴근 없으면 누락 사유); GET /payslips · /payslips/:id — 관리자 웹 급여명세서 관리 목록(급여 월 · 상태 필터, 상태 건수, 20·50·100 쪽) · 상세(항목 · 검토 대기 사유 · 이력 · 발송), 관리 범위와 본사 제공 동의 가림; GET /me/payslips · /me/payslips/:id — 직원 근무 앱의 발송된 내 명세서, 퇴직 뒤에도 3년.
tags: [payslip, list, admin, staff-app, masking, retention]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-19T04:32:48Z }
sources:
  - id: payslip-list-service
    resource: ../../src/payslips/payslip-list.service.ts
    title: PayslipListService (관리자 목록 · 상세, 가림 · 상태 건수)
    last_modified: 2026-10-19T04:32:48Z
  - id: my-payslips-service
    resource: ../../src/payslips/my-payslips.service.ts
    title: MyPayslipsService (직원 앱 — 발송 완료 · 본인 · 3년)
    last_modified: 2026-10-19T04:32:48Z
  - id: controllers
    resource: ../../src/payslips/payslips.controller.ts
    title: GET /payslips · /payslips/:id (급여명세서 관리 MN000009 조회)
    last_modified: 2026-10-19T04:32:48Z
  - id: my-controller
    resource: ../../src/payslips/my-payslips.controller.ts
    title: GET /me/payslips · /me/payslips/:id (직원 근무 앱 토큰)
    last_modified: 2026-10-19T04:32:48Z
  - id: draft-service
    resource: ../../src/payslips/payslip-draft.service.ts
    title: PayslipDraftService (작성 대상 · 초안 · 일괄 작성)
    last_modified: 2026-10-19T12:00:00Z
  - id: dto
    resource: ../../src/payslips/dto/payslip.response.dto.ts
    title: 관리자 응답 · 쿼리(payslip-list.query.dto.ts) · 직원 앱 응답(my-payslip.response.dto.ts)
    last_modified: 2026-10-19T04:32:48Z
---

# 관리자 목록 (GET /payslips)

급여명세서 관리 화면(WHALEERP-330)을 한 번에 그린다. 쿼리는 `month`(YYYY-MM, 필수 — 급여 기간 시작일이 그 달인
명세서), `status`(쉼표 목록, 없으면 전체), `storeIds`(쉼표 목록, 직원 목록과 같은 이름 · 검증 — 관리 범위 밖 ID 는 조용히
빠지고 남는 게 없으면 0건), `staffName`(직원명 부분 일치, 대소문자 무시, `%` · `_` 는 글자 그대로 — `containsText`, 50자),
`page`, `pageSize`(20 · 50 · 100 만, 기본 20). 점포를 고르지 않으면 관리자의 관리 범위(`AdminScopeService.getManageableStores`)
전체다. 정렬은 직원 이름, 마지막에 `payslipId`.

응답은 `{ items, total, statusCounts }` 다. `statusCounts` 는 **상태 필터와 상관없이** 그 달 · 고른 점포(없으면 관리 범위 전체)를
센다 — 그래서 상태로 거르면 `total` 과 건수 합이 다르다. 가린 줄도 센다(건수는 개인 단위가 아니다, ATT-30). **직원명으로
거르면 건수도 그 이름으로 센다** — 이때는 아래 가림 규칙대로 가린 줄도 건수에서 빠진다.

가림은 직원 목록과 같은 `hidesPersonalData` 다. 본사 역할(BM · BA)에게 가맹 점포의 본사 제공 동의 없는 직원 명세서는
근무지 · 급여 기간만 남고 `payslipId` 까지 null, `isMasked: true` 다. **상태나 직원명으로 거르면** 그 줄의 상태가 드러나거나
이름이 맞는지 드러나므로, 가려지는 점포에서는 동의한 직원 명세서만 남긴다(직원 목록의 개인 칸 필터와 같은 규칙) — 직원명은
목록 · 건수 모두, 상태는 목록만. 네 상태를 모두 보낸 것은 거르지 않은 것으로 본다. 점포 필터는 개인 칸이 아니라 가린 줄을
그대로 둔다. 정렬은 가린 줄도 직원 이름 자리에 선다 — 이름 첫 글자 언저리가 드러나는 것은 받아들였다.

「출퇴근 확인 여부」는 `isAttendanceConfirmed` 다 — 검토 대기 사유 `MISSING_ATTENDANCE` 가 없거나 모두 확인
(`acknowledged_at`)됐으면 true. **누락 일수는 스키마에 칸이 없어** 내지 않는다(사유 `detail` 은 글자라 숫자를 뽑지
않는다). 「발송일」`lastSentAt` 은 성공한 발송 이력(`payslip_dispatches.status = SUCCEEDED`) 중 가장 늦은 시각이다.

# 관리자 상세 (GET /payslips/:id)

없는 명세서 · 관리 범위 밖 · 가려지는 명세서 · ID 형식 오류는 모두 같은 404 다. 가림은 나머지를 읽기 전에 정한다 —
읽은 뒤에 거르면 가려지는 명세서의 404 만 늦어 응답 시간으로 드러난다(직원 상세와 같다). 담는 것: 금액 셋, 지급 ·
공제 항목(급여 항목 `sort_order` 순, `itemCode` 를 붙임), 검토 대기 사유, 처리 이력(최근 것이 위, `changedByName`),
발송 이력(보낸 순), 참조 근로계약(`contractId · status · wageAmount`).

# 직원 앱 (GET /me/payslips · /me/payslips/:id)

직원 근무 앱 토큰(`@UserTypes('account')`)만 받는다. 로그인한 계정의 직원 레코드(점포가 여럿이면 모두)에 속하고,
상태가 `SENT` 이고, 만든 지 3년이 안 된 명세서만이다(PAY-4). **재직 상태는 보지 않는다** — 퇴직해도 보인다(퇴직이
`staff_members.account_id` 를 비우지 않는다). 발송 뒤 확정을 취소해 다시 검토 중인 명세서는 다시 보낼 때까지 빠진다 —
이전 발송 값을 남기는 칸이 없어, 보이면 고치는 중인 값을 보이게 된다. 상세의 404 도 같은 조건이다.

목록은 `{ items }`(급여 기간이 늦은 것이 위, 항목 없음), 상세는 목록 줄에 `isWithholdingApplied` · `items` 를 더한다.
처리 이력은 발송 · 확정 취소만(PAY-1), 관리자 이름 없이, 최근 것이 위다. 「재발송」은 두 번째 SEND 부터라 화면이 센다.
항목은 저장된 줄을 모두 준다 — 원천징수를 켰을 때 소득세 줄을 숨기는 규칙은 화면 몫이라 `itemCode` 를 함께 준다.

# 초안 작성 (WHALEERP-226)

모두 관리자 웹 · 급여명세서 관리 **등록** 권한(`MN000009` create)이다. 범위는 목록과 같은 관리 범위이고, 본사 역할(BM · BA)에게
본사 제공 동의 없는 가맹 점포 직원은 **작성 대상에서 줄째 빠진다** — 명세서는 개인 정보라 만들 수 없고, 만들 수 없는 줄을
가려 둘 까닭이 없다. 그 직원 명세서는 가맹 관리자가 만든다. 직원 하나를 지정하면 404 다.

* `GET /payslips/candidates?month=YYYY-MM` → `{ periodStartDate, periodEndDate, items }`. 줄은 직원 하나 — `staffName` ·
  `storeName` · `employmentType`(유효 계약 값, 없으면 직원 레코드 값) · `contractId`(없으면 null — 만들 수 없음) ·
  `payslipId`(이 달 명세서가 있으면) · `hasAttendance`. 대상은 재직 중이거나 그 달 유효 계약 · 명세서가 있는 직원이다
  (오래전 퇴직자는 빠진다). 이름순.
* `POST /payslips { staffMemberId, month }` → 201 `{ payslipId }`. 404 범위 밖 · 가림 · 없음, 409 `PAYSLIP_EXISTS`(본문
  `payslipId` — 동시 생성으로 유일 제약에 걸린 경우는 ID 없이), 422 `NO_VALID_CONTRACT`.
* `POST /payslips/bulk { month }` → 200 `{ created: [{ payslipId, staffMemberId, staffName, hasMissingAttendance }],
  skipped: [{ staffMemberId, staffName, reason: EXISTS | NO_CONTRACT }] }`. 작성 대상 모두를 직원마다 따로 트랜잭션으로 만든다
  — 중간에 실패해도 앞서 만든 초안은 남고, 다시 돌리면 이미 있음으로 건너뛴다. 그사이 다른 요청이 만든 것도 EXISTS.

정한 것:

* **급여 기간은 그 달 1일 ~ 말일**이다. 근로계약의 임금지급 월 · 일(`pay_month` · `pay_day`)은 언제 주는지일 뿐 셈하는 기간을
  바꾸지 않는다. 출퇴근 참조 기간도 같다. 「이미 있음」은 목록과 같이 급여 기간 시작일이 그 달인 명세서다.
* **유효한 계약**은 체결 완료(`SIGNED`)이고 계약 기간이 급여 기간과 겹치는 것(종료일 없음은 무기한)이다 — 퇴직 처리가 걸친
  계약을 고르는 조건과 같다. 둘 이상이면 가장 늦게 시작한 계약을 참조하고 검토 사유 `CONTRACT_CHANGED` 를 붙인다.
  **알려진 빈틈:** 종료(`ENDED`)된 계약은 체결 뒤 종료인지 체결 전 종료인지 상태만으로 가를 수 없어 보지 않는다 —
  재계약으로 달 중간에 닫힌 앞 계약은 참조되지 않는다.
* **상태는 작성 중(`DRAFTING`)**. 검토 사유가 붙어도 그대로다 — 검토 중은 관리자가 넘기는 상태로 본다. 처리 이력
  `DRAFT`(→ 작성 중, 「초안 생성」, 처리 관리자)를 남긴다.
* **출퇴근 누락**은 급여 기간(한국 시간)에 그 직원 출퇴근 기록이 한 건도 없을 때다 — 검토 사유 `MISSING_ATTENDANCE`(상세
  「급여 기간에 출퇴근 기록이 없습니다」)를 붙이고 초안은 만든다. 근무스케줄 대비 날짜별 누락은 출퇴근 일감에서 다룬다.
* **항목**은 사용 중인 급여 항목의 지급(11) · 기본 공제(6), 파트타이머면 원천징수(2)까지 `sort_order` 순으로, 금액 없이
  (`calculatedAmount` · `adjustedAmount` null, `isEntered` false) 만든다. 추가 공제는 검토 화면에서 붙인다. 금액 계산
  (기본급 · 주휴 · 연장)은 WHALEERP-227 이다. 합계는 모두 0 이라 실지급액 CHECK 가 맞는다.
* **가산 · 3.3%**: `isPremiumApplied` 는 같은 직원(레코드)의 지난 명세서(급여 기간이 앞선 것 중 가장 늦은 것) 값, 없으면
  true(PAY-05). `isWithholdingApplied` 는 파트타이머만 — 지난 명세서도 파트타이머면 그 값, 아니면 true(PAY-03). 정직원은 false.
