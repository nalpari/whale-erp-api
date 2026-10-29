---
type: API
title: Payslip list, detail and draft creation
description: GET /payslips/summary 점포 하나 · 급여 월 요약(고용형태별 건수 · 지급 합계, WHALEERP-621); POST /payslips/send · /payslips/:id/send · /resend 발송 · 재발송(WHALEERP-231, 이메일 · 푸시 없음); PUT /payslips/:id 임시저장 · POST …/confirm · …/cancel-confirmation · GET …/previous-values · GET /payslips/additional-items (WHALEERP-228 · 230); GET /payslips 는 점포(storeIds) · 직원명(staffName) 필터도 받는다; POST /payslips · /payslips/bulk · GET /payslips/candidates — 초안 작성(직원별 · 그 달 일괄, 유효 계약 없으면 안 만들고 이미 있으면 건너뜀, 출퇴근 없으면 누락 사유); GET /payslips · /payslips/:id — 관리자 웹 급여명세서 관리 목록(급여 월 · 상태 필터, 상태 건수, 20·50·100 쪽) · 상세(항목 · 검토 대기 사유 · 이력 · 발송), 관리 범위와 본사 제공 동의 가림; GET /me/payslips · /me/payslips/:id — 직원 근무 앱의 발송된 내 명세서, 퇴직 뒤에도 3년, 목록은 점포(storeId) · 연도(year, 급여 기간) 필터와 이번 달에 받은 실지급액 합계(thisMonth).
tags: [payslip, list, admin, staff-app, masking, retention]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-29T05:17:36Z }
sources:
  - id: payslip-list-service
    resource: ../../src/payslips/payslip-list.service.ts
    title: PayslipListService (관리자 목록 · 상세, 가림 · 상태 건수)
    last_modified: 2026-10-28T08:41:55Z
  - id: my-payslips-service
    resource: ../../src/payslips/my-payslips.service.ts
    title: MyPayslipsService (직원 앱 — 발송 완료 · 본인 · 3년). DETAIL_SELECT · toSummary 는 직원 자료 일괄 저장도 쓴다
    last_modified: 2026-10-29T02:54:57Z
  - id: controllers
    resource: ../../src/payslips/payslips.controller.ts
    title: GET /payslips · /payslips/summary · /payslips/:id (급여명세서 관리 MN000009 조회)
    last_modified: 2026-10-28T00:37:39Z
  - id: my-controller
    resource: ../../src/payslips/my-payslips.controller.ts
    title: GET /me/payslips · /me/payslips/:id (직원 근무 앱 토큰)
    last_modified: 2026-10-21T05:50:00Z
  - id: draft-service
    resource: ../../src/payslips/payslip-draft.service.ts
    title: PayslipDraftService (작성 대상 · 초안 · 일괄 작성)
    last_modified: 2026-10-29T05:17:36Z
  - id: edit-service
    resource: ../../src/payslips/payslip-edit.service.ts
    title: PayslipEditService (임시저장 · 확정 · 확정 취소 · 지난 명세서 · 추가 공제 항목)
    last_modified: 2026-10-29T05:17:36Z
  - id: send-service
    resource: ../../src/payslips/payslip-send.service.ts
    title: PayslipSendService (발송 · 재발송 · 일괄 발송, 이메일)
    last_modified: 2026-10-29T05:17:36Z
  - id: pdf
    resource: ../../src/payslips/payslip-pdf.ts
    title: 직원 앱 명세서 PDF(칸 모델 · pdfkit 렌더 · 파일 이름)
    last_modified: 2026-10-21T05:50:00Z
  - id: dto
    resource: ../../src/payslips/dto/payslip.response.dto.ts
    title: 관리자 응답 · 쿼리(payslip-list.query.dto.ts) · 직원 앱 응답 · 쿼리(my-payslip.response.dto.ts · my-payslip-list.query.dto.ts)
    last_modified: 2026-10-28T00:43:45Z
---

# 관리자 목록 (GET /payslips)

이 문서의 모든 관리자 경로(`/payslips…`)는 메서드마다 경로 방식 `@MenuPermission(action)` 으로 권한을 본다 — 메뉴는 컨트롤러 경로 `/payslips` 의 MN000009(CLAUDE.md 인증).

급여명세서 관리 화면(WHALEERP-330)을 한 번에 그린다. 쿼리는 `month`(YYYY-MM, 필수 — 급여 기간 시작일이 그 달인
명세서), `status`(쉼표 목록, 없으면 전체), `storeIds`(쉼표 목록 1000개까지, 직원 목록과 같은 이름 · 검증 — 관리 범위 밖 ID 는 조용히
빠지고 남는 게 없으면 0건), `storeTypes`(쉼표 목록 DIRECT · FRANCHISE — 상단 점포 범위의 직영 · 가맹, 주면 그 유형의 폐점 아닌 점포만,
`storeIds` 와 함께면 둘 다 맞는 점포, 직원 목록과 같다 — `pickedStores`), `staffName`(직원명 부분 일치, 대소문자 무시, `%` · `_` 는 글자 그대로 — `containsText`, 50자),
`reviewPending`(true 면 검토 대기만 — 아래, false · 없음은 거르지 않음), `page`, `pageSize`(20 · 50 · 100 만, 기본 20). 점포를 고르지 않으면 관리자의 관리 범위(`AdminScopeService.getManageableStores`)
전체다. 정렬은 직원 이름, 마지막에 `payslipId`.

응답은 `{ items, total, statusCounts, reviewPendingCount }` 다. `statusCounts` 는 **상태 필터와 상관없이** 그 달 · 고른 점포(없으면 관리 범위 전체)를
센다 — 그래서 상태로 거르면 `total` 과 건수 합이 다르다. 가린 줄도 센다(건수는 개인 단위가 아니다, ATT-30). **직원명으로
거르면 건수도 그 이름으로 센다** — 이때는 아래 가림 규칙대로 가린 줄도 건수에서 빠진다.

