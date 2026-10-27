---
type: API
title: Staff member list, detail and detail summary
description: PUT /staff-members/:id/birth-date — the 관리자 생년월일 정정 (WHALEERP-602; 상세의 birthDateCorrectable 이 버튼 표시 판정), GET /staff-members — the 관리자 웹 직원 목록 in one call (점포 조건 storeIds · storeTypes 로 상단 점포 범위와 잇는다), GET /staff-members/:id — one 직원 in the same shape plus the account e-mail, 직무 · 입사일 · 생년월일 (초대·가입 상태, 연결 보류, 최근 계약, 재직), and GET /staff-members/:id/summary/{contracts,work-schedules,payslips,todos} — the 상세 요약 areas, each behind its own menu read permission, and GET /staff-members/:id/work-schedules — the 근무스케줄 표 with a period filter, pages and the period's work-minute total; the derived StaffJoinState, 본사 제공 동의 masking, and why out-of-scope stores are not an error.
tags: [staff, list, admin, masking, invitation]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-26T07:41:19Z }
sources:
  - id: hq-sharing
    resource: ../../src/admin-scope/hq-sharing.ts
    title: 본사 제공 동의를 직원 레코드의 계정에서 읽는 조각
    last_modified: 2026-10-21T09:06:34Z
  - id: staff-member-list-service
    resource: ../../src/staff-members/staff-member-list.service.ts
    title: StaffMemberListService (scope · where · page · assemble · mask · findOne)
    last_modified: 2026-10-26T02:25:03Z
  - id: join-state
    resource: ../../src/staff-members/join-state.ts
    title: StaffJoinState — display (joinStateOf) and filter (joinStateWhere)
    last_modified: 2026-10-12T07:48:54Z
  - id: staff-members-controller
    resource: ../../src/staff-members/staff-members.controller.ts
    title: GET /staff-members · GET /staff-members/:id (직원 정보 관리 조회 권한)
    last_modified: 2026-10-21T01:46:17Z
  - id: response-dto
    resource: ../../src/staff-members/dto/staff-member-list.response.dto.ts
    title: 응답 — 목록 한 줄(StaffMemberListItemDto) · 상세(StaffMemberDetailResponseDto, 계정 이메일 · 직무 · 입사일 · 생년월일 · 재직 이력)
    last_modified: 2026-10-26T02:32:13Z
  - id: summary-controller
    resource: ../../src/staff-members/staff-member-summary.controller.ts
    title: GET /staff-members/:id/summary/{contracts,work-schedules,payslips,todos} (WHALEERP-183)
    last_modified: 2026-10-22T07:45:10Z
  - id: summary-service
    resource: ../../src/staff-members/staff-member-summary.service.ts
    title: StaffMemberSummaryService — 영역 메뉴 권한 → 범위 → 영역 읽기
    last_modified: 2026-10-22T07:45:10Z
  - id: summary-dto
    resource: ../../src/staff-members/dto/staff-member-summary.response.dto.ts
    title: 상세 요약 응답 DTO
    last_modified: 2026-10-22T07:45:10Z
  - id: payslip-shared
    resource: ../../src/payslips/payslip-shared.ts
    title: 명세서 공용 조각 — 줄 금액 amountOf(기본급 기준) · BASE_PAY_ITEM_CODE
    last_modified: 2026-10-22T07:45:10Z
  - id: week-query-dto
    resource: ../../src/staff-members/dto/staff-member-week.query.dto.ts
    title: 근무스케줄 영역 쿼리 — weekStart(그 주의 아무 날짜)
    last_modified: 2026-10-21T08:26:04Z
  - id: work-schedule-list-controller
    resource: ../../src/staff-members/staff-member-work-schedules.controller.ts
    title: GET /staff-members/:id/work-schedules (WHALEERP-185)
    last_modified: 2026-10-22T04:49:53Z
  - id: work-schedule-list-service
    resource: ../../src/staff-members/staff-member-work-schedules.service.ts
    title: StaffMemberWorkSchedulesService · periodRange — 근무스케줄 관리 권한 → 범위 → 기간 · 페이지 · 합계
    last_modified: 2026-10-22T04:49:32Z
  - id: work-schedule-list-dto
    resource: ../../src/staff-members/dto/staff-member-work-schedule-list.query.dto.ts
    title: 근무스케줄 표 쿼리 — period · page · pageSize(20 · 50 · 100)
    last_modified: 2026-10-22T04:49:32Z
  - id: work-schedule-list-response-dto
    resource: ../../src/staff-members/dto/staff-member-work-schedule-list.response.dto.ts
    title: 근무스케줄 표 응답 — items · total · totalWorkMinutes
    last_modified: 2026-10-22T04:29:39Z
  - id: access-messages
    resource: ../../src/auth/access-messages.ts
    title: 관리자 403 문구 — READ_DENIED_MESSAGE 「조회 권한이 없습니다.」
    last_modified: 2026-10-21T09:08:15Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: AdminScopeService.getManageableStores · hidesPersonalData
    last_modified: 2026-10-26T07:41:19Z
  - id: query-dto
    resource: ../../src/staff-members/dto/staff-member-list.query.dto.ts
    title: 요청 — 목록 필터(storeIds · storeTypes · joinState · employmentType)
    last_modified: 2026-10-23T03:52:09Z
  - id: birth-date-controller
    resource: ../../src/staff-members/staff-birth-date.controller.ts
    title: PUT /staff-members/:id/birth-date (직원 정보 관리 수정 권한, WHALEERP-602)
    last_modified: 2026-10-26T02:32:04Z
  - id: birth-date-correctable
    resource: ../../src/staff-members/birth-date-correctable.ts
    title: isBirthDateCorrectable — 정정 서비스와 상세 birthDateCorrectable 이 함께 쓰는 판정
    last_modified: 2026-10-26T02:32:13Z
  - id: birth-date-dto
    resource: ../../src/staff-members/dto/birth-date-correction.dto.ts
    title: 생년월일 정정 요청 DTO
    last_modified: 2026-10-26T02:32:13Z
  - id: birth-date-service
    resource: ../../src/staff-members/staff-birth-date.service.ts
    title: StaffBirthDateService — 생년월일 정정 + 계정 변경 이력
    last_modified: 2026-10-26T02:32:04Z
  - id: design
    resource: ../../docs/plans/2026-10-12-staff-member-list-design.md
    title: 직원 목록 조회 API 설계 (WHALEERP-329)
    last_modified: 2026-10-13T04:05:39Z
