# 직원 목록 조회 API 설계

> 2026-10-13: 본사 제공 동의 칸 반영(`3ffa2d7`)으로 가림 규칙이 바뀌었다. 이 문서의 「동의 칸이 아직 없다」 · 가맹 점포를 `storeIds` 에서 빼는 설명은 옛 규칙이다 — 현재 규칙은 `okf/api/staff-members.md` 「본사 제공 동의 가림」.

- 날짜: 2026-10-12
- 브랜치: `jigglypuff` (worktree `petra`)
- 작업: WHALEERP-329 [API] 초대·가입 상태와 연결 보류 목록 조회
- 화면: `whale-erp-new-front/docs/demo/staff/index.html` (직원 정보 관리)
- 상태: 구현 완료(PR #13). 구현 중 바뀐 것은 이 문서에 고쳐 적었다 — 코드가 기준이다

## 목적

관리자 웹의 직원 정보 관리 목록을 API 하나로 그린다. 329 의 완료 조건(초대·가입 상태, 연결 보류,
소속 추가 확인 가림, 페이지)에 더해 목록 한 줄에 필요한 계약 상태 · 재직 상태와
필터를 함께 준다. 이 목록을 맡는 다른 API 작업이 없어서다.

## 정해진 것

| 항목 | 결정 |
|---|---|
| 범위 | 직원 목록 한 줄 전체(초대·가입 · 보류 · 계약 · 재직)와 필터 · 검색 · 페이지 |
| 이번 주 근무시간 | 넣지 않는다. 목록 화면에서 「이번 주」 칸을 뺐다(2026-10-12 yjnoh) |
| 연결 보류 목록 | 따로 두지 않는다. `joinState=LINK_HOLD` 필터가 「보류 건을 따로 모아 준다」를 대신한다 |
| 재발송 가능 여부 | `invitation.canResend`. 재발송 간격 제한은 없다(2026-10-12 재영) — 상태로만 정한다: 초대 발송 · 초대 만료 · 소속 추가 확인 · 복귀 확인이면 true. 가입 완료 · 초안은 보낼 초대가 없고, 연결 보류는 「연결 확인」에서, 만 19세 미만 · 직원이 거절한 건은 다시 보내지 않는다. 이미 수락한 초대도 다시 보내지 않는다 — 받은 링크로 다시 들어온다(2026-10-12 yjnoh) |
| 거부일 | 따로 저장하지 않는다. 화면은 `contract.updatedAt`(최종 수정 일시)으로 「거부 · MM-DD」를 그린다(2026-10-12 재영) |
| 본사 제공 동의 가림(ATT-30) | 동의 칸(`hq_sharing_consent`)이 아직 없으므로 동의 없음으로 본다. BP 마스터 · BP 관리자가 보는 가맹 점포 직원은 모두 가린다 |
| 구현 방식 | Prisma 조회 + 그 페이지 직원분만 따로 모아 TS 에서 합친다. 원시 SQL · DB 뷰는 쓰지 않는다 |
| 마이그레이션 | 없다. `staff_members` · `invitations` · `link_holds` · `contracts` 는 이미 있다 |

## API

`GET /staff-members` — 관리자 웹 전용(`@UserTypes('admin')`). 직원 앱 토큰(`typ: account`)은 403 이다.
직원은 관리자 페이지를 쓰지 않는다.

### 요청

| 파라미터 | 값 | 동작 |
|---|---|---|
| `page` · `pageSize` | 1부터(최대 1,000,000) · 기본 20, 최대 200 | 공통 목록 규칙(`okf/conventions/naming.md`) |
| `storeIds` | `3,5,8` | 범위 선택기(전체 · 직영 · 가맹 · 개별 점포)를 프론트가 점포 ID 로 풀어 보낸다. 관리 범위 밖 ID 는 조용히 뺀다 — 오류를 주면 다른 BP 에 그 점포가 있다는 것이 드러난다. 없으면 관리 범위 전체 |
| `keyword` | 문자열 | 이름 부분 일치, 또는 하이픈을 뺀 휴대전화번호 부분 일치. 앞뒤 공백을 지우고 비면 없는 것으로 본다 |
| `employmentType` | `FULL_TIME,PART_TIME` 중 고른 것, 쉼표 | 없으면 전체. 빈 값 · 모르는 값이 있으면 400 |
| `joinState` | `StaffJoinState` 값, 쉼표 | 화면의 「가입·인증」 묶음을 그대로 보낸다(초대 발송 = `INVITED,EXPIRED,REJECTED`). 하나라도 맞으면 나온다. 빈 값 · 모르는 값이 있으면 400 — 화면에서 하나도 고르지 않았으면 api 를 부르지 않고 0건으로 그린다 |
| `employmentStatus` | `EMPLOYED` · `RETIRED` | 없으면 전체 |

### 파생 가입 상태 `StaffJoinState`

API 전용 enum 이다(`src/enums/api-enums.ts` 에 한글과 함께 등록, `GET /enums` 로 나간다).
조건 칸은 서로 겹치지 않게 썼다 — 표의 순서는 화면 선택지 순서다. 우선순위는 `joinStateOf` 가 정한다:
가입 완료 > 연결 보류 > 발송 중 초대(4~6) > 만 19세 미만 > 수락(6 의 둘째 조건) > 거절 > 만료, 초대가 없으면 초안.

| 순서 | 값 | 한글 | 조건 |
|---|---|---|---|
| 1 | `JOINED` | 가입 완료 | `staff_members.join_status = JOINED` |
| 2 | `LINK_HOLD` | 연결 보류 | 그 직원의 초대에 처리되지 않은 보류(`link_holds.resolution IS NULL`)가 있다 |
| 3 | `UNDER_AGE` | 가입 불가(만 19세 미만) | `SENT` 초대가 없고 `REJECTED_UNDER_AGE` 초대가 있다. 발송 중 초대(4~6 의 `SENT` 조건)가 이기고, `ACCEPTED` 로 정해지는 `INVITED` 보다는 앞선다(2026-10-12 yjnoh) |
| 4 | `AFFILIATION_PENDING` | 소속 추가 확인 | `AFFILIATION_CONFIRM` 초대가 `SENT` |
| 5 | `RETURN_PENDING` | 복귀 확인 | `RETURN_CONFIRM` 초대가 `SENT` |
| 6 | `INVITED` | 초대 발송 | `SIGNUP` · `REINVITE` 초대가 `SENT`, 또는 `SENT` 초대가 없고 `ACCEPTED` 초대가 있다(재초대를 기다리는 중간 상태) |
| 7 | `REJECTED` | 거절 | `SENT` · `ACCEPTED` 초대가 없고 `REJECTED` 초대가 있다 |
| 8 | `EXPIRED` | 초대 만료 | `SENT` · `ACCEPTED` · `REJECTED` 초대가 없고 `EXPIRED` 초대가 있다 |
| 9 | `DRAFT` | 초안 | 초대가 한 번도 없다 |

한 직원에게 `SENT` 초대는 많아야 하나라고 본다(재발송 · 재초대는 이전 초대를 끝내고 새로 만든다 —
136 의 규칙). 「마지막 초대」는 Prisma 관계 조건으로 표현되지 않으므로 `SENT` 가 없을 때는 순서가 아니라 있고
없음으로 가른다(수락 > 거절 > 만료). 그래서 한 직원은 표시한 상태의 필터 하나에만 걸린다 — e2e 가 직원마다
확인한다(최종 검토 반영, 2026-10-12).

### 응답

`{ items, total }`. 정렬은 `staffMemberId` 내림차순(최근 등록 먼저) — 고유값이라 페이지가 흔들리지 않는다.

```ts
{
  staffMemberId: number,
  isMasked: boolean,               // BM · BA + 가맹 점포 → true (동의 칸이 생길 때까지)
  name: string | null,             // 가린 행이면 null — 아래 개인 칸 모두 같다
  phone: string | null,
  store: { storeId: number, name: string, storeType: 'DIRECT' | 'FRANCHISE' },  // 가린 행도 보인다
  employmentType: EmploymentType | null,
  joinState: StaffJoinState | null,
  invitation: { invitationType, status, lastSentAt, expiresAt, canResend } | null,   // 표시에 쓴 초대
  linkHold: { linkHoldId, mismatchReason, verifiedPhoneLast4, heldAt } | null,  // 미처리 보류
  contract: { contractId, status, signDeadlineAt, endDate, updatedAt } | null,  // 가장 최근 계약
  employmentStatus: EmploymentStatus | null,
  retiredDate: string | null              // YYYY-MM-DD
}
```

- **보류는 최소로만 준다.** 인증된 번호의 끝 4자리와 불일치 사유만. 가입자 실명 · 다른 소속은 담지 않는다(329).
  보류 계정의 전체 번호는 서버에서 잘라 내고 응답에 싣지 않는다.
- **화면이 계산하는 것.** 「갱신 예정 D-20」은 `contract.endDate` 로 화면이 정한다(30일, 갱신 예정 알림과 같은 기준),
  「거부 · 09-02」는 `contract.updatedAt` 으로,
  「서명 대기 · D-24」는 `signDeadlineAt` 으로, 「퇴직 예정 09-30」은 `employmentStatus = EMPLOYED` 와
  `retiredDate` 로 화면이 그린다.
- **같은 번호의 직원 레코드가 여럿이면 각각 나온다.** 목록은 계정이 아니라 직원 레코드 기준이다.

### 가림

요청한 관리자의 `admin_accounts.role_type_code` 가 `BM` · `BA` 이고 그 줄의 점포
`store_type_code` 가 `FRANCHISE` 면 `isMasked: true`, 개인 칸은 `null` 이다. 가맹마스터 · 가맹관리자
(`FM` · `FA`)와 직영 점포 직원은 가리지 않는다. 판단은 관리 범위를 정할 때 읽은 점포 유형으로 하고, 직영이
아니면(모르는 유형 포함) 가린다 — 개인정보 규칙은 판단이 틀릴 때 가리는 쪽이어야 한다. 가린 행도 `total` 에
센다(쟁점 STAFF-23). 가린 줄을 어떻게 그릴지는 화면이 정한다.

**가린 행은 필터로 드러나지 않게 한다.** BM · BA 가 `keyword` · `employmentType` · `joinState` 중 하나라도
주면 가맹 점포 직원은 결과에서 뺀다. `employmentStatus` 는 예외다 — 화면의 재직 상태 기본값이 「재직」이라 빼면
가린 행이 기본 화면에 한 번도 나오지 않는다. 드러나는 것은 점포별 퇴직자 수와, `staffMemberId` 로 어느 가린 줄이 퇴직했는지다(2026-10-12 yjnoh). 그러지 않으면 `keyword=홍길동` 에 가린 행
하나가 나오는 것만으로 그 가맹 점포에 홍길동이 있다는 것이 드러나고, 다른 필터도 가린 칸의 값을 건수로 알려
준다. 필터 없이 볼 때만 가린 행이 나오고, 그때 `total` 에 센다.

**동의 칸이 생기면(137) 두 곳에 「동의했으면 가리지 않는다」를 더한다** — 가림 판단과, 개인 칸으로 거를 때 가맹 점포를 빼는 `storeIds` 계산. 지금은 기록이 없으니
정책(「동의한 경우에만 보인다」)대로 모두 가린다.

### 오류

| 경우 | 응답 |
|---|---|
| 토큰 없음 · 만료 | 401 (전역 가드) |
| 직원 앱 토큰(`typ: account`) | 403 — 관리자 전용 API |
| 관리자 토큰이지만 계정이 없거나 사용 중이 아님 | 403 |
| 쿼리 형식 오류 — `pageSize` 200 초과, 모르는 `joinState`, `storeIds` 에 숫자가 아니거나 1..2147483647 밖인 값 | 400 |
| 관리 범위 밖 `storeIds` · 마지막 페이지를 넘긴 요청 | 200 `{ items: [], total }` |

## 구성

`src/staff-members/` 에 둔다(기존 퇴직 API 와 같은 모듈).

| 파일 | 하는 일 |
|---|---|
| `staff-members.controller.ts` | 쿼리 검증, 호출한 관리자 ID 를 서비스에 넘긴다. 로직 없음 |
| `staff-member-list.service.ts` | 조회와 조립 |
| `join-state.ts` | 파생 가입 상태 규칙 한 곳 — 상태 → Prisma `where` 조각, 조회된 행 → 상태. 필터와 표시가 어긋나지 않게 한 파일에 둔다. 순수 함수 |
| `dto/staff-member-list.query.dto.ts` · `dto/staff-member-list.response.dto.ts` | 요청 · 응답 클래스. Swagger 플러그인이 읽도록 `.dto.ts` 로 끝낸다. enum 칸에 `@ApiProperty({ enum, enumName })` |

`AdminScopeService` 에 `getManageableStores(adminAccountId)` 를 더한다 —
`{ roleTypeCode, stores: [{ storeId, storeTypeCode }] } | null`. 규칙은 `canManageStore` 와 같다:
사용 중인 계정, 같은 BP, 삭제되지 않은 점포, 전체 점포가 아니면 매핑된(삭제되지 않은) 점포만.
계정이 없거나 사용 중이 아니면 `null` 이고 컨트롤러가 403 을 준다.

## 한 요청의 흐름

쿼리 수는 페이지 크기와 상관없이 고정이다 — 관리 범위 2 · 트랜잭션 1 · 점포와 계약 동시 1, 왕복 4번.

1. 관리 가능한 점포와 역할을 얻는다. `storeIds` 가 있으면 교집합. 비면 쿼리 없이 `{ items: [], total: 0 }`.
2. `where` 를 만든다 — 점포 · `keyword` · `employmentType` · `employmentStatus` + `join-state` 의 조각.
3. `$transaction([findMany, count])` — 같은 `where`. `findMany` 는 초대(`sentAt` 순)와 미처리 보류
   (보류 계정의 `phone` 만 `select`)를 함께 가져온다.
4. 그 페이지 직원 ID 로 동시에 조회한다.
   - 점포 이름 · 유형 — `Store` 는 3팀 모델과 Prisma 관계가 없어 따로 읽는다.
   - 최근 계약 — `distinct: ['staffMemberId']`, `orderBy: [{ staffMemberId }, { createdAt: { sort: 'desc', nulls: 'last' } }, { contractId: 'desc' }]`. `created_at` 이 nullable 이라 `DESC` 기본(NULL 먼저)이면 오래된 계약이 「최근」이 될 수 있다.
5. 줄마다 파생 상태 · 끝 4자리 · 가림을 정해 응답으로 만든다.

## 테스트

API 코드는 테스트를 먼저 쓴다(CLAUDE.md). 빨간 단계는 실패 이유까지 읽고, 통과 수가 0 이 아닌지 본다.

- `join-state.spec.ts` — 9가지 상태의 우선순위. 가입 완료이면서 지난 보류가 있으면 `JOINED`, 만료된 초대
  뒤에 새 초대가 나가면 `INVITED`, 만료 뒤 거절이면 `REJECTED`. `where` 조각이 같은 경우를 고르는지.
- `admin-scope.service.spec.ts` — `getManageableStores`: 전체 점포, 매핑 점포, 다른 BP 로 넘어간 매핑 제외,
  삭제된 점포 · 매핑 제외, 미사용 계정 `null`.
- `staff-member-list.service.spec.ts` (Prisma mock) — 교집합이 비면 쿼리하지 않음, 가림(BM · BA × 가맹만),
  BA 역할, 개인 칸 필터(검색어 · 상태 · 고용형태) 때 가맹 점포 제외, 점포를 못 찾으면 오류, 끝 4자리만, 근무시간 칸 없음,
  재발송 가능 여부(상태별 · 수락한 초대는 불가), 쉼표 목록 필터, 계약 없음 `null`, 범위 밖 `storeIds` 무시.
- `test/staff-members.e2e-spec.ts` (일회용 DB) — 응답 모양, 401 · 403(직원 앱 토큰 · 미사용 관리자) · 400,
  `total` 과 페이지, 실제 관계 필터(연결 보류 · 소속 추가 확인 · 만료)가 Prisma 에서 맞게 도는지.
  관계 필터의 정확성은 mock 으로 증명되지 않는다.

## 마무리

- `pnpm openapi:export` 로 `openapi/openapi.json` 을 갱신해 커밋한다(front · staff 타입 생성).
- `StaffJoinState` 를 `src/enums/api-enums.ts` 에 등록한다.
- `okf` 에 직원 목록 개념을 더하고 `okf/log.md` 에 한 줄. 첫 실제 도메인 목록 API 라 `okf/index.md` ·
  `okf/conventions/naming.md` 의 「worked example 이 아직 없다」 자리에서 가리킨다.
- PR 본문에 남긴다: BM · BA × 가맹 전부 가림(동의 칸 없음, #137 전까지), 갱신 예정 기준 일수는 화면이 정한다.

## 범위 밖

- 재발송 · 재초대 · 연결 승인 동작 — 136 · 137 (mskim).
- 본사 제공 동의 저장 — 137.
- 플랫폼 관리자(PM · PA)의 고객 점포 조회 — 업무 범위 적용(WHALEERP-301) 이 정해질 때 `AdminScopeService` 에서 넓힌다.
- 일괄 저장(엑셀) — WHALEERP-336 · 337.
