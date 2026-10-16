---
type: API
title: Staff member list and detail
description: GET /staff-members — the 관리자 웹 직원 목록 in one call, and GET /staff-members/:id — one 직원 in the same shape plus the account e-mail (초대·가입 상태, 연결 보류, 최근 계약, 재직); the derived StaffJoinState, 본사 제공 동의 masking, and why out-of-scope stores are not an error.
tags: [staff, list, admin, masking, invitation]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-16T08:21:10Z }
sources:
  - id: staff-member-list-service
    resource: ../../src/staff-members/staff-member-list.service.ts
    title: StaffMemberListService (scope · where · page · assemble · mask · findOne)
    last_modified: 2026-10-16T08:21:10Z
  - id: join-state
    resource: ../../src/staff-members/join-state.ts
    title: StaffJoinState — display (joinStateOf) and filter (joinStateWhere)
    last_modified: 2026-10-12T07:48:54Z
  - id: staff-members-controller
    resource: ../../src/staff-members/staff-members.controller.ts
    title: GET /staff-members · GET /staff-members/:id (직원 정보 관리 조회 권한)
    last_modified: 2026-10-16T05:17:42Z
  - id: response-dto
    resource: ../../src/staff-members/dto/staff-member-list.response.dto.ts
    title: 응답 — 목록 한 줄(StaffMemberListItemDto) · 상세(StaffMemberDetailResponseDto, 계정 이메일)
    last_modified: 2026-10-16T08:21:10Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: AdminScopeService.getManageableStores · hidesPersonalData
    last_modified: 2026-10-16T06:10:00Z
  - id: query-dto
    resource: ../../src/staff-members/dto/staff-member-list.query.dto.ts
    title: 요청 — 쉼표 목록 필터(storeIds · joinState · employmentType)
    last_modified: 2026-10-12T07:48:54Z
  - id: design
    resource: ../../docs/plans/2026-10-12-staff-member-list-design.md
    title: 직원 목록 조회 API 설계 (WHALEERP-329)
    last_modified: 2026-10-13T04:05:39Z
---

# 직원 목록 (GET /staff-members)

관리자 웹 직원 정보 관리 목록을 한 번에 그린다(WHALEERP-329). 이 저장소의 첫 실제 도메인 목록 API 라 목록
규칙(`{ items, total }`, page · pageSize, 같은 `where` 의 `$transaction`, 고유값으로 끝나는 정렬)의 참고
구현이다. 쿼리 수는 페이지 크기와 상관없이 고정이다(관리 범위 2 · 트랜잭션 1 · 점포와 계약 동시 1, 왕복 4번) —
직원 페이지를 먼저 얻고, 그 직원 ID 로 점포 · 최근 계약을 따로 읽어 합친다. `stores` 는 3팀 모델과 Prisma 관계가
없어 `include` 할 수 없다.

`joinState` · `employmentType` · `storeIds` 는 쉼표 목록이다. 화면의 「가입·인증」 묶음(초대 발송 =
`INVITED,EXPIRED,REJECTED`)을 그대로 받아 하나라도 맞으면 낸다. 빈 값은 400 이라 「하나도 고르지 않음」은 api 로
표현되지 않는다 — 화면이 부르지 않고 0건으로 그린다. 파라미터를 빼면 전체가 나오므로 둘을 바꿔 쓰면 안 된다.

# 직원 상세 (GET /staff-members/:id)

직원 한 명을 목록 한 줄과 같은 모양(`StaffMemberListItemDto`)에 계정 이메일을 더해 낸다(WHALEERP-599 · 177). 관리자 웹 직원 상세와 퇴직
처리 화면이 재직 상태 · 퇴직일 · 가입 상태를 이것으로 그린다. 근무스케줄 · 급여 · TO-DO 를 담는 상세 요약
(WHALEERP-183)은 그 영역이 생긴 뒤의 일이다.

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