---

# 직원 목록 (GET /staff-members)

관리자 웹 직원 정보 관리 목록을 한 번에 그린다(WHALEERP-329). 이 저장소의 첫 실제 도메인 목록 API 라 목록
규칙(`{ items, total }`, page · pageSize, 같은 `where` 의 `$transaction`, 고유값으로 끝나는 정렬)의 참고
구현이다. 쿼리 수는 페이지 크기와 상관없이 고정이다(관리 범위 2 · 트랜잭션 1 · 점포와 계약 동시 1, 왕복 4번 — `storeTypes` 를 주면
폐점을 가리는 점포 조회가 1번 더해 5번) —
직원 페이지를 먼저 얻고, 그 직원 ID 로 점포 · 최근 계약을 따로 읽어 합친다. `stores` 는 3팀 모델과 Prisma 관계가
없어 `include` 할 수 없다.

`joinState` · `employmentType` · `storeIds` · `storeTypes` 는 쉼표 목록이다. 공백 처리는 다르다 — `joinState` ·
`employmentType` 은 조각의 앞뒤 공백을 지우고, 점포 두 칸(`storeIds` · `storeTypes`)은 공백이 있으면 400 이다(근로계약
목록과 같은 형식). 화면의 「가입·인증」 묶음(초대 발송 =
`INVITED,EXPIRED,REJECTED`)을 그대로 받아 하나라도 맞으면 낸다. 빈 값은 400 이라 「하나도 고르지 않음」은 api 로
표현되지 않는다 — 화면이 부르지 않고 0건으로 그린다. 파라미터를 빼면 전체가 나오므로 둘을 바꿔 쓰면 안 된다.