가림은 직원 목록과 같은 `hidesPersonalData` 다. 폐점한 가맹 점포는 계정이 동의했어도 동의하지 않은 것으로 본다(ATT-30 v227 — [Staff members](/api/staff-members.md) 「본사 제공 동의 가림」). 그래서 요약(`/payslips/summary`)은 폐점한 가맹 점포에서 0건이고,
상태 · 직원명 필터와 발송 · 작성 대상에서도 그 점포 명세서는 빠진다. 본사 역할(BM · BA)에게 가맹 점포의 본사 제공 동의 없는 직원 명세서는
근무지 · 급여 기간만 남고 `payslipId` 까지 null, `isMasked: true` 다. **상태나 직원명으로 거르면** 그 줄의 상태가 드러나거나
이름이 맞는지 드러나므로, 가려지는 점포에서는 동의한 직원 명세서만 남긴다(직원 목록의 개인 칸 필터와 같은 규칙) — 직원명은
목록 · 건수 모두, 상태는 목록만. 네 상태를 모두 보낸 것은 거르지 않은 것으로 본다. 점포 필터는 개인 칸이 아니라 가린 줄을
그대로 둔다. 정렬은 가린 줄도 직원 이름 자리에 선다 — 이름 첫 글자 언저리가 드러나는 것은 받아들였다.

「출퇴근 확인 여부」는 `isAttendanceConfirmed` 다 — 검토 대기 사유 `MISSING_ATTENDANCE` 가 없거나 모두 확인
(`acknowledged_at`)됐으면 true. **누락 일수는 스키마에 칸이 없어** 내지 않는다(사유 `detail` 은 글자라 숫자를 뽑지
않는다). 「발송일」`lastSentAt` 은 성공한 발송 이력(`payslip_dispatches.status = SUCCEEDED`) 중 가장 늦은 시각이다.

