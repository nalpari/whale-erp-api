---
type: API
title: Staff member list
description: GET /staff-members — the 관리자 웹 직원 목록 in one call (초대·가입 상태, 연결 보류, 최근 계약, 재직); the derived StaffJoinState, 본사 제공 동의 masking, and why out-of-scope stores are not an error.
tags: [staff, list, admin, masking, invitation]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-12T07:48:54Z }
sources:
  - id: staff-member-list-service
    resource: ../../src/staff-members/staff-member-list.service.ts
    title: StaffMemberListService (scope · where · page · assemble · mask)
    last_modified: 2026-10-12T07:48:54Z
  - id: join-state
    resource: ../../src/staff-members/join-state.ts
    title: StaffJoinState — display (joinStateOf) and filter (joinStateWhere)
    last_modified: 2026-10-12T07:48:54Z
  - id: staff-members-controller
    resource: ../../src/staff-members/staff-members.controller.ts
    title: GET /staff-members (admin only)
    last_modified: 2026-10-12T06:02:22Z
  - id: admin-scope
    resource: ../../src/admin-scope/admin-scope.service.ts
    title: AdminScopeService.getManageableStores
    last_modified: 2026-10-12T05:59:25Z
  - id: query-dto
    resource: ../../src/staff-members/dto/staff-member-list.query.dto.ts
    title: 요청 — 쉼표 목록 필터(storeIds · joinState · employmentType)
    last_modified: 2026-10-12T07:48:54Z
  - id: design
    resource: ../../docs/plans/2026-10-12-staff-member-list-design.md
    title: 직원 목록 조회 API 설계 (WHALEERP-329)
    last_modified: 2026-10-12T07:48:54Z
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

# 가입·인증 상태는 DB 칸이 아니다

`StaffJoinState` 는 직원 레코드 · 초대 · 연결 보류에서 만든 API 전용 enum 이다(`GET /enums` 로 나간다).
표시(`joinStateOf`)와 필터(`joinStateWhere`)는 `src/staff-members/join-state.ts` 한 파일에 있다 — 한쪽만
고치면 필터 결과에 다른 상태가 섞인다. 「한 직원에 발송 중 초대는 하나」라는 가정(136 의 재발송 규칙)에 기댄다.
「마지막 초대」는 관계 조건으로 표현되지 않으므로 발송 중 초대가 없을 때는 순서가 아니라 있고 없음으로 가른다
(수락 > 거절 > 만료). e2e 가 직원마다 「표시한 상태의 필터 하나에만 걸린다」를 실제 DB 로 확인한다 — 관계
조건의 정확성은 목으로 증명되지 않는다.

# 본사 제공 동의 가림

BP 마스터 · BP 관리자에게 가맹 점포 직원은 가린 행이다(ATT-30). 동의 칸이 아직 없어 지금은 모두 가린다. 개인
칸으로 거르면(검색 · 고용형태 · 가입 상태) 가맹 점포를 아예 뺀다 — 가린 행 하나가 검색에 걸리는 것만으로 그
사람이 있다는 것이 드러나기 때문이다. 재직 상태는 화면 기본 필터라 예외로 두었다(드러나는 것은 점포별 퇴직자 수와
어느 가린 줄이 퇴직했는지).

가림은 관리 범위를 정할 때 읽은 점포 유형으로 판단하고 **직영이 아니면 가린다** — 모르는 유형도 가린다. 개인정보
규칙이라 판단이 틀릴 때 가리는 쪽이어야 한다. 점포 정보를 못 찾은 줄은 빈 칸으로 내보내지 않고 500 이다. 동의
칸이 생기면(137) 가림 판단과, 개인 칸으로 거를 때 가맹 점포를 빼는 `storeIds` 계산 두 곳을 고친다.

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
