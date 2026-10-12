# 직원 목록 조회 API 설계

- 날짜: 2026-10-12
- 브랜치: `jigglypuff` (worktree `petra`)
- 작업: WHALEERP-329 [API] 초대·가입 상태와 연결 보류 목록 조회
- 화면: `whale-erp-new-front/docs/demo/staff/index.html` (직원 정보 관리)
- 상태: 설계 확정, 구현 계획 전

## 목적

관리자 웹의 직원 정보 관리 목록을 API 하나로 그린다. 329 의 완료 조건(초대·가입 상태, 연결 보류,
소속 추가 확인 가림, 페이지)에 더해 목록 한 줄에 필요한 계약 상태 · 이번 주 근무시간 · 재직 상태와
필터를 함께 준다. 이 목록을 맡는 다른 API 작업이 없어서다.

## 정해진 것

| 항목 | 결정 |
|---|---|
| 범위 | 직원 목록 한 줄 전체(초대·가입 · 보류 · 계약 · 이번 주 근무시간 · 재직)와 필터 · 검색 · 페이지 |
| 연결 보류 목록 | 따로 두지 않는다. `joinState=LINK_HOLD` 필터가 「보류 건을 따로 모아 준다」를 대신한다 |
| 재발송 가능 여부 | 넣지 않는다. 「마지막 발송 뒤 정해진 간격」의 값이 정해지지 않았다. 대신 `invitation.lastSentAt` 을 준다 |
| 본사 제공 동의 가림(ATT-30) | 동의 칸(`hq_sharing_consent`)이 아직 없으므로 동의 없음으로 본다. BP 마스터 · BP 관리자가 보는 가맹 점포 직원은 모두 가린다 |
| 구현 방식 | Prisma 조회 + 그 페이지 직원분만 따로 모아 TS 에서 합친다. 원시 SQL · DB 뷰는 쓰지 않는다 |
| 마이그레이션 | 없다. `staff_members` · `invitations` · `link_holds` · `contracts` · `work_schedules` 는 이미 있다 |

## API

`GET /staff-members` — 관리자 웹 전용(`@UserTypes('admin')`). 직원 앱 토큰(`typ: account`)은 403 이다.
직원은 관리자 페이지를 쓰지 않는다.

### 요청

| 파라미터 | 값 | 동작 |
|---|---|---|
| `page` · `pageSize` | 1부터(최대 1,000,000) · 기본 20, 최대 200 | 공통 목록 규칙(`okf/conventions/naming.md`) |
| `storeIds` | `3,5,8` | 범위 선택기(전체 · 직영 · 가맹 · 개별 점포)를 프론트가 점포 ID 로 풀어 보낸다. 관리 범위 밖 ID 는 조용히 뺀다 — 오류를 주면 다른 BP 에 그 점포가 있다는 것이 드러난다. 없으면 관리 범위 전체 |
| `keyword` | 문자열 | 이름 부분 일치, 또는 하이픈을 뺀 휴대전화번호 부분 일치. 앞뒤 공백을 지우고 비면 없는 것으로 본다 |
| `employmentType` | `FULL_TIME` · `PART_TIME` | |
| `joinState` | `StaffJoinState` 값 하나 | 화면의 「가입·인증」 필터 |
| `employmentStatus` | `EMPLOYED` · `RETIRED` | 없으면 전체 |

### 파생 가입 상태 `StaffJoinState`

API 전용 enum 이다(`src/enums/api-enums.ts` 에 한글과 함께 등록, `GET /enums` 로 나간다).
위에서부터 처음 맞는 것을 쓴다.