**점포 조건은 상단 점포 범위와 잇는다**(2026-10-22 재영 「3팀 목록에 상단 점포 범위 연동」). `storeIds` · `storeTypes` 는
근로계약 목록(`ListContractsQueryDto`, api #132)과 **형식만** 같다 — 반복(`storeIds=1&storeIds=2`)과 쉼표(`storeIds=1,2`)를
섞어도 받는다. 아래 폐점 제외는 근로계약 목록에 없고 TO-DO 목록의 기준이다. `storeIds` 는 쉼표로 1000개까지다. 같은 키
반복도 받지만 쿼리 파서가 키를 1000개까지만 읽어, 넘치면 뒤쪽 조건(`storeIds` 뒤쪽만이 아니라 뒤에 오는 다른 조건도)이
400 없이 빠지므로 많을 때는 쉼표로 보낸다. `storeTypes`(DIRECT · FRANCHISE)를 주면 그 유형 점포만이고 **폐점 점포는 뺀다** —
TO-DO 목록(api #133)과 같은 기준(`storeStatusCode` ≠ `CLOSED`, 미운영은 남는다)이고, 폐점 점포는 전체나 점포를 골라(`storeIds`) 본다.
`storeTypes` 를 주지 않으면 유형 · 폐점과 상관없다. 둘을 함께 주면 둘 다 맞는 점포만(교집합)이고, 둘 다 관리 범위 안에서만
거른다. 폐점을 가리는 점포 조회는 `storeTypes` 가 있고 남은 점포가 있을 때만 한 번 더 돈다(왕복 5번). 남은 점포가 없으면
직원을 묻지 않고 0건이다.

# 직원 상세 (GET /staff-members/:id)

직원 한 명을 목록 한 줄과 같은 모양(`StaffMemberListItemDto`)에 계정 이메일을 더해 낸다(WHALEERP-599 · 177). 관리자 웹 직원 상세와 퇴직
처리 화면이 재직 상태 · 퇴직일 · 가입 상태를 이것으로 그린다. 기본 정보의 직무 · 입사일 · 생년월일도 여기에 있고, 근로계약 ·
근무스케줄 · 급여명세서 · TO-DO 영역은 아래 「직원 상세 요약」의 따로 된 경로다(WHALEERP-183).

`:id` 는 `staffMemberId` 다. 목록의 행은 모두 직원 레코드라 「초대만 있는 행」은 없고, `staffMemberId` 가 null 인
것은 가린 행뿐이다. 계산은 목록과 한 메서드(`toItems`)를 함께 쓴다 — 가입 상태 · 초대 · 보류 · 최근 계약을 따로
만들면 상세와 목록이 같은 직원을 다르게 그린다. e2e 가 「상세 = 목록의 같은 줄」을 실제 DB 로 확인한다.

없는 직원, 관리 범위 밖, 가려지는 직원(본사 역할에게 동의 없는 가맹 점포 직원)은 모두 같은 404 다 — 퇴직 처리와
같은 규칙이고, 가르면 다른 BP 에 그 ID 의 직원이 있다는 것이 드러난다. 그래서 상세의 `isMasked` 는 늘 false 다.
ID 형식 오류(숫자 아님, `1..2147483647` 밖)도 DB 에 묻기 전에 404 다(`parseRouteId`).

**상세만 계정 이메일(`email`)을 더 싣는다**(`StaffMemberDetailResponseDto`, WHALEERP-177 · 180). 직원 계정의
현재 이메일(`accounts.email`)이고, 회원 ID 로 취급한다 — 로그인 아이디이자 비밀번호 재설정 링크가 가는 곳이라, 초기화
확인창도 「재설정 링크가 이메일 아이디 OOO 으로 발송됩니다」에 쓴다. 직원이
근무지에 직접 와서 물으면 마주한 관리자가 상세에서 보고 알려 준다. 전화나 메시지로는 알려 주지 않는다(운영 정책
ACC-16). 관리자 웹에 이메일 찾기 확인 화면은 따로 없고, 이메일 아이디 변경 요청도 받지 않는다. 화면은 보이기만 하고
고치지 못한다(ACC-17).

「상세는 목록보다 개인정보를 더 내지 않는다」(api #53)의 **첫 번째 예외는 이메일(회원 ID)이다**(WHALEERP-180, ACC-16 · 17). 두 번째는 생년월일이다(WHALEERP-183, 아래 「기본 정보 칸」).
아래 중 하나라도 어긋나면 상세는 그대로 200 이고 `email` 만 **null** 이다.

- **권한** — 상세를 볼 수 있는 관리자, 곧 직원 정보 관리(`MN000005`) **조회**다. 근무지에서 직원을 마주한 관리자가 조회만
  켠 그룹일 수 있어, 수정 권한을 따로 묻지 않는다(2026-10-16 영주, api #56 의 「수정 권한이 있을 때만」을 뺐다).
  **재설정 링크 발송은 여전히 수정 권한이다** — 조회만 있는 관리자는 이메일은 보지만 링크는 403 이다.
- **범위** — 점포 기준(`canManageStaffAccount` 와 같은 값, `hidesPersonalData(…, false)`). 상세의 가림은 동의
  기준이라 본사 역할(BM · BA)도 동의한 가맹 점포 직원의 상세를 받지만, 이메일은 null 이고 링크는 404 다. 동의는 자료를
  보는 데 대한 것이라 계정 정보로 넓히지 않는다(2026-10-14 재영, 운영 정책 ATT-30).
- **상태** — 가입 전(계정 없음) · 탈퇴 계정 · 퇴직 레코드는 내지 않는다. 퇴직 레코드는 계정이 살아 있어도 전 근무지
  관리자에게 그 로그인 아이디를 계속 보이지 않는다(2026-10-16 영주). 연결 보류(`LINK_HOLD`) 계정은 낸다.

판정은 이미 읽은 값(관리 범위의 점포 유형 · 직원 행 · 계정)만 쓰고 쿼리를 더하지 않는다. 화면(front #37)은 본사 역할 +
직영이 아닌 점포 직원, 퇴직 직원, 이메일이 없는 가입 완료 직원에게 초기화 버튼을 숨긴다. 가린 직원은 상세가 이미
404 라 이 칸에 닿지 않는다. 상세의 「이메일」 줄은 위 null 경우(퇴직 · 본사 역할의 가맹 점포 직원 · 가입 전 · 탈퇴)에
「-」로 보인다.

**관리자는 이메일을 고칠 수 없다.** `accounts.email` 을 쓰는 관리자 경로가 없다 — 지금(2026-10-16) 관리자가 직원을 쓰는 요청은
근로계약 등록 · 수정(`CreateContractDto`, 직원 레코드의 점포 · 이름 · 번호 · 고용 형태 · 직무)과 퇴직 처리 · 퇴직일
변경(`RetirementDateDto`)뿐이고, 둘 다 `email` 칸이 없다. 전역 `ValidationPipe` 가 `forbidNonWhitelisted` 라
`email` 을 실으면 무시하지 않고 400 이다. `email-immutable.spec.ts` 가 두 DTO 를 확인한다. 실제 요청으로는 계약 e2e 가 네 경로(`POST /contracts` ·
`PUT /contracts/:id` · 종이 계약 `POST /contracts/paper` · `PUT /contracts/:id/paper` 의 multipart `data` 칸)에서
400 이고 직원 · 계약 당사자 · 파일을 쓰지 않음을, 퇴직 e2e 가 400 과 계정 이메일 · 퇴직일이 그대로인 것을 확인한다. 둘 중 하나에 `email` 칸이 생기면 이 테스트가 깨진다. 직원을 쓰는 관리자 요청을 새로 만들면 그 DTO 도
`email-immutable.spec.ts` 에 더한다. 직원 근무 앱의 로그인 이메일 변경(`POST /me/profile/email-change-pins` · `email-change`, [내 정보](/api/my-profile.md))은
본인 경로라 이 규칙 밖이다.

**목록에는 싣지 않는다** — 목록 화면은 쓰지 않고, 한 페이지에 최대 200명의 주소를 내보낼 이유가 없다. 그래서 목록은
계정에서 본사 제공 동의 한 칸만 읽고, 이메일 · 상태는 상세 쿼리(`DETAIL_SELECT`)만 읽는다. 「상세 = 목록의 같은 줄」은
이 한 칸을 빼고 성립한다.

**가림은 점포 · 계약을 읽기 전에 정한다.** 직원 한 건을 읽은 직후 `hidesPersonalData` 로 판정해 끝낸다 — 응답
줄을 다 만든 뒤 `isMasked` 로 거르면 가려지는 직원의 404 만 점포 · 계약 조회 한 번만큼 늦어, 조회 권한이 있는
BM · BA 가 ID 를 차례로 불러 응답 시간으로 목록이 숨긴 「자기 BP 가맹 점포의 미동의 직원」 ID 를 모을 수 있다
(PR #53 리뷰). 없는 직원 · 범위 밖 · 가려지는 직원이 모두 같은 쿼리(직원 조회 하나) 뒤에 404 다. 응답 줄을 만든 뒤에도 `isMasked` 면 한 번 더 null 이다 — 지금은 두 판정이 같은 값이지만, 목록 쪽 가림 조건만
바뀌어도 상세가 가린 줄을 200 으로 내지 않게 하는 안전장치다.

# 직원 상세 요약 (GET /staff-members/:id/summary/…)

관리자 웹 직원 상세의 영역들이다(WHALEERP-183, 2026-10-21 노영주). 영역마다 경로가 따로라 **한 영역이 실패해도 나머지는
그대로 온다** — 화면은 영역마다 부르고, 실패한 영역에만 안내를 보인다.

| 경로 | 영역 메뉴 | 내용 |
|---|---|---|
| `…/summary/contracts` | 근로계약 관리 `/contracts` | 가장 최근 계약(목록 · 상세의 `contract` 와 같은 정렬 — 연장 재계약이 임시저장이거나 거부 · 만료 · 체결 없이 종료로 끝났으면 건너뛴다, `NOT_IDLE_RENEWAL` WHALEERP-156) 하나의 유형 · 방식 · 상태 · 기간 · 최근 발송일 · 갱신 예정일. 계약이 없으면 `{ contract: null }` |
| `…/summary/work-schedules?weekStart=` | 근무스케줄 관리 `/work-schedules` | 한 주(월~일)의 근무스케줄과 근무시간 · 주간 합계(분). `weekStart` 는 그 주의 아무 날짜, 빼면 이번 주(한국 날짜) |
| `…/summary/payslips` | 급여명세서 관리 `/payslips` | 최근 명세서 3건(`recent` — 상태와 관계없이 급여 기간 시작일 최신순, 기본급 · 수당 · 공제 · 실지급액 · 상태) · 미발송 건수 |
| `…/summary/todos` | TO-DO 관리 `/todos` | 배정된 TO-DO 의 전체 · 완료 · 미완료 건수와 최근 처리 이력 5건 |

**권한은 둘이다.** 컨트롤러가 `/staff-members` 라 가드가 직원 정보 관리(`MN000005`) 조회를 보고, 서비스가 그 영역 메뉴의
조회 권한을 다시 본다(`adminHasMenuAction`, 가드와 같은 판정). 영역 권한이 없으면 **그 영역만 403 「조회 권한이 없습니다.」**
(`READ_DENIED_MESSAGE`)이고 상세 · 다른 영역은 그대로다 — 공통 403 문구(「접근 권한이 없습니다. 관리자에게 문의해 주세요.」)와
다르게 둔 것은 화면이 이 문구로 「영역만 막힘」을 가르기 때문이다. 영역 권한은 범위보다 먼저 본다 — 권한이 없으면 어떤 ID
든 같은 403 이라 응답으로 직원의 있고 없음이 갈리지 않는다. 그 다음 범위는 상세와 같은 판정(`canManageStaffMember`)이라
없는 직원 · 관리 범위 밖 · 가려지는 직원은 같은 404 다. 이미 있던 TO-DO 목록 `GET /staff-members/:id/todos`(#118)도
같은 규칙이다 — 처음에는 직원 정보 관리 조회만 봐서, TO-DO 관리 조회가 없는 관리자에게 목록은 보이고 요약만 막혔다(api #113
리뷰). 2026-10-22 노영주 결정(재영 10-21 영역 규칙의 1안)으로 목록에도 TO-DO 관리 조회를 걸어 TO-DO 칸 전체가 한 기준이다.
두 곳 모두 `requireAreaRead`(`src/auth/menu-permission.guard.ts`)를 쓴다. 「어떤 ID 든 같은 403」은 형식이 맞는 ID 이야기다 —
숫자가 아니거나 범위(`1..2147483647`) 밖이면 권한을 묻기 전에 404 다(드러나는 것이 없다).

**영역 메뉴가 없어지면 로그가 남는다.** 가드는 `/staff-members` 메뉴만 보므로, 영역 메뉴(`/contracts` 등)의 URL 을 바꾸거나
사용중지하면 모든 관리자에게 그 영역이 403 이 된다. 화면은 이것을 권한 없음으로 그리므로, 서비스가 거절할 때 가드와 같은
`reportMissingMenu` 로 「판정에 쓸 사용 중 메뉴가 없습니다」 오류 로그를 남긴다(응답은 그대로 403).

정하고 넘어간 것:

- **갱신 예정일**은 체결 완료이고 종료일이 오늘(한국 날짜) 이후일 때 종료일 30일 전이다 — 관리자 웹 `renewalDateOf` 와
  같고, 30일은 갱신 예정 알림 계획(#152 · #154)과 같다. 종료일이 지난 체결 완료는 종료 배치 전의 잠깐이라 내지 않는다.
  종료일이 30일 안이면 갱신 예정일은 이미 지난 날짜다.
- **최근 발송일**은 `contracts.sent_at` 이다. 발송 · 재발송 때 덮어쓰므로 그대로 「최근」이다. 발송 이력 로그 테이블이
  생겨도 값은 같다.
- **최근 명세서**는 이 직원 레코드의 명세서 3건이다 — 상태와 관계없이(작성 중 포함) 급여 기간 시작일 최신순, 같으면
  명세서 ID 내림차순(WHALEERP-186, 2026-10-22 — 데모의 최근 명세서 표). **기본급**(`basePayAmount`)은 기본급 항목(`payslip_items` 중
  `payslip_item_masters.item_code = 'BASE_PAY'`)의 금액이다 — 명세서 지급 총액을 셀 때와 같은 기준(`amountOf`,
  `src/payslips/payslip-shared.ts`)이라 관리자 수정값 ?? 시스템 계산값 ?? 0 이고, 항목이 없거나 넣지 않은 줄
  (`is_entered = false`)이면 계산값이 있어도 null 이다. **수당**(`allowanceAmount`)은 지급 총액 − 기본급(null 이면 0)이라 지금은 늘 숫자다 — 기본급이 없으면 지급
  총액이 모두 수당으로 보인다(타입은 null 을 열어 둔다). **미발송**은 발송 완료가 아닌 모두(작성 중 · 검토 중 · 확정)다 —
  데모의 「미발송 1건」이 검토 중을 센 것과 같다(2026-10-21 노영주).
- **근무스케줄**은 그 직원 레코드의 지우지 않은 근무스케줄을 시작 일시의 한국 날짜(근무일)로 고른다 — 일요일 밤에 시작해
  월요일로 넘어간 근무는 그 주에 든다. 「그날 받을 수 있는 직원」 판정(등록 · 수정 · 선택지용)은 하지 않는다. 퇴직이
  확정되면(퇴직일 다음 날 배치) 퇴직일 뒤 근무스케줄이 지워지고, 퇴직 예정인 동안에는 남아 보인다. `weekStart` 가 있는
  날짜가 아니면 400 이고, 근무스케줄의 점포를 찾지 못하면(외래키가 깨진 것) 빈 이름 대신 500 이다 — 직원 목록과 같다.
- **TO-DO** 완료는 행의 상태(`DONE`)로 센다 — 각자 수행은 직원마다 행이고 한 명 수행은 공유 1행이라, 한 명 수행은 다른
  배정자가 끝내도 완료다. 건수는 한 쿼리(`groupBy`)로 세어 전체 = 완료 + 미완료가 늘 맞는다. 퇴직으로 풀리는 것은 미완료
  개인 배정뿐이라, 완료한 TO-DO 와 근무지 전체 배정은 퇴직 뒤에도 센다. 최근 이력 5건은 바뀐 일시 내림차순이고 등록(`fromStatus`
  null) · 상태 변경 · 긴급 표시 변경(`isUrgentChanged`)을 모두 담는다 — 화면이 두 칸으로 문구를 나눈다(2026-10-21 노영주).
  다른 배정자의 퇴직 배정 해제 행(`unassigned_staff_member_id`, 같은 상태 그대로)은 이 직원의 일이 아니라 뺀다. 이력의 「바꾼 쪽」은
  `ADMIN` · `STAFF` · `SYSTEM` 만 낸다(관리자와 직원이 함께 있으면 관리자, 둘 다 없으면 퇴직 배치 등 시스템). 한 명
  수행이면 바꾼 직원이 다른 사람일 수 있어 누구인지는 내지 않는다.

**하지 않은 것.** 출퇴근 현황 영역(이번 주 출근 · 지각 · 결근 · 조기 퇴근 횟수)은 없다 — `attendance_records` 에 쓰는
곳이 아직 없고(급여 초안이 읽기만 한다) 지각 · 결근 판정 규칙도 정해지지 않았다. 183 에서 떼어 출퇴근 작업과 함께 따로 한다(2026-10-21 재영). **본인인증 상태**도 내지 않는다 — 가입에
본인인증이 없어(okf [staff signup](/api/staff-signup.md) 「No 본인인증」) 채울 값이 없다. WHALEERP-612 로 떼어 2차 범위로 미뤘고, 1차 직원 상세에는 보이지 않는다
(2026-10-21 재영).

# 직원 상세 근무스케줄 표 (GET /staff-members/:id/work-schedules)

관리자 웹 직원 상세의 근무스케줄 표다(WHALEERP-185, 2026-10-22 노영주). `?period=&page=&pageSize=` 를 받아
`{ items: [{ workScheduleId, workDate, storeName, startTime, endTime }], total, totalWorkMinutes }` 를 낸다. 요약의
근무스케줄 영역(`…/summary/work-schedules`, 한 주)은 그대로 둔다. 「한 사람」은 이 직원 레코드(그 점포)다 — 같은 사람의
다른 점포 레코드는 들지 않는다.

**권한 · 범위는 요약 영역과 같다.** 가드가 직원 정보 관리 조회, 서비스가 근무스케줄 관리(`/work-schedules`) 조회를
`requireAreaRead` 로 다시 본다. 응답은 이 순서로 정해진다:

1. 가드 403 — 직원 정보 관리 조회 없음(직원 앱 토큰 · 사용 중이 아닌 관리자 계정도)
2. 400 — `period` · `page` · `pageSize` 오류(전역 ValidationPipe)
3. 404 — ID 형식 오류(숫자가 아니거나 `1..2147483647` 밖, 컨트롤러)
4. 영역 403 「조회 권한이 없습니다.」 — 근무스케줄 관리 조회 없음(서비스). 형식이 맞는 어떤 ID 든 같은 403 이다
5. 범위 404 — 없는 직원 · 범위 밖 · 본사 동의로 가려지는 직원(서비스)

**기간은 시작 일시의 한국 날짜(근무일)로 자른다.** `THIS_WEEK`(기본) 는 오늘(한국 날짜)이 든 주의 월~일이다.
`LAST_4_WEEKS` · `LAST_3_MONTHS` · `LAST_1_YEAR` 는 오늘에서 28일 · 3개월 · 12개월 전 날짜(그날 0시 포함)부터이고
**상한이 없다 — 미래에 잡힌 근무까지 든다.** 달은 `addMonths` 라 그 달에 같은 날이 없으면 마지막 날이다(5월 31일 − 3개월
= 2월 28일). `ALL` 은 조건이 없다 — 생성일로부터 3년 지난 것은 파기 배치([work schedules](/api/work-schedules.md))가
지우므로 여기서 따로 자르지 않는다. 지운 근무스케줄(`is_deleted`)은 뺀다.

**정렬은 근무일 내림차순 → 같은 날은 시작 시각 오름차순 → ID** 다. 날짜와 시각이 반대 방향이라 Prisma `orderBy` 로
쓸 수 없어 SQL(`ORDER BY (start_at AT TIME ZONE 'Asia/Seoul')::date DESC, start_at, work_schedule_id`)이다. 그래서
`total` · `totalWorkMinutes` 도 `count` 대신 같은 WHERE 조각을 쓰는 집계 SQL 하나로 세어(같은 `$transaction`) 페이지와 다른
행을 세지 않는다. `totalWorkMinutes` 는 고른 기간 전체(페이지와 무관)의 합이고 한 건은 요약의 `workMinutes` 와 같은 식(종료 −
시작(분) − 휴게)이다. 0건이면 0. 페이지당 건수는 급여명세서 목록 · 근무스케줄 변경 이력과 같은 20 · 50 · 100(기본 20)이다.

`work_schedules` 에 `staff_member_id` 전용 btree 인덱스는 없다 — 직원 조건은 겹침 금지 EXCLUDE 의 gist 인덱스(`staff_member_id`
가 앞, btree_gist)가 받는다. 그 제약은 `WHERE (NOT is_deleted)` 부분 제약이라 인덱스도 부분 인덱스이고, 쿼리가 같은
`NOT is_deleted` 를 걸기 때문에 플래너가 쓸 수 있다 — 지운 행까지 보는 조회로 바꾸면 이 인덱스를 못 쓴다. 한 직원 레코드의
행은 생성일로부터 3년 지나면 파기 배치가 지워 많아야 천 단위여서 새 인덱스(마이그레이션)는 두지 않았다. 목록 밖 `period` 는 컨트롤러 검증이 막고,
서비스를 직접 불러도 다른 기간으로 바꿔 답하지 않고 400 이다(요약의 `weekStart` 와 같다). 근무스케줄의 점포를 찾지 못하면
(외래키가 깨진 것) 근무스케줄 · 점포 · 직원 ID 를 오류 로그로 남기고 500 이다.

## 기본 정보 칸 (상세에 더한 것)

상세 응답에 직무(`jobTitle`) · 입사일(`hiredDate`) · 생년월일(`birthDate`) · 본사 제공 동의 상태(`hqSharingConsent`)를
더했다. 목록 줄에는 없다.

- **본사 제공 동의 상태**(WHALEERP-184 완료 조건 8, 2026-10-21 노영주)는 API 전용 enum `HqSharingConsentState`
  (`AGREED` 동의 · `NOT_AGREED` 미동의, `GET /enums`)이고, **직영 점포 직원은 null** 이다 — 동의가 판단에 쓰이지 않는다.
  출처는 가림과 같은 값이다: 동의는 계정에 하나라(`accounts.is_hq_sharing_consented`, 소속별이 아님, 2026-10-20) 철회하면
  바로 미동의이고, 가입 전(계정 없음)은 미동의다(`hqSharingConsentedOf`). 직영 판정도 가림과 같아 모르는 점포 유형은 가맹으로
  본다. 본사 역할(BM · BA)은 미동의 직원 상세가 이미 404 라(ATT-30) 그들이 보는 값은 늘 동의다 — 미동의는 가맹 역할 ·
  플랫폼이 보는 값이다. e2e 가 직영 null · 동의 · 가맹마스터가 본 가입 전 직원의 미동의 · 본사 역할의 404 를 확인한다.

- **입사일**은 `staff_members.hired_date` 그대로다 — 퇴직일 검사도 이 칸을 보므로 계산값으로 바꾸지 않았다(2026-10-21
  노영주). **그 점포에서 처음 체결 완료된 근로계약의 시작일을 시스템이 채우고, 갱신 계약이 와도 바꾸지 않는다**(2026-10-21
  재영, WHALEERP-613): 체결 완료(날인 · 종이 계약 등록) 때 비어 있으면 채운다([Contracts API](/api/contracts-api.md)).
  퇴직 뒤 재입사는 새 레코드라 새 계약의 시작일이 된다. 그 전에 체결 완료된 직원은 마이그레이션
  `20261022142048_team3_staff_hired_date_backfill` 로 한 번 채웠다. 체결 완료 전(임시저장 · 발송 대기 · 서명 대기 ·
  거부 · 만료)에는 비어 있다.
- **생년월일**은 「상세는 목록보다 개인정보를 더 내지 않는다」(api #53)의 **두 번째 예외**다.
  가림만 지나면 낸다 — 본사 역할은 본사 제공 동의한 가맹 점포 직원에게도, 퇴직 직원도 받는다(2026-10-21 재영 확정). 근거: 생년월일은 동의 대상인 근로계약서의 당사자 정보에 이미 있고, 날인 전 본인 대조로 계정
  값과 맞추므로 계정 값을 보여도 더 드러나는 것이 없다. 이메일은 계약서에 없는 계정 정보라 지금처럼 본사 역할 · 퇴직에
  숨긴다. 가입한 계정의 값을
  먼저 쓰고, 가입 전 · 탈퇴 계정이면 **생년월일이 적힌** 가장 최근 계약에 관리자가 적은 값(`contract_parties.entered_birth_date`)이다 — 새 계약을 생년월일 없이 임시저장해도 예전 계약의 값이 보인다(api #113 리뷰). 그 계약은
  상세의 `findFirst` 호출 하나 안에서 한 건만 읽는다. 가림 판정 전에 읽으므로 가려지는 직원(404)과 보이는 직원(200)이
  같은 조회를 거친다 — 응답 시간으로 둘이 갈리지 않는다.

## 재직 이력 (상세에 더한 것)

퇴직한 직원이 같은 점포에 다시 입사하면 새 직원 레코드가 생기고(api #65), 새 레코드의 `previous_staff_member_id` 가
같은 사람의 직전 재직 레코드를 가리킨다(WHALEERP-615, 2026-10-22 김민식 — 근로계약 저장이 채운다, [Contracts API](/api/contracts-api.md)).
상세는 이 사슬을 따라 `previousRecords`(이전 재직 기간, 가까운 것부터)와 `laterRecords`(이후 재입사한 레코드, 가까운
것부터)를 낸다. 한 칸은 `staffMemberId` · `hiredDate` · `retiredDate` 이고, 화면의 「재직 이력」이 누르면 그 레코드의
상세로 간다. 이은 레코드가 없으면 둘 다 빈 목록이다.

- **목록은 그대로다** — 레코드마다 한 줄이고 묶거나 꼬리표를 붙이지 않는다(2026-10-22 재영 C안). 그래서 목록 줄에는 없다.
- **가림은 레코드마다 본다.** 같은 점포 레코드만 이어지지만 동의는 계정 칸이라, 본사 역할에게 동의한 가입 레코드의 상세가
  열려도 그 앞의 가입 전 레코드(계정 없음 = 미동의)는 가려진다 — 그런 칸은 빼고 다음으로 지나간다.
- 사슬은 방향마다 재귀 쿼리 하나(`linkedRecords`, `previous-records.ts`)로 읽고 그 레코드들을 한 번에 읽는다 — 재입사가
  많아도 쿼리 수가 늘지 않는다. 이후 쪽에 같은 레코드를 이은 것이 둘 이상이면 모두 낸다(걸음 수, 같으면 만든 순서). 저장은
  사슬이 돌지 않게 잇지만, 지난 레코드는 다시 지나지 않아 돌아도 멈춘다.
- **체결 완료된 계약이 있는 레코드만** 재직 기간으로 낸다(2026-10-23 김민식) — 임시저장 · 발송만 한 재입사 레코드는 옛
  레코드의 이후 재직 기간에 나오지 않는다. 판정은 상태 이력에 `SIGNED` 가 있는 계약이 한 건이라도 있는가다(종료 · 대체로
  닫혀도 남는다). 빼고도 사슬은 계속 따라간다.
- 이 칸이 생기기 전에 만든 재입사 레코드는 채우지 않아 이력이 비어 보인다.

# 직원 생년월일 정정 (PUT /staff-members/:id/birth-date)

직원은 가입 뒤 생년월일을 고치지 않는다(ACC-13). 가입 때 잘못 넣으면 신고 정보의 주민등록번호 앞자리 검사
(`RRN_BIRTH_MISMATCH`)에 걸려 저장할 수 없으므로, 관리자가 확인해 정정하는 길을 둔다(WHALEERP-602, 재영 TAX-09).
본문은 `{ birthDate: "YYYY-MM-DD" }`, 성공은 204 다. 정정 이력을 조회하는 API 는 없다(화면에 보이지 않기로 함).

- **권한 · 범위** — 직원 정보 관리(`MN000005`) 수정 권한. 퇴직 처리와 같은 `staffInScope` 방식이라 정수 범위 밖 ID ·
  관리 범위 밖 · 본사 제공 동의로 가린 직원은 모두 같은 404 「직원을 찾을 수 없습니다」다.
- **무엇을 고치나** — 그 직원 레코드의 계정(`StaffMember.accountId` → `accounts.birth_date`). 계정에 하나라 **같은 사람의 다른
  BP 소속에도 같이 바뀐다**(허용, 따로 알리지 않는다 — 재영 10-21). 계약서의 입력 · 본인인증 생년월일
  (`contract_parties.entered_birth_date` · `verified_birth_date`)은 그 시점 값이라 바꾸지 않고, 날인 대기 중인 계약이 있어도
  막지 않는다(노영주). 다만 날인 대기 계약은 날인 때 `entered_birth_date` 와 계정 생년월일을 다시 대조하므로, 정정으로 대조가 풀릴 수도 있고(보통) 새로 어긋날 수도 있다. 계정 하나라 다른 BP 의 계약에도 같다.
- **이력** — 같은 트랜잭션에서 `account_change_histories` 에 `field=BIRTH_DATE` · `channel=ADMIN_CORRECTION` · 이전 값 · 새 값
  (YYYY-MM-DD) · `requested_by`=관리자 계정 ID. 이를 위해 두 enum 에 값을 더했다(마이그레이션
  `20261026110852_team3_account_birth_date_correction`).
- **오류** — 모두 `code` + `message`. 직원 행 · 계정 행을 `FOR UPDATE` 로 잠그고, 계정 행은 잠근 뒤 상태 · 생년월일을 읽어 판단한다.

| 상태 | code | 경우 | message |
|---|---|---|---|
| 400 | `BIRTH_DATE_INVALID` | 문자열 날짜의 형식 오류 · 없는 날짜 · 오늘(KST) 뒤 날짜 | 형식: 「생년월일은 YYYY-MM-DD 형식의 있는 날짜여야 합니다」 / 오늘 뒤: 「오늘 이후 날짜는 넣을 수 없습니다.」 |
| 400 | `BIRTH_DATE_UNDER_AGE` | 오늘(KST) 기준 만 19세 미만(ACC-22, `ageOn`) | 만 19세 미만으로 정정할 수 없습니다. |
| 409 | `BIRTH_DATE_NOT_JOINED` | 계정 없음(가입 전) · 계정이 `JOINED` 가 아님(탈퇴 · 연결 보류) | 가입 전 직원은 생년월일을 정정할 수 없습니다. |
| 409 | `BIRTH_DATE_RETIRED` | 이 직원 레코드가 퇴직(`RETIRED`)이거나 퇴직일이 지났는데 배치 전(계약과 같은 `employedOn` 기준). 퇴직 예정(퇴직일이 오늘이거나 그 뒤)은 허용 | 퇴직한 직원은 생년월일을 정정할 수 없습니다. |
| 409 | `BIRTH_DATE_UNCHANGED` | 지금 값과 같음 | 지금 생년월일과 같습니다. |

문자열 날짜의 형식이 틀리거나 없는 날짜이면 `BIRTH_DATE_INVALID` 다(화면이 `code` 로 가르게). `birthDate` 가 없거나 문자열이 아니거나 모르는 필드가 섞이면 전역 `ValidationPipe` 400(배열 message, `code` 없음)이다. 상세(`GET /staff-members/:id`)의 `birthDateCorrectable` 은 NOT_JOINED · RETIRED 를 가르는 같은 판정(`isBirthDateCorrectable`) 한 함수의 결과다 —
계정이 있고 `JOINED` 이며 `employedOn` 이 참일 때 true, 수정 권한은 보지 않는다(화면이 권한으로 가린다), 목록에는 없다. `joinState` 는 직원
레코드의 가입 상태라 계정이 탈퇴 · 연결 보류여도 JOINED 로 오므로 [정정] 버튼은 이 칸으로 보인다. 계정 잠금은
따로 다루지 않는다 — 잠겨도 정정은 된다. 연결 보류를 쓸 수 없는 계정으로 볼지는 기획 확인 대기.

# 조회 권한

목록과 상세는 직원 정보 관리(`MN000005`) 조회 권한을 본다 — `@MenuPermission('read')` 를 컨트롤러에
붙였다(2026-10-15, 2026-10-21 부터 메뉴 코드 없이 컨트롤러 경로 `/staff-members` 로 메뉴를 찾는다). 권한은 가드가 범위보다 먼저 보므로, 권한이 없으면 어떤 ID 든 같은 403 이라 응답으로 직원의
있고 없음이 갈리지 않는다. 고정 권한 그룹 셋(PM000001 · BM000001 · FM000001)은 모두 조회 권한이 있다. PA · BA · FA
그룹은 만든 운영자가 켠 만큼이라, 조회를 켜지 않은 그룹이 403 이다. 그 계정에는 메뉴도 보이지 않는다. 퇴직
처리([staff retirement](/api/staff-retirement.md))와 재설정 링크 발송([authentication](/api/auth.md))은 같은 메뉴의
수정 권한이다.

# 가입·인증 상태는 DB 칸이 아니다

`StaffJoinState` 는 직원 레코드 · 초대 · 연결 보류에서 만든 API 전용 enum 이다(`GET /enums` 로 나간다).
표시(`joinStateOf`)와 필터(`joinStateWhere`)는 `src/staff-members/join-state.ts` 한 파일에 있다 — 한쪽만
고치면 필터 결과에 다른 상태가 섞인다. 「한 직원에 발송 중 초대는 하나」라는 가정(136 의 재발송 규칙)에 기댄다.
「마지막 초대」는 관계 조건으로 표현되지 않으므로 발송 중 초대가 없을 때는 순서가 아니라 있고 없음으로 가른다
(수락 > 거절 > 만료). e2e 가 직원마다 「표시한 상태의 필터 하나에만 걸린다」를 실제 DB 로 확인한다 — 관계
조건의 정확성은 목으로 증명되지 않는다.

# 본사 제공 동의 가림

BP 마스터 · BP 관리자에게 가맹 점포 직원은 본사 제공 동의(`accounts.is_hq_sharing_consented`, #137)를
하지 않았으면 가린 행이다(ATT-30). 동의는 계정에 하나라 그 사람의 모든 소속에 같이 적용되고(2026-10-20 노영주, 처음에는
직원 레코드 칸), 가입 전이라 계정이 없는 직원은 동의하지 않은 것으로 보고 가린다. 동의한 직원은 직영 점포 직원처럼 다 보이고, 철회하면 칸이 false 라 다시
가려진다. 개인 칸으로 거르면(검색 · 고용형태 · 가입 상태) 가맹 점포에서는 동의한 직원만 남긴다 — 가린 행 하나가
검색에 걸리는 것만으로 그 사람이 있다는 것이 드러나기 때문이다. 그래서 점포 조건이
`storeId ∈ 가림 대상이 아닌 점포 OR (storeId ∈ 가림 대상 점포(직영 아님) AND 동의)` 가 된다. 동의는 사람(계정)마다라
한 가맹 점포 안에서도 동의한 직원만 남고, 고른 점포가 모두 가맹이면 첫 갈래는 빈 목록이다. 재직 상태는 화면 기본
필터라 예외로 두었다(드러나는 것은 점포별 퇴직자 수와 어느 가린 줄이 퇴직했는지).

가림은 관리 범위를 정할 때 읽은 점포 유형과 행의 계정 동의로 판단하고 **직영이 아니면 동의하지 않은 직원을
가린다** — 모르는 유형도 가린다. 개인정보
규칙이라 판단이 틀릴 때 가리는 쪽이어야 한다. 점포 정보를 못 찾은 줄은 빈 칸으로 내보내지 않고 500 이다.

**가린 행은 `staffMemberId` 도 null 이다.** ID 가 있으면 직원 단위 API(퇴직 미리보기 · 처리)로 그 직원을 개인
단위로 볼 수 있어 가림이 소용없다. ID 는 순번이라 목록 없이 짐작해도 되므로, 그 API 들도 같은 기준으로 막는다 —
`AdminScopeService.canManageStaffMember` 가 본사 역할 + 직영이 아닌 점포의 동의하지 않은 직원이면 false 를 내고, 경로는 없는
직원과 같은 404 를 준다. 기준은 한 함수(`hidesPersonalData`)라 목록과 API 가 갈라지지 않는다. 점포 자체를 다루는
`canManageStore` 는 이 기준을 쓰지 않는다 — 가리는 것은 직원 개인이다(PR #13 리뷰, 2026-10-13 재영). 계정 조치인
재설정 링크 발송은 동의와 상관없이 점포 단위다(`canManageStaffAccount`) — 동의는 자료를 보는 데 대한 것이라 계정
조치로 넓히지 않는다(2026-10-14 재영, 운영 정책 ATT-30).

목록의 가림, 개인 칸 필터의 점포 조건, 직원 단위 API 의 거부가 모두 `hidesPersonalData(역할, 점포 유형, 동의)` 를
쓴다. 동의 규칙이 바뀌면 이 함수 한 곳을 고친다.

연결 보류는 인증 번호 끝 4자리와 불일치 사유만 낸다. 보류 계정에서는 번호만 `select` 한다 — 실명 · 다른 소속은
가입자의 정보다.

# 범위 밖 점포는 오류가 아니다

`storeIds` 의 범위 밖 ID 는 조용히 빠진다. 403 · 404 를 주면 다른 BP 에 그 점포가 있다는 것이 드러난다.
형식이 틀린 값(빈 칸, 숫자 아님, 1..2147483647 밖, 1000개 초과, 모르는 점포 유형)은 DB 에 닿기 전에 400 이다.

# 재발송과 거부일

재발송 간격 제한은 없다(2026-10-12 재영). `contract.canResend` 는 「이 줄의 최근 계약으로 근로계약 재발송
(`POST /contracts/:id/send`)을 누르면 가입 초대 알림톡 · 소속 추가 확인 요청이 나간다」일 때만 참이다(WHALEERP-611 ·
130) — 관리자웹은 이 값 하나로 버튼을 보인다. 예전 자리 `invitation.canResend` 는 같은 값으로 남겨 두었다(deprecated —
초대 행이 없는 줄은 invitation 이 null 이라 보일 수 없어 api #164 리뷰로 contract 쪽에 옮겼다. 화면이 옮겨 가면 뺀다).
모두 맞아야 한다:

- 가입 상태가 초대 발송 · 초대 만료 · 소속 추가 확인 · 복귀 확인이고 **보이는 초대**가 수락되지 않음(이미 수락한 초대는
  받은 링크로 다시 들어온다, 2026-10-12 yjnoh). 앞 초대만 수락했고 그 뒤 재초대(연결 보류 → 번호 수정 후 재초대)가 나갔으면
  그 재초대가 보이는 초대라 다시 보낼 수 있다 — 「수락한 초대가 하나라도 있으면 거짓」으로 하면 재초대가 만료된 뒤 다시
  보낼 길이 없다. 연결 보류 · 만 19세 미만은 api 가 보낼 수 있어도 정책으로 거짓이다(거절은 계약이 거부라 api 도 409 다).
- 또는 가입 상태가 초안(초대 행이 하나도 없음)이고 최근 계약의 초대 유형이 소속 추가 확인 · 복귀 확인 — WHALEERP-130 전
  요청 없이 서명 대기가 된 옛 계약이다(재발송이 첫 요청을 보낸다, api #164 리뷰). 다른 초대 없는 줄은 거짓이다.
- 최근 계약이 발송 대기 · 서명 대기 — 근로계약 상세 `canResend` 와 같은 `canResendContract`(`contract-status.ts`) 한 곳을 본다.
- 그 번호의 계정은 묻지 않는다 — 계정이 있으면 재발송이 소속 추가 확인 요청을 다시 보낸다(WHALEERP-130, 2026-10-26
  재영). 전에는 받을 길이 없어 409 `SEND_CHANNEL_NOT_READY` 라 번호마다 계정을 찾아 거짓으로 두었다. 그 계정이 이
  점포에 재직 중이면 보낼 때 409 다(드문 일 — 화면이 다시 읽는다).
- 휴대폰 번호(유선번호는 409 `SEND_PHONE_NOT_MOBILE`).

**가입 완료 직원은 거짓이다** — 목록의 재발송은 「가입·인증」 칸의 가입 초대 재발송이고, 가입한 직원의 앱 알림
재발송은 근로계약 상세에서 한다(가입 초대가 아니다). 그래도 어긋날 수 있는 것: 읽은 뒤 바뀐 상태(409 — 화면이
다시 읽는다), 서버 설정 누락(`STAFF_APP_URL` · `BIZPPURIO_SMS_FROM` · 템플릿 — 503), 발송 실패(502). 거짓 · 참이
계정 유무를 드러내지 않는다 — 소속 추가 확인 · 복귀 확인 가입 상태가 이미 같은 것을 보인다. 소속 추가 확인 요청을
직원이 거절하면 초대가 거절이라 가입 상태는 「거절」, 함께 온 계약은 거부라 canResend 는 거짓이다(새 계약으로 다시 보낸다).
거부일은 따로 저장하지 않아 화면이 `contract.updatedAt` 으로 「거부 · MM-DD」를 그린다. 갱신 예정은 화면이
`contract.endDate` 로 정한다.