**검토 대기**(WHALEERP-234)는 상태가 아니라 분류다(2026-10-26 — 목업 「작성 중 60(검토 대기 8)」, 데모 「검토 대기」 배지 ·
「분류 · 검토 대기만」 필터. 따로 목록을 두지 않는다). 확인(`acknowledged_at`)하지 않은 검토 사유 넷 — 출퇴근 누락 ·
계약 만료 후 기록 · 기간 중 계약 변경 · 확인 필요 기록 포함 — 중 하나라도 남았거나 **공제 미입력**(`DEDUCTION_MISSING`)인 명세서다.
공제 미입력은 사유 행으로 남기지 않고 공제 칸으로 판정한다 — 보이는 공제(기본 공제 · 붙인 추가 공제, 3.3% 를 켜면 소득세 · 지방소득세
대신 원천징수) 중 넣지 않은(`is_entered = false`) 줄이 있으면이고, 확정이 422 로 막는 조건과 같다(운영 정책 v221 PAY-06, 2026-10-27 재영).
확정하면 사유를 모두 확인하고 공제 미입력을 막지만, 그 규칙에 기대지 않고 작성 중 · 검토 중만
검토 대기로 본다(필터 · 건수 · 줄의 사유 모두 — 확정 · 발송된 명세서는 남은 사유가 있어도 `pendingReviewReasons` 가 빈 배열). 줄마다 `pendingReviewReasons`(사유 다섯 `REVIEW_PENDING_REASONS` — 출퇴근 누락 · 계약 만료 후 기록 · 기간 중 계약 변경 · 공제 미입력 · 확인 필요 기록 포함 — 의 순서로 한 번씩, 가린 줄은 null)를 싣고, `reviewPending=true`
면 그런 명세서만 남긴다 — 개인 칸 필터라 상태 필터처럼 가려지는 점포에서는 동의한 직원 명세서만 남긴다. `reviewPendingCount` 는
그 달 · 고른 점포(직원명으로 거르면 그 이름)에서 센 검토 대기 수다 — 「검토 대기만」 목록처럼 본사 역할에게 가린 줄(본사 제공 동의 없는 가맹 직원)은 세지 않는다. 둘의 차이로 가린 직원의 검토 대기(근태 이상 · 공제 미입력) 여부가 드러나지 않게 한다(ATT-30, 운영 정책 v218, PR #169 리뷰).
확정을 취소하면 확정이 확인한 사유가 다시 확인 전이 되어, 사유가 남은 명세서는 다시 검토 대기다(아래 확정 취소).

# 권한 점검 (WHALEERP-242)

`test/payslip-permissions.e2e-spec.ts` 가 실제 DB 로 고정한다. 관리 범위는 역할이 아니라 계정의 `is_all_stores` · 점포 매핑이 정한다
(`AdminScopeService.getManageableStores`) — BP 마스터는 BP 전체, BP 관리자 · 가맹 마스터 · 가맹 관리자는 매핑한 점포. 범위 밖 ·
가린 명세서는 목록에서 빠지거나 가리고, 상세 · 지난 값 · 다시 계산 · 확정 · 발송은 모두 같은 404 다. 본사 역할(BM · BA)에게 동의 없는
가맹 점포 직원 명세서는 목록에서 근무지 · 급여 기간만 남고(검토 대기만으로 거르면 빠지고 검토 대기 건수에도 들지 않는다) 상세 · 처리는 404, 가맹 역할에게는
동의와 상관없이 보인다(ATT-30). 직원은 자기에게 발송된 명세서만(`/me/payslips/:id`, 남의 것 · 발송 전은 404), 관리자 경로는 403.
**가맹 마스터(FM000001)의 급여명세서 메뉴(MN000009)는 초기 데이터부터 조회만이다**(명세 Ⅱ-4) — 가맹 마스터는 자기 가맹점 명세서를
보기만 하고 작성 · 확정 · 발송은 403 이다. 출 · 퇴근 현황(MN000025)처럼 가맹이 직접 처리해야 하는지는 정책 확인 대기다(ATT-37 은
출퇴근만 열었다).

# 관리자 상세 (GET /payslips/:id)

없는 명세서 · 관리 범위 밖 · 가려지는 명세서 · ID 형식 오류는 모두 같은 404 다. 가림은 나머지를 읽기 전에 정한다 —
읽은 뒤에 거르면 가려지는 명세서의 404 만 늦어 응답 시간으로 드러난다(직원 상세와 같다). 담는 것: 금액 셋, 지급 ·
공제 항목(급여 항목 `sort_order` 순, `itemCode` 를 붙임), 검토 대기 사유, 처리 이력(최근 것이 위, `changedByName`),
발송 이력(보낸 순), 참조 근로계약(`contractId · status · wageAmount`).

# 점포 · 월 요약 (GET /payslips/summary, WHALEERP-621)

로그인 후 홈 「점포 하나 화면」의 직원 급여 카드가 쓴다. `?storeId=&month=YYYY-MM`(둘 다 필수, 형식이 틀리면 400) →
`{ month, total, fullTime, partTime }`, 각 묶음은 `{ count, grossPayAmount }`(명세서 건수 · `gross_pay_amount` 합).

- 귀속월은 목록의 `month` 와 같다 — 급여 기간 시작일이 그 달인 명세서. 작성 중 · 검토 중 · 확정 · 발송 완료를 모두 센다(2026-10-27 재영).
- 고용형태는 명세서의 `employment_type` 이다(정직원 FULL_TIME · 파트타이머 PART_TIME). 없는 쪽은 0.
- 권한은 목록 · 상세와 같은 급여명세서 관리(MN000009) 조회 — 없으면 403(홈은 카드를 숨긴다). 관리 범위 밖 점포는 목록처럼 조용히 0건.
- 본사 역할(BM · BA)에게 가려지는 점포(가맹)는 본사 제공 동의를 한 직원 명세서만 센다(ATT-30). 목록의 상태 건수는 가린 줄도 세지만,
  요약은 금액이 붙어 가린 직원의 급여가 합계로 드러나므로 뺀다.

# 직원 앱 (GET /me/payslips · /me/payslips/:id · /me/payslips/:id/pdf)

직원 근무 앱 토큰(`@UserTypes('account')`)만 받는다. 로그인한 계정의 직원 레코드(점포가 여럿이면 모두)에 속하고,
한 번이라도 보낸(상태 `SENT`, 또는 `SEND` 처리 이력이 있는) 명세서이고, 만든 지 3년이 안 된 것만이다(PAY-4). **재직 상태는 보지 않는다** — 퇴직해도 보인다(퇴직이
`staff_members.account_id` 를 비우지 않는다). 퇴직한 직원의 로그인 → 목록 · 상세 · 3년 지난 것 404 · 두 점포 모두 퇴직은
`test/account-status-policy.e2e-spec.ts` 의 PAY-4 블록이 실제 DB 로 고정한다. 발송 뒤 확정을 취소한 명세서는 목록에 남기고 `correcting: true`(「검토 중」)로 준다 —
금액(`grossPayAmount` · `totalDeductionAmount` · `netPayAmount`)은 null, 상세 `items` 는 빈 목록, PDF 는 409 `PAYSLIP_CORRECTING` 이다.
이전 발송 값을 남기는 칸이 없어, 실으면 관리자가 고치는 중인 값을 보이게 된다(2026-10-21 사용자 결정 — 빠지게 하지 않고 표시만).
이번 달 합계(`thisMonth`)에서도 뺀다. 다시 보내면 지금 값으로 보이고 그 달에 받은 것으로 센다. 상세의 404 도 같은 조건이다.

목록은 `GET /me/payslips?storeId&year` → `{ thisMonth, stores, items }`(PAY-8 · 9 · 10).

* `items` — 줄마다 `storeId` · `storeName` · `sentAt`(가장 최근 SEND 시각, 다시 보냈으면 다시 보낸 때), 항목 없음. 급여 기간
  최신순, 같은 달이면 받은 날 최신순, 같으면 id 큰 것이 위(PAY-8, 2026-10-22 재영 — 정정해 다시 보낸 지난달 명세서가 이번 달
  위로 오지 않게). `storeId` · `year`(급여 기간 시작일의 연도 — 2025년 12월분을 2026년 1월에 받아도 2025년)는
  `items` 만 거른다.
* `thisMonth` — `{ month(YYYY-MM), count, totalNetPayAmount, storeNames }`. 한국 시간 이번 달에 받은(`sentAt`) 명세서 모두의
  실지급액 합계다. 필터 · 근무지와 관계없다. `storeNames` 는 겹치지 않게, 최근에 받은 것부터 — `items` 가 급여 기간순이라
  따로 받은 날순으로 세운다.
* `stores` — 받은 적이 있는 점포 모두(필터 전, 퇴직한 곳 포함), 이름순. 필터 칩이 쓴다.

한 사람 몫은 3년치라 한 번에 읽어 메모리에서 거른다. 상세는 목록 줄에 `isWithholdingApplied` · `items` 를 더한다.
처리 이력은 발송 · 확정 취소만(PAY-1), 관리자 이름 없이, 최근 것이 위다. 앱은 가장 최근 발송 한 줄만 「발송」으로 보이고
「재발송」을 따로 적지 않는다(PAY-20).
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
* **유효한 계약**은 체결 완료이거나 체결 완료에서 종료된 계약(상태 이력 체결 완료 → 종료)이고 계약 기간이 급여 기간과 겹치는
  것이다. 종료된 계약의 효력 끝은 종료일과 종료 처리한 날(그 이력의 시각) 가운데 이른 쪽이다 — 종료 처리가 급여 기간 시작
  이후여야 한다. 대체로 닫힌 체결 완료는 원래 종료일이 남아 있어, 종료일만 보면 닫힌 뒤에도 매달 초안 · 계약 변경 검토 사유가
  생겼다(api #152 리뷰). 「체결 완료였다」는 종료 줄의 from 으로 봐 체결 이력 없이 넣은 옛 계약도 빠지지 않는다. 종료일이
  없으면 체결 완료는 무기한이다. 하루 배치가 종료일 지난 체결 완료를 종료로 바꾸고(WHALEERP-152), 재계약 · 대체가 달 중간에
  앞 계약을 닫아도 그 달 명세서는 그 계약을 참조한다(api #150 리뷰). 둘 이상이면 명세서에는 가장 늦게 시작한 계약을 참조로 두고 검토 사유
  `CONTRACT_CHANGED` 를 붙이며, 계산은 날마다 그날 효력이 있는 계약으로 나눠 한다(아래 「기간 중 계약 변경」, 2026-10-26 재영).
* **상태는 작성 중(`DRAFTING`)**. 검토 사유가 붙어도 그대로다 — 검토 중은 관리자가 넘기는 상태로 본다. 처리 이력
  `DRAFT`(→ 작성 중, 「초안 생성」, 처리 관리자)를 남긴다.
* **검토 대기 분류**(WHALEERP-229, `payslip-attendance-reasons.ts`) — 사유를 붙여도 초안은 만든다. 순서는 출퇴근 누락 · 기간 중
  계약 변경 · 계약 만료 후 기록 · 확인 필요 기록 포함.
  * **출퇴근 누락**(`MISSING_ATTENDANCE`): 급여 기간(한국 시간)에 기록이 한 건도 없으면 「급여 기간에 출퇴근 기록이 없습니다.」. 있으면
    빠진 날 — 그날을 덮는 근로계약의 근무 요일인데 출근이 없는 날(출근·퇴근 모두 없음)과 출근만 있고 퇴근이 없는 날(퇴근 미등록) —
    을 「출퇴근 기록이 2일 누락되었습니다 — 09-05 퇴근 미등록, 08-22 출근·퇴근 모두 없음.」(데모, 날짜 내림차순, 10일 넘으면 「외 N일」)
    으로 적는다. 오늘은 끝나지 않아 어제까지만 보고, 퇴직일 뒤 · 계약 기간 밖은 빼며, 근무스케줄은 보지 않는다(STAFF-40).
    달을 걸친 첫 주의 앞 달 날(그 주 월요일 ~ 급여 기간 전날)도 퇴근 미등록만 맨 뒤에 붙인다 — 그 날의 실근무는 이 달 계산에 늘
    들어가 0분이면 이 달 금액이 줄어든다(이 달이 주를 맡으면 주휴 금액, 앞 달이 맡으면 주 40시간 연장 — `weeksOf`, PR #193 리뷰). 같은
    날이 앞 달 명세서에도 실린다. 출근 · 퇴근 모두 없는 앞 달 날은 넣지 않는다(그 주 개근이 깨진다). 기록 없음 판정 · 계약 만료 후
    기록은 급여 기간 안의 날만 본다.
  * **계약 만료 후 기록**(`AFTER_CONTRACT_END`): 급여 기간에 걸친 계약 가운데 가장 늦은 종료일 뒤에 출근한 날(무기한 계약이 있으면
    없음) — 「근로계약 만료일(2026-09-25) 뒤 출퇴근 기록이 2일 있습니다 — 09-28, 09-30.」.
  * 기간 중 계약 변경은 아래 「유효한 계약」, 공제 미입력은 확정이 422 로 막는다(230 — 사유 줄은 만들지 않고 상세는 빨간 띠로 알린다.
    목록의 검토 대기는 공제 칸으로 판정한다 — 위 「검토 대기」).
  * 「출퇴근으로 다시 계산」은 누를 때마다 검토 사유를 지금 데이터로 모두 새로 판정한다(출퇴근 셋 · 기간 중 계약 변경, 초안과 같은
    `reviewReasonsOf`) — 앞서 「확인」한 표시도 지운다(2026-10-26 재영). 처리 이력에 「출퇴근 누락 해소」 · 「계약 만료 후 기록 추가」
    모양으로 남긴다. 보정한 뒤 다시 계산하면 경고가 풀린다. 공제 미입력은 저장하지 않는 사유라 그대로 확정이 막는다.
* **확인 필요 기록 포함**은 급여 기간(한국 시간)에 확인 필요 사유가 남은(관리자가 아직 검토하지 않은) 그 직원 출퇴근 기록이 있을 때다 —
  검토 사유 `ATTENDANCE_NEEDS_REVIEW`(상세 「급여 기간에 확인 필요 출퇴근 기록이 N건 있습니다.」, ATT-11 · 2026-10-20 재영). 확인 필요
  기록도 급여 계산에는 넣는다. 세는 기준은 급여 계산과 같다 — 짝 퇴근은 출근한 날(자정을 넘긴 퇴근도), 출근 없는 퇴근은 자기 시각. 퇴근
  시각으로 세면 월말 밤샘 퇴근의 사유(근무 12시간 초과 등)가 그 근무를 지급하지 않는 다음 달에 붙었다(PR #159 리뷰).
* **항목**은 사용 중인 급여 항목의 지급(11) · 기본 공제(6), 파트타이머면 원천징수(2)까지 `sort_order` 순으로 만든다. 기본급 ·
  주휴수당 · 연장수당은 아래 「지급 항목 계산」의 값을 `calculatedAmount` 에 넣고 넣은 것(`isEntered` true)으로 본다 — 계산할 수
  없으면(null) 미입력이다. 나머지 줄은 금액 없이(`calculatedAmount` · `adjustedAmount` null, `isEntered` false) 선다. 추가 공제는
  검토 화면에서 붙인다. 공제는 비어 있어 지급 총액 = 실지급액이다(실지급액 CHECK).
* **가산 · 3.3%**: `isPremiumApplied` 는 같은 직원(레코드)의 지난 명세서(급여 기간이 앞선 것 중 가장 늦은 것) 값, 없으면
  true(PAY-05). `isWithholdingApplied` 는 파트타이머만 — 지난 명세서도 파트타이머면 그 값, 아니면 true(PAY-03). 정직원은 false.

# 지급 항목 계산 (WHALEERP-227)

기본급 · 주휴수당 · 연장수당은 명세서가 참조한 근로계약과 그 직원 레코드의 출퇴근 기록으로 계산한다(순수 계산 `pay-calculation.ts`,
읽기 `payslip-calculation.ts`). 계산식과 가산율은 **노무사 검토 대기**(PAY-5)이고 지금 식은 운영 정책 PAY-02 · 04 의 2026-09-30
「우리 판단」에 2026-10-26 재영 답(PAY-04 · 05 · 22)을 더한 것이다.

* **하루 근무** — 그날(한국) 출근 기록과 그 짝 퇴근(`check_in_attendance_record_id`) 사이 분의 합에서 휴게를 뺀다. 휴게는 그날
  근무스케줄의 휴게 분, 없으면 그 요일 계약 휴게다. 퇴근이 없는 출근은 0 분이지만 출근한 날로는 센다. 확인 필요 기록도 넣는다(ATT-11).
* **시급은 `wage_amount`**(고용 형태와 상관없이 시급, 2026-10-12). 없으면 셋 다 계산하지 않는다(null).
* **정직원** — 기본급 = 시급 × 월 기본시간(`base_hours`, 없으면 null). 급여 기간 중간에 입사 · 퇴사하면(직원 레코드 `hired_date` ·
  `retired_date`) 기간 역일 가운데 재직 역일 비율로 일할한다(PAY-22, 2026-10-26 재영 — 나누는 기준은 노무사 질문에 더함). 주휴는
  월급에 들어 있어 0. 연장 = 하루 8시간을 넘긴 분 + (하루 몫을 뺀) 주 40시간을 넘긴 분. 연장수당은 근로계약 월간 연장근무
  (`monthly_overtime_hours`, 포괄 연장)를 뺀 나머지에만 준다(PAY-04, 2026-10-26 재영).
* **파트타이머** — 기본급 = 연장을 뺀 근무 시간 × 시급. 연장 = 그 요일 계약 소정근로시간(8시간 이하로 본다)을 넘긴 분, 계약하지 않은
  요일은 전부 + 주 40시간 초과(같은 시간은 한 번만). 주휴 = 이 기간이 맡은 주 가운데 주 전체가 계약 기간 안이고 1주 소정근로시간이
  15시간 이상이며 그 주 계약 요일을 모두 출근한(지각 · 조퇴도 출근) 주마다 그 주 실근무 시간(출퇴근 기록, 이 기간이 맡은 날)에서
  연장을 뺀 시간 ÷ 5 × 시급, 40시간 상한(PAY-05 v234 · PAY-04 v237, 2026-10-28 · 29 재영 — WHALEERP-243 노무사 답 질문 1 「총근무시간 ÷
  5」). 연장(계약 소정근로시간 · 하루 8시간 · 주 40시간 초과)을 빼므로 계약 소정근로시간 안에서 일한 시간까지만 센다. 가산을 끈 명세서도
  같다. 대상 판정은 계약 소정 15시간 그대로다. 결근한 주는 개근이 아니라 주휴가 없다(질문 15). 월간 연장은 빼지 않는다.
* **가산(`isPremiumApplied`, PAY-05)** — 켜면 연장수당 = 연장 분 × 시급 × 1.5, 끄면 가산 없이 × 1(2026-10-26 재영).
* **기간 중 계약 변경(2026-10-26 재영, 우리 판단 · 노무 확인 대기)** — `PayInput.contracts` 에 기간에 걸친 계약을 모두 두고 날마다
  그날 효력이 있는 계약(늦게 시작한 것 우선, 덮는 계약이 없는 날은 그 앞 계약)으로 셈한다. 파트타이머 기본급 · 연장은 그날 계약의
  시급 · 요일별 소정근로시간으로, 주 40시간 초과 연장은 주 끝 날부터 거꾸로 그날 계약 시급으로. 주휴는 한 주가 두 계약에 걸치면 그 주
  마지막 날(이 달이 맡은 주면 이 달 몫의 마지막 날)의 계약으로 센다. 정직원 기본급과 포괄 연장은 계약마다 월 금액 × 그 계약이 효력 있는
  재직 일수 ÷ 기간 일수로 나눈다(임시). 계약 하나면 예전과 같다. 계산 입력은 기간 앞 주(월요일부터)의 날을 덮는 계약도 읽는다 —
  1일에 재계약하면 달을 걸친 주의 앞 달 몫이 앞 계약이라, 이것 없이는 그 주 주휴가 두 달 모두에서 빠졌다(ivysaur 리뷰).
  가산 적용을 바꾸면 연장수당 계산값만 새로 두고, 관리자가 고친 연장수당(`adjusted_amount`)은 지킨다 — 칸을 그대로 돌려보내도 덮지 않는다(새 계산값이 null 인 고용형태 혼합 명세서에서 넣은 값이 미입력으로 돌아가던 문제, PR #159 리뷰).
  **고용형태가 다른 계약이 섞이면**(정직원 ↔ 파트타이머) 두 식을 날마다 나눠 쓰는 규칙이 정해지지 않아 기본급 · 주휴수당 · 연장수당을
  계산하지 않는다(null — 관리자가 넣는다, `PayInput.isEmploymentMixed`). 「기간 중 계약 변경」 상세도 「…고용형태가 다른 근로계약이 걸쳐
  있어 … 계산하지 않았습니다. 직접 입력해 주세요.」로 가른다 — 한 고용형태 식으로 기간 전체를 그럴듯하게 틀리게 셈하던 것을 막는다(PR #159 리뷰).
* **달을 걸친 주(PAY-04, 2026-10-26 재영)** — 앞 달 몫의 날만으로 주휴 조건(그 날들의 소정근로시간 15시간 이상 · 그 날들의 계약
  요일 개근 · 계약 기간 안)을 채우면 앞 달 명세서가 맡고, 못 채우면 다음 달 명세서가 주 전체로 센다 — 앞 달 명세서는 다음 달 기록
  없이 정해진다. 주휴 금액도 그 명세서가 판정에 쓴 날로 센다 — 앞 달이 맡으면 앞 달 날의 실근무만 넣고 다음 달이 보충하지 않는다
  (PAY-04 v237, 2026-10-29 재영 — 예: 월 ~ 금 8시간이면 9월 명세서 9/28 주 24시간 ÷ 5, 10/1 · 2 는 어느 주휴에도 들지 않는다).
  주 40시간 연장도 그 주를 맡은 달이 센다. 앞 달이 맡은 주는 다음 달이 주 전체 초과에서 앞 달 몫 초과를 뺀 만큼을
  센다(같은 시간을 두 번 세지도, 빠뜨리지도 않는다). 원 단위 반올림은 항목마다 한 번.
* 야간 · 휴일근무수당은 관리자가 넣는다.
* **다시 계산** — `PUT /payslips/:id` 에서 가산 값을 바꾸면 연장수당만 그 값으로 다시 계산한다(목업 payrolls-detail — 기본급 · 주휴수당은
  고친 값도 그대로 둔다, 출퇴근이 바뀐 것은 「출퇴근으로 다시 계산」의 일). 화면이 보낸 시스템 계산 줄 값이 바꾸기 전 값과
  같으면 고치지 않은 것으로 보고 새 계산값을 따르고, 다르면 고친 값으로 남긴다. `POST /payslips/:id/recalculate { updatedAt }` →
  200 상세 — 작성 중 · 검토 중만(아니면 409), 지금 출퇴근 기록으로 셋을 다시 계산하고 고친 값은 버린다. 합계를 다시 셈하고 처리 이력
  `EDIT` 「출퇴근으로 다시 계산 · 기본급 600,000원 → 670,000원」(바뀐 것이 없어도 앞 말은 남긴다). 동시 저장은 아래와 같다(409
  `PAYSLIP_STALE`).
* e2e `test/payslip-calculation.e2e-spec.ts` — 초안 계산 · 가산 해제 · 다시 계산을 실제 DB 로 본다.

# 임시저장 · 확정 · 확정 취소 (WHALEERP-228 · 230)

모두 급여명세서 관리 **수정** 권한(`MN000009` update)이다. 찾기는 상세와 같다 — 없음 · 관리 범위 밖 · 가림(본사 역할 · 동의 없는
가맹 점포 직원) · 이상한 id 는 같은 404. 고치는 세 경로는 상세 응답의 `updatedAt` 을 받아, 읽은 상태 · `updatedAt` 을 조건으로 건
UPDATE 를 먼저 한다(게시물 · 문의와 같은 방식). 0건이면 지금 상태가 다르면 409 `PAYSLIP_STATUS_CONFLICT`(본문 `status`), 같으면 그사이
누가 고친 것이라 409 `PAYSLIP_STALE`. 그 UPDATE 가 명세서 행을 잠가 같은 트랜잭션의 나머지 쓰기는 줄을 선다. 세 경로 모두 고친 뒤의
상세(`GET /payslips/:id` 와 같은 모양)를 돌려준다.

* `PUT /payslips/:id { updatedAt, isPremiumApplied, isWithholdingApplied, items: [{ payslipItemMasterId, amount: number|null }] }` —
  작성 중 · 검토 중만. **상태는 바꾸지 않는다**(작성 중은 작성 중, 검토 중은 검토 중 — 검토 중은 확정 취소로만 들어간다).
  * 공제는 요율이 해마다 바뀌어 시스템이 계산하지 않고 관리자가 넣는다. 3.3% 원천징수 두 줄도 관리자가 넣는다(비과세 포함 지급 총액
    기준은 화면이 알린다). `null` 은 미입력이고 0 과 다르다(`isEntered`).
  * 지급 · 기본 공제 · 원천징수 줄은 실은 것만 고치고 빠진 줄은 그대로다. **추가 공제는 실은 것이 곧 붙은 목록**이다 — 새 항목은
    사용 중인 `ADDITIONAL` 급여 항목이어야 하고(아니면 400) 이름 · 구분 · 비과세를 박아 붙이며, 빠진 것은 뗀다.
  * 시스템 계산 항목(기본급 · 주휴 · 연장)에 계산값이 있으면 고친 값을 `adjustedAmount` 에 두고, 계산값과 같거나 null 이면 계산값으로
    돌린다. 그 밖의 줄은 `adjustedAmount = amount`, `isEntered = amount !== null`.
  * 3.3% 는 파트타이머 명세서만(정직원이 true 면 400). 같은 항목 두 번 · 한 줄 1억 초과 · 합계가 integer 를 넘으면 400.
  * 합계를 다시 셈한다 — 보이는 줄만(3.3% 를 켜면 소득세 · 지방소득세 대신 원천징수), 미입력은 0. 실지급액 CHECK(지급 − 공제)를 지킨다.
  * 바꾼 것이 있으면 처리 이력 `EDIT` 한 줄(「가산 적용 해제 · 상여 미입력 → 128,000원 · 항목 추가 연말(중도)정산」 모양). 없으면 남기지 않는다.
* `POST /payslips/:id/confirm { updatedAt }` → 200 상세 — 작성 중 · 검토 중에서 확정. 보이는 공제(기본 공제 · 붙인 추가 공제, 3.3% 를
  켜면 소득세 · 지방소득세 대신 원천징수)가 하나라도 미입력이면 422 `DEDUCTION_MISSING`(본문 `items: [{ payslipItemId, itemName }]`).
  검토 사유가 있어도 확정하는 것이 「확인」이다 — 확인하지 않은 사유의 `acknowledged_at` 에 확정 시각을 남긴다. `confirmed_at` ·
  `confirmed_by`, 처리 이력 `CONFIRM`(「확정 · 검토 사유 N건 확인」).
* `POST /payslips/:id/cancel-confirmation { updatedAt }` → 200 상세 — 확정 · 발송 완료(보낸 뒤에도)에서 검토 중으로. 확정 일시 ·
  관리자를 비우고, 확정이 확인한 검토 사유의 `acknowledged_at` 을 다시 비운다 — 사유가 남은 명세서가 검토 중이면서 검토 대기에서
  빠지지 않게(운영 정책 v221 PAY-06, 2026-10-27 재영. 사유를 확인하는 것은 확정뿐이다). 이 정책 전에 확정 취소한 명세서는
  마이그레이션 `20261027150500_team3_payslip_reopened_review_reasons` 가 작성 중 · 검토 중 명세서의 확인 표시를 모두 풀어 맞춘다(머지 후 `pnpm db:deploy`). 처리 이력 `CANCEL_CONFIRMATION`(「확정 취소 ·
  검토 사유 N건 다시 검토 대기」, 없으면 「확정 취소」).
* `GET /payslips/:id/previous-values` → `{ previous: { payslipId, periodStartDate, periodEndDate, items: [{ payslipItemMasterId, itemCode,
  itemName, itemCategory, amount }] } | null }` — 같은 직원(레코드)의 급여 기간이 앞선 명세서 중 가장 늦은 것의 공제(기본 · 추가 ·
  원천징수)와 관리자가 넣는 지급(시스템 계산 항목 제외), 넣은 값만. 저장하지 않는다 — 화면이 칸을 채우고 임시저장한다.
* `GET /payslips/additional-items` → `{ items: [{ payslipItemMasterId, itemCode, name }] }` — 「항목 추가」로 붙일 수 있는 사용 중인
  추가 공제, 순서대로.

**openapi 내보내기** — 이 작업 트리에 `nest start --watch` 가 떠 있으면 `pnpm openapi:export`(`nest build`, `deleteOutDir`)가 `dist` 를
지워 서버가 죽는다. 그때는 `tsconfig.build.json` 을 확장해 `outDir` 만 바꾼 임시 설정으로 `nest build -p` 한 뒤 그 결과의
`openapi/export.js` 를 저장소 루트에서 돌리고 임시 출력을 지운다.

# 발송 · 재발송 (WHALEERP-231)

모두 `MN000009` 수정 권한, 범위 · 가림은 상세와 같다. **이메일만 보낸다** — 이 저장소에 앱 푸시 발송(기기 토큰 · FCM)이 없어
`PUSH_PAYSLIP_*` 템플릿은 쓰지 않고 PUSH 발송 이력도 남기지 않는다. 급여 지급은 하지 않는다.

* `POST /payslips/:id/send { updatedAt }` → 200 상세 — 확정만. `POST /payslips/:id/resend { updatedAt }` → 200 상세 — 발송 완료만
  (화면이 확인창을 거친 뒤 부른다). 읽은 뒤 바뀌었으면 409 `PAYSLIP_STALE`, 상태가 아니면 409 `PAYSLIP_STATUS_CONFLICT`. 메일 설정 ·
  직원 앱 주소가 없으면 503(`MAIL_NOT_CONFIGURED` · `APP_URL_NOT_CONFIGURED`), 직원 앱 계정이 없거나 탈퇴면 422 `NO_EMAIL`, 메일이
  실패하면 502 `SEND_FAILED`(확정 그대로, 발송 이력 실패 한 줄).
* `POST /payslips/send { month, storeIds?, storeTypes?, staffName? }` → 200 `{ sent: [{ payslipId, staffName }], failed: [{ payslipId, staffName, reason,
  message }] }` — 목록의 「확정 N건」과 같은 조건(달 · 점포 · 직원명, 직원명이면 가린 직원은 대상에서 뺀다)의 확정 명세서를 한 장씩
  보낸다. 일부가 실패해도 보낸 것은 그대로이고, 실패는 이유(`MAIL_NOT_CONFIGURED` · `APP_URL_NOT_CONFIGURED` · `NO_EMAIL` ·
  `CONFLICT` · `MAIL_FAILED`)와 화면 문장으로 담는다. 본사 역할에게 가려지는 명세서는 보내지 않고 이름 · id 없이 `MASKED` 로 센다
  (목록의 확정 건수에 들어 있어서).

한 장을 보내는 순서:

1. 메일 설정 · 직원 앱 주소 · 받는 곳(직원 레코드의 계정 이메일, 탈퇴 계정 제외 — 직원 앱이 그 계정으로 명세서를 본다)을 먼저 본다.
   없으면 아무것도 쓰지 않는다.
2. 읽은 상태 · `updatedAt` 을 조건으로, 발송 중 표시 `sending_started_at` 이 빈(또는 5분 넘게 묵은) 것만 `updatedAt` 과 표시를 채워
   **잡는다** — 같은 명세서를 두 요청(두 관리자 · 일괄 둘 · 다시 누름)이 함께 보내지 않게. 0건이면 보내지 않는다(`CONFLICT` / 409).
3. 트랜잭션 밖에서 메일(되돌릴 수 없어 커밋 뒤, mail.md). 템플릿은 전에 이메일로 보낸 적이 있으면(재발송 또는 확정 취소 뒤 다시 확정)
   `EMAIL_PAYSLIP_RESENT`, 아니면 `EMAIL_PAYSLIP_SENT`. 변수는 템플릿 행 그대로 `직원이름`(직원 레코드 이름) · `근무지`(점포 이름) ·
   `급여월`(급여 기간 시작 달, 「7월」 — NTF-20) · `링크`(버튼, `STAFF_APP_URL` 의 origin + `/pay/{payslipId}` — 직원 근무 앱 명세서
   상세). `sentBy` 는 보낸 관리자.
4. 성공이면 한 트랜잭션에서 발송 완료(확정 · 발송 완료이고 잡은 `updatedAt` 그대로일 때만 — 그사이 확정이 취소됐거나 취소 뒤 다시 확정됐으면 상태는 두고 이력만. 보낸 메일과 다른 값이 직원 앱에 보이지 않게), 발송 이력(EMAIL ·
   SUCCEEDED · 보낸 관리자), 처리 이력 `SEND`(상태 칸은 확정 → 발송 완료로 바뀐 경우에만 남고, 문구는 전에 이메일로 보낸 적이 있으면 「재발송 · 이메일」 — 확정 취소 뒤 다시 확정해 보내면 둘 다 남는다). 실패면 발송
   이력(EMAIL · FAILED)만 — 상태는 그대로라 다시 보낼 수 있다. 실패하면 잡을 때 바꾼 `updatedAt` 을 원래 값으로 되돌리고 발송 중 표시를 비운다(그사이 다른
   요청이 고쳤으면 표시만 비운다 — 이때 Prisma `@updatedAt` 이 시각을 올려 고친 관리자의 화면도 한 번 새로 고쳐야 한다) — 그대로 두면 같은 화면에서 다시 보내기가 늘 409 `PAYSLIP_STALE` 이 된다. 로그는 SMTP 실패(warn)와 보내기 전에
   막힌 실패(error — 템플릿 꺼짐 · 주소 형식, 다시 눌러도 풀리지 않는다)를 가른다. 화면 문장은 「발송 이력을 확인한 뒤 다시」다 — SMTP
   시간 초과면 메일이 나갔을 수도 있다. 메일이 나간 뒤 기록이 실패하면 되돌리지 않고 로그만 남긴다.

알려진 한계(후속 과제):

* 일괄 발송은 한 요청 안에서 한 장씩 차례로 보낸다(SMTP 왕복이 건수만큼). 건수가 많으면 프록시 · 화면의 시간 제한을 넘겨 화면이
  `sent` · `failed` 를 받지 못할 수 있다 — 서버는 끝까지 보내고, 다시 눌러도 확정만 대상이라 두 번 보내지 않는다(아래 메일은 나갔는데 기록이 실패한 경우는 빼고). 상한 · 동시성은 아직 없다.
* 메일이 나간 뒤 발송 완료 · 이력 쓰기가 실패하면 로그만 남기고 성공으로 답한다(되돌리면 다시 누를 때 두 번 간다). 그 명세서는
  확정 그대로라 화면에 「발송」이 남고, 직원 앱에는 보이지 않는다 — 이 경우를 화면에 알리는 길은 아직 없다.
* 2의 「잡기」는 `updatedAt` 과 함께 발송 중 표시 `sending_started_at` 을 채운다(마이그레이션 `20261021143418_team3_payslip_sending_started_at`,
  api #96 머지 블로커). 표시가 찬 명세서는 잡지 못해 409 `PAYSLIP_STALE`(일괄은 실패 사유 `CONFLICT`)이다 — 상세를 새로 읽은 다른 관리자 ·
  다시 누름이 같은 명세서를 다시 보내지 못한다. 성공 · 실패 모두 끝나면 비운다. 처리 중 서버가 죽어 비우지 못한 표시는 5분이 지나면
  끊긴 것으로 보고 다시 잡는다. 메일은 나갔는데 기록 쓰기가 실패한 경우는 표시가 남아 5분 동안은 다시 보내지 못한다.

다시 보내면 직원 앱은 지금 값을 본다 — 명세서는 한 장이고 이전 발송 값을 따로 두지 않는다(이전 금액 비교 없음). 발송 완료에서
확정을 취소하면 다시 보낼 때까지 직원 앱에 「검토 중」으로 금액 없이 보인다(위 「직원 앱」).

# 직원 앱 명세서 PDF (GET /me/payslips/:id/pdf, PAY-2)

직원 근무 앱 「명세서 내보내기」(상세에만)가 받는 파일이다. 조건은 상세와 같다 — 본인 · 발송 완료 · 만든 지 3년 안, 아니면 404
(`MyPayslipsService.document` 가 상세와 같은 쿼리에 직원 이름을 더해 준다 — 상세 응답에는 이름을 싣지 않는다). `application/pdf`,
`Content-Disposition: attachment; filename="payslip_YYYY-MM_{id}.pdf"; filename*=UTF-8''급여명세서_YYYY-MM_{이름}.pdf`(RFC 5987, `'()*`
까지 인코딩, 이름의 경로 · 따옴표 · 제어 문자는 밑줄), `Cache-Control: private, no-store`.

내용은 직원 앱 상세와 같은 칸 · 같은 금액 규칙이다(다시 보낸 명세서도 발송일과 끝 안내를 넣는 점만 다르다 — 상세는 데모 resent 대로 뺀다, `payslipPdfModel` — 단위 테스트는 이 칸 모델을 본다): 제목 「급여명세서」, 급여 기간
(「2026년 9월 1일 – 9월 30일」), 직원 · 근무지 · 계약 유형(`DB_ENUMS` 한글) · 발송일(마지막 SEND, 한국 날짜 — 두 번 이상이어도
「다시 발송」은 적지 않는다, PAY-20), 지급 항목 표(비과세 표시) · 공제 항목 표(원천징수 둘은 3.3% 적용일 때만, 그때 소득세 · 지방소득세는 뺀다 —
원천징수 줄에 「끝자리 세무 확인 대기(PAY-7)」), 지급 합계 · 공제 합계 · 실지급액(저장된 합계 값). 줄 금액은 `adjustedAmount ??
calculatedAmount ?? 0`, 「1,000원」 형식. 「입금」이라는 말은 쓰지 않고 끝에 「급여 지급은 이 명세서로 처리하지 않습니다」를 둔다.

직원 자료 일괄 저장([Bulk exports](/api/bulk-exports.md))도 이 PDF 를 쓴다. 그 점포 범위의 발송 완료(`SENT`) 명세서를 같은 `DETAIL_SELECT` 로 읽고 `toSummary` 와 같은 상세로 바꿔 그린다. 그래서 상세의 모양을 바꾸면 zip 안의 PDF 도 바뀐다. 확정을 취소해 검토 중인 명세서는 담지 않는다.

그리기는 `pdfkit`(MIT, 0.20.2 고정)로 A4 한 장(넘치면 다음 장). 한글은 직원 앱과 같은 **Pretendard 1.3.9 OTF**(Regular · Bold,
OFL — `src/payslips/assets/fonts/Pretendard-LICENSE.txt`)를 쓰고 pdfkit 이 쓴 글자만 넣는다(표본 한 장 약 60KB). 글꼴은
`nest-cli.json` `assets`(`payslips/assets/**/*`, `watchAssets`)가 `dist/payslips/assets` 로 복사하고 `__dirname` 기준으로 읽는다 —
jest 는 `src/payslips/assets` 를 읽는다. **이미 떠 있던 `nest start --watch` 는 assets 설정을 다시 읽지 않으므로** 설정을 더한 뒤에는
다시 띄우거나 글꼴을 `dist/payslips/assets/fonts` 에 복사해야 한다(없으면 그 경로만 500).