「상세는 목록보다 개인정보를 더 내지 않는다」(api #53)의 **예외는 이메일(회원 ID) 하나다**(WHALEERP-180, ACC-16 · 17).
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
`email-immutable.spec.ts` 에 더한다. 직원 근무 앱의 로그인 이메일 변경(템플릿 `EMAIL_CHANGE_PIN`, 아직 구현 전)은
본인 경로라 이 규칙 밖이다.

**목록에는 싣지 않는다** — 목록 화면은 쓰지 않고, 한 페이지에 최대 200명의 주소를 내보낼 이유가 없다. 그래서 계정은
상세 쿼리만 읽고(`DETAIL_SELECT`), 「상세 = 목록의 같은 줄」은 이 한 칸을 빼고 성립한다.

**가림은 점포 · 계약을 읽기 전에 정한다.** 직원 한 건을 읽은 직후 `hidesPersonalData` 로 판정해 끝낸다 — 응답
줄을 다 만든 뒤 `isMasked` 로 거르면 가려지는 직원의 404 만 점포 · 계약 조회 한 번만큼 늦어, 조회 권한이 있는
BM · BA 가 ID 를 차례로 불러 응답 시간으로 목록이 숨긴 「자기 BP 가맹 점포의 미동의 직원」 ID 를 모을 수 있다
(PR #53 리뷰). 없는 직원 · 범위 밖 · 가려지는 직원이 모두 같은 쿼리(직원 조회 하나) 뒤에 404 다. 응답 줄을 만든 뒤에도 `isMasked` 면 한 번 더 null 이다 — 지금은 두 판정이 같은 값이지만, 목록 쪽 가림 조건만
바뀌어도 상세가 가린 줄을 200 으로 내지 않게 하는 안전장치다.

# 조회 권한

목록과 상세는 직원 정보 관리(`MN000005`) 조회 권한을 본다 — `@MenuPermission('MN000005', 'read')` 를 컨트롤러에
붙였다(2026-10-15). 권한은 가드가 범위보다 먼저 보므로, 권한이 없으면 어떤 ID 든 같은 403 이라 응답으로 직원의
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

BP 마스터 · BP 관리자에게 가맹 점포 직원은 본사 제공 동의(`staff_members.is_hq_sharing_consented`, #137)를
하지 않았으면 가린 행이다(ATT-30). 동의한 직원은 직영 점포 직원처럼 다 보이고, 철회하면 칸이 false 라 다시
가려진다. 개인 칸으로 거르면(검색 · 고용형태 · 가입 상태) 가맹 점포에서는 동의한 직원만 남긴다 — 가린 행 하나가
검색에 걸리는 것만으로 그 사람이 있다는 것이 드러나기 때문이다. 그래서 점포 조건이
`storeId ∈ 가림 대상이 아닌 점포 OR (storeId ∈ 가림 대상 점포(직영 아님) AND 동의)` 가 된다. 동의는 직원마다라
한 가맹 점포 안에서도 동의한 직원만 남고, 고른 점포가 모두 가맹이면 첫 갈래는 빈 목록이다. 재직 상태는 화면 기본
필터라 예외로 두었다(드러나는 것은 점포별 퇴직자 수와 어느 가린 줄이 퇴직했는지).

가림은 관리 범위를 정할 때 읽은 점포 유형과 행의 동의 칸으로 판단하고 **직영이 아니면 동의하지 않은 직원을
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
형식이 틀린 값(빈 칸, 숫자 아님, 1..2147483647 밖, 500개 초과)은 DB 에 닿기 전에 400 이다.

# 재발송과 거부일

재발송 간격 제한은 없다(2026-10-12 재영). `invitation.canResend` 는 상태로만 정한다 — 초대 발송 · 초대 만료 ·
소속 추가 확인 · 복귀 확인. 이미 수락한 초대는 다시 보내지 않는다(받은 링크로 다시 들어온다, 2026-10-12 yjnoh).
거부일은 따로 저장하지 않아 화면이 `contract.updatedAt` 으로 「거부 · MM-DD」를 그린다. 갱신 예정은 화면이
`contract.endDate` 로 정한다.