| 순서 | 값 | 한글 | 조건 |
|---|---|---|---|
| 1 | `JOINED` | 가입 완료 | `staff_members.join_status = JOINED` |
| 2 | `LINK_HOLD` | 연결 보류 | 그 직원의 초대에 처리되지 않은 보류(`link_holds.resolution IS NULL`)가 있다 |
| 3 | `UNDER_AGE` | 가입 불가(만 19세 미만) | `SENT` 초대가 없고 `REJECTED_UNDER_AGE` 초대가 있다. 다시 보낸 초대가 발송 중이면 그 초대가 이긴다(2026-10-12 yjnoh) — 우선순위는 4~6 다음이다 |
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
  invitation: { invitationType, status, lastSentAt, expiresAt } | null,   // 표시에 쓴 초대
  linkHold: { linkHoldId, mismatchReason, verifiedPhoneLast4, heldAt } | null,  // 미처리 보류
  contract: { contractId, status, signDeadlineAt, endDate } | null,       // 가장 최근 계약
  weeklyScheduledMinutes: number | null,  // 이번 주(KST 월 0시 ~ 다음 월 0시) 근무스케줄 합계, 휴게 뺌
  employmentStatus: EmploymentStatus | null,
  retiredDate: string | null              // YYYY-MM-DD
}
```

- **보류는 최소로만 준다.** 인증된 번호의 끝 4자리와 불일치 사유만. 가입자 실명 · 다른 소속은 담지 않는다(329).
  보류 계정의 전체 번호는 서버에서 잘라 내고 응답에 싣지 않는다.
- **화면이 계산하는 것.** 「갱신 예정 D-20」은 갱신 기준 일수가 정해지지 않아 `contract.endDate` 만 주고,
  「서명 대기 · D-24」는 `signDeadlineAt` 으로, 「퇴직 예정 09-30」은 `employmentStatus = EMPLOYED` 와
  `retiredDate` 로 화면이 그린다.
- **같은 번호의 직원 레코드가 여럿이면 각각 나온다.** 목록은 계정이 아니라 직원 레코드 기준이다.

### 가림

요청한 관리자의 `admin_accounts.role_type_code` 가 `BM` · `BA` 이고 그 줄의 점포
`store_type_code` 가 `FRANCHISE` 면 `isMasked: true`, 개인 칸은 `null` 이다. 가맹마스터 · 가맹관리자
(`FM` · `FA`)와 직영 점포 직원은 가리지 않는다. 가린 행도 `total` 에 센다(쟁점 STAFF-23). 화면은 이름
자리에 「본사 제공 동의 없음 · 가맹 점포 직원」, 나머지 칸에 「—」를 그린다.

**가린 행은 필터로 드러나지 않게 한다.** BM · BA 가 `keyword` · `employmentType` · `joinState` 중 하나라도
주면 가맹 점포 직원은 결과에서 뺀다. `employmentStatus` 는 예외다 — 화면의 재직 상태 기본값이 「재직」이라 빼면
가린 행이 기본 화면에 한 번도 나오지 않는다. 드러나는 것은 점포별 퇴직자 수뿐이다(2026-10-12 yjnoh). 그러지 않으면 `keyword=홍길동` 에 가린 행
하나가 나오는 것만으로 그 가맹 점포에 홍길동이 있다는 것이 드러나고, 다른 필터도 가린 칸의 값을 건수로 알려
준다. 필터 없이 볼 때만 가린 행이 나오고, 그때 `total` 에 센다.

**동의 칸이 생기면(137) 이 판단 한 곳에 「동의했으면 가리지 않는다」를 더한다.** 지금은 기록이 없으니
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
| `kst-date.ts` (기존) | 이번 주 KST 경계 함수를 더한다 |
| `dto/staff-member-list.query.dto.ts` · `dto/staff-member-list.response.dto.ts` | 요청 · 응답 클래스. Swagger 플러그인이 읽도록 `.dto.ts` 로 끝낸다. enum 칸에 `@ApiProperty({ enum, enumName })` |

`AdminScopeService` 에 `getManageableStores(adminAccountId)` 를 더한다 —
`{ roleTypeCode, stores: [{ storeId, storeTypeCode }] } | null`. 규칙은 `canManageStore` 와 같다:
사용 중인 계정, 같은 BP, 삭제되지 않은 점포, 전체 점포가 아니면 매핑된(삭제되지 않은) 점포만.
계정이 없거나 사용 중이 아니면 `null` 이고 컨트롤러가 403 을 준다.

## 한 요청의 흐름

쿼리는 고정 5~6번이다. 페이지 크기와 상관없다.

1. 관리 가능한 점포와 역할을 얻는다. `storeIds` 가 있으면 교집합. 비면 쿼리 없이 `{ items: [], total: 0 }`.
2. `where` 를 만든다 — 점포 · `keyword` · `employmentType` · `employmentStatus` + `join-state` 의 조각.
3. `$transaction([findMany, count])` — 같은 `where`. `findMany` 는 초대(`sentAt` 순)와 미처리 보류
   (보류 계정의 `phone` 만 `select`)를 함께 가져온다.
4. 그 페이지 직원 ID 로 동시에 조회한다.
   - 점포 이름 · 유형 — `Store` 는 3팀 모델과 Prisma 관계가 없어 따로 읽는다.
   - 최근 계약 — `distinct: ['staffMemberId']`, `orderBy: [{ staffMemberId }, { createdAt: 'desc' }, { contractId: 'desc' }]`.
   - 이번 주 근무스케줄 — `is_deleted = false`, `startAt` 이 이번 주 안. `groupBy` 는 시각 차이를 못
     더하므로 `findMany` 후 TS 에서 `(endAt - startAt)분 - breakMinutes` 를 더한다.
5. 줄마다 파생 상태 · 끝 4자리 · 가림을 정해 응답으로 만든다.

## 테스트

API 코드는 테스트를 먼저 쓴다(CLAUDE.md). 빨간 단계는 실패 이유까지 읽고, 통과 수가 0 이 아닌지 본다.

- `join-state.spec.ts` — 9가지 상태의 우선순위. 가입 완료이면서 지난 보류가 있으면 `JOINED`, 만료된 초대
  뒤에 새 초대가 나가면 `INVITED`, 만료 뒤 거절이면 `REJECTED`. `where` 조각이 같은 경우를 고르는지.
- `kst-date.spec.ts` — 이번 주 경계: 일요일 23:59 KST, 월요일 0시 KST, UTC 날짜가 하루 앞서는 시각.
- `admin-scope.service.spec.ts` — `getManageableStores`: 전체 점포, 매핑 점포, 다른 BP 로 넘어간 매핑 제외,
  삭제된 점포 · 매핑 제외, 미사용 계정 `null`.
- `staff-member-list.service.spec.ts` (Prisma mock) — 교집합이 비면 쿼리하지 않음, 가림(BM · BA × 가맹만),
  끝 4자리만, 휴게 · 삭제분 뺀 근무시간, 계약 없음 `null`, 범위 밖 `storeIds` 무시.
- `test/staff-members.e2e-spec.ts` (일회용 DB) — 응답 모양, 401 · 403(직원 앱 토큰 · 미사용 관리자) · 400,
  `total` 과 페이지, 실제 관계 필터(연결 보류 · 소속 추가 확인 · 만료)가 Prisma 에서 맞게 도는지.
  관계 필터의 정확성은 mock 으로 증명되지 않는다.

## 마무리

- `pnpm openapi:export` 로 `openapi/openapi.json` 을 갱신해 커밋한다(front · staff 타입 생성).
- `StaffJoinState` 를 `src/enums/api-enums.ts` 에 등록한다.
- `okf` 에 직원 목록 개념을 더하고 `okf/log.md` 에 한 줄. 첫 실제 도메인 목록 API 라 `okf/index.md` ·
  `okf/conventions/naming.md` 의 「worked example 이 아직 없다」 자리에서 가리킨다.
- PR 본문과 Plane 329 댓글에 남긴다: 재발송 가능 여부 제외(간격 미정), BM · BA × 가맹 전부 가림(동의 칸 없음),
  갱신 예정 기준 일수 미정이라 `endDate` 만.

## 범위 밖

- 재발송 · 재초대 · 연결 승인 동작 — 136 · 137 (mskim).
- 본사 제공 동의 저장 — 137.
- 플랫폼 관리자(PM · PA)의 고객 점포 조회 — 업무 범위 적용(WHALEERP-301) 이 정해질 때 `AdminScopeService` 에서 넓힌다.
- 일괄 저장(엑셀) — WHALEERP-336 · 337.
