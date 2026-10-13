# 직원 목록 조회 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자 웹 직원 정보 관리 목록을 `GET /staff-members` 하나로 그리게 한다 (WHALEERP-329).

**Architecture:** `staff-members` 모듈에 컨트롤러 · 목록 서비스를 더한다. 파생 가입 상태 규칙은 순수 함수
파일(`join-state.ts`) 한 곳에, 관리 범위는 `AdminScopeService.getManageableStores` 에 둔다. 서비스는
Prisma `findMany` + `count` 로 한 페이지를 얻고, 그 페이지 직원 ID 로 점포 · 최근 계약 · 이번 주 근무스케줄을
따로 읽어 TS 에서 합친다.

**Tech Stack:** NestJS 11, Prisma 7 (PostgreSQL), class-validator / class-transformer, Jest (ts-jest), supertest.

**Spec:** `docs/plans/2026-10-12-staff-member-list-design.md`

**작업 위치:** worktree `~/.whale-erp-worktrees/whale-erp-api/petra`, 브랜치 `jigglypuff`. 모든 명령은 이 디렉터리에서 돈다.

## Global Constraints

- 목록 응답은 `{ items, total }`, `page` 1부터, `pageSize` 기본 20 · 최대 200. `findMany` 와 `count` 는 같은 `where` 로 `$transaction`.
- 정렬은 `staffMemberId` 내림차순.
- 관리자 웹 전용 `@UserTypes('admin')`. 직원 앱 토큰은 403, 사용 중이 아닌 관리자도 403.
- id 범위 `1..2147483647` 밖의 값은 DB 에 닿기 전에 막는다(400).
- 응답 · 요청 클래스 파일은 `.dto.ts` 로 끝낸다(Swagger 플러그인). enum 칸은 `@ApiProperty({ enum, enumName })`.
- 가림: 관리자 `roleTypeCode` 가 `BM` · `BA` 이고 점포 `storeTypeCode` 가 `FRANCHISE` 면 `isMasked: true`, 개인 칸 `null`. 그 관리자가 `keyword` · `employmentType` · `joinState` · `employmentStatus` 중 하나라도 주면 가맹 점포 직원은 결과에서 뺀다.
- 보류는 인증 번호 끝 4자리와 불일치 사유만. 전체 번호 · 실명 · 다른 소속은 응답에 없다.
- 이번 주 = 한국 시간 월요일 0시 ~ 다음 월요일 0시. `work_schedules.is_deleted = false` 만, 휴게 분을 뺀다.
- 날짜만 있는 값(`endDate` · `retiredDate`)은 `YYYY-MM-DD` 문자열로 낸다.
- 마이그레이션을 만들지 않는다. `pnpm db:migrate` 를 쓰지 않는다.
- 테스트를 먼저 쓴다. 빨간 단계는 실패 이유를 읽고, 결과의 passed/failed 수가 0 이 아닌지 본다. `pnpm test <파일> -t "<제목>"` 처럼 `--` 없이 넘긴다.
- 커밋 메시지는 영어 type 접두 + 한글 제목, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **가린 행이 검색으로 드러남** — BM · BA 가 `keyword` 로 가맹 직원 이름을 검색해도 가린 행이 나오지 않아야 한다. → Task 4 「필터가 있으면 BM · BA 에게 가맹 점포를 뺀다」, Task 5 e2e 「검색으로 가린 행을 찾을 수 없다」.
- **`storeIds` 에 이상한 값** — `abc`, 빈 칸(`3,,5`), `0`, `2147483648` 은 500 이 아니라 400 이어야 한다. → Task 5 e2e 「쿼리 형식 오류는 400」.
- **이번 주 경계가 UTC 로 계산됨** — 월요일 오전 8시(KST, UTC 로는 일요일)에 지난주가 아니라 이번 주를 봐야 한다. → Task 2 「UTC 로는 일요일인 월요일 오전」.
- **계약 `createdAt` 이 비어 있는 행** — `created_at` 이 nullable 이라 `DESC` 에서 NULL 이 먼저 와 오래된 계약이 「최근」이 될 수 있다. `nulls: 'last'` 로 막는다. → Task 4 「최근 계약 정렬은 NULL 을 뒤로」.
- **초대가 수락됐는데 가입 완료가 아님** — 데이터상 드문 중간 상태라도 500 이나 엉뚱한 상태가 아니라 정해진 값(`INVITED`)이어야 한다. → Task 1 「수락됐는데 가입 완료가 아니면 INVITED」.

---

### Task 1: 파생 가입 상태 규칙 (`join-state.ts`) + enum 등록

**Files:**
- Create: `src/staff-members/join-state.ts`
- Create: `src/staff-members/join-state.spec.ts`
- Modify: `src/enums/api-enums.ts`

**Interfaces:**
- Produces:
  - `type StaffJoinState = 'JOINED' | 'LINK_HOLD' | 'UNDER_AGE' | 'AFFILIATION_PENDING' | 'RETURN_PENDING' | 'INVITED' | 'EXPIRED' | 'REJECTED' | 'DRAFT'`
  - `const STAFF_JOIN_STATES: readonly StaffJoinState[]`
  - `const STAFF_JOIN_STATE_LABELS: Record<StaffJoinState, string>`
  - `interface JoinStateInvitation { invitationId: number; invitationType: InvitationType; status: InvitationStatus; sentAt: Date; linkHolds: ReadonlyArray<unknown> }` — `linkHolds` 는 **미처리 보류만** 담긴 배열
  - `function displayInvitation<T extends JoinStateInvitation>(invitations: readonly T[]): T | null`
  - `function joinStateOf(joinStatus: StaffMemberJoinStatus, invitations: readonly JoinStateInvitation[]): StaffJoinState`
  - `function joinStateWhere(state: StaffJoinState): Prisma.StaffMemberWhereInput`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/staff-members/join-state.spec.ts`:

```ts
import {
  displayInvitation,
  joinStateOf,
  joinStateWhere,
  JoinStateInvitation,
  STAFF_JOIN_STATES,
} from './join-state';

const inv = (
  over: Partial<JoinStateInvitation> & { invitationId: number },
): JoinStateInvitation => ({
  invitationType: 'SIGNUP',
  status: 'SENT',
  sentAt: new Date('2026-10-01T00:00:00Z'),
  linkHolds: [],
  ...over,
});

describe('joinStateOf', () => {
  it('가입 완료면 지난 보류가 남아 있어도 JOINED', () => {
    expect(
      joinStateOf('JOINED', [inv({ invitationId: 1, linkHolds: [{}] })]),
    ).toBe('JOINED');
  });

  it('미처리 보류가 있으면 LINK_HOLD', () => {
    expect(
      joinStateOf('INVITED', [
        inv({ invitationId: 1, status: 'ACCEPTED', linkHolds: [{}] }),
      ]),
    ).toBe('LINK_HOLD');
  });

  it('만 19세 미만으로 막혔으면 UNDER_AGE', () => {
    expect(
      joinStateOf('INVITED', [
        inv({ invitationId: 1, status: 'REJECTED_UNDER_AGE' }),
      ]),
    ).toBe('UNDER_AGE');
  });

  it.each([
    ['AFFILIATION_CONFIRM', 'AFFILIATION_PENDING'],
    ['RETURN_CONFIRM', 'RETURN_PENDING'],
    ['SIGNUP', 'INVITED'],
    ['REINVITE', 'INVITED'],
  ] as const)('%s 초대가 발송 중이면 %s', (invitationType, expected) => {
    expect(
      joinStateOf('INVITED', [inv({ invitationId: 1, invitationType })]),
    ).toBe(expected);
  });

  it('만료된 초대 뒤에 새 초대가 나가면 INVITED', () => {
    expect(
      joinStateOf('INVITED', [
        inv({ invitationId: 1, status: 'EXPIRED' }),
        inv({
          invitationId: 2,
          invitationType: 'REINVITE',
          sentAt: new Date('2026-10-05T00:00:00Z'),
        }),
      ]),
    ).toBe('INVITED');
  });

  it('살아 있는 초대가 없으면 마지막 초대의 상태 — 만료 뒤 거절이면 REJECTED', () => {
    expect(
      joinStateOf('INVITED', [
        inv({ invitationId: 1, status: 'EXPIRED' }),
        inv({
          invitationId: 2,
          invitationType: 'AFFILIATION_CONFIRM',
          status: 'REJECTED',
          sentAt: new Date('2026-10-05T00:00:00Z'),
        }),
      ]),
    ).toBe('REJECTED');
  });

  it('마지막 초대가 만료면 EXPIRED', () => {
    expect(
      joinStateOf('INVITED', [inv({ invitationId: 1, status: 'EXPIRED' })]),
    ).toBe('EXPIRED');
  });

  it('초대가 한 번도 없으면 DRAFT', () => {
    expect(joinStateOf('DRAFT', [])).toBe('DRAFT');
  });

  it('수락됐는데 가입 완료가 아니면 INVITED — 중간 상태도 정해진 값이다', () => {
    expect(
      joinStateOf('INVITED', [inv({ invitationId: 1, status: 'ACCEPTED' })]),
    ).toBe('INVITED');
  });
});

describe('displayInvitation', () => {
  it('발송 중인 초대가 있으면 그것', () => {
    const sent = inv({ invitationId: 1 });
    const later = inv({
      invitationId: 2,
      status: 'EXPIRED',
      sentAt: new Date('2026-10-09T00:00:00Z'),
    });
    expect(displayInvitation([sent, later])).toBe(sent);
  });

  it('없으면 가장 늦게 보낸 것, 같은 시각이면 id 가 큰 것', () => {
    const a = inv({ invitationId: 1, status: 'EXPIRED' });
    const b = inv({ invitationId: 2, status: 'EXPIRED' });
    expect(displayInvitation([a, b])).toBe(b);
  });

  it('초대가 없으면 null', () => {
    expect(displayInvitation([])).toBeNull();
  });
});

describe('joinStateWhere', () => {
  it('상태마다 조건을 낸다', () => {
    for (const state of STAFF_JOIN_STATES) {
      expect(joinStateWhere(state)).toBeDefined();
    }
  });

  it('JOINED 가 아닌 상태는 모두 가입 완료를 뺀다', () => {
    for (const state of STAFF_JOIN_STATES.filter((s) => s !== 'JOINED')) {
      expect(JSON.stringify(joinStateWhere(state))).toContain(
        '"joinStatus":{"not":"JOINED"}',
      );
    }
  });
});
```

- [ ] **Step 2: 실패하는지 본다**

Run: `pnpm test join-state`
Expected: FAIL — `Cannot find module './join-state'`

- [ ] **Step 3: 구현한다**

`src/staff-members/join-state.ts`:

```ts
import {
  InvitationStatus,
  InvitationType,
  Prisma,
  StaffMemberJoinStatus,
} from '@prisma/client';

/**
 * 직원 목록의 「가입·인증」 상태. DB 칸이 아니라 직원 레코드 · 초대 · 연결 보류에서 만든다(API 전용 enum).
 * 순서가 곧 우선순위이고 화면 선택지 순서다. 표시(joinStateOf)와 필터(joinStateWhere)가 같은 규칙을 따르도록
 * 두 함수를 이 파일에 함께 둔다 — 한쪽만 고치면 필터한 결과에 다른 상태가 섞여 나온다.
 */
export const STAFF_JOIN_STATE_LABELS = {
  JOINED: '가입 완료',
  LINK_HOLD: '연결 보류',
  UNDER_AGE: '가입 불가(만 19세 미만)',
  AFFILIATION_PENDING: '소속 추가 확인',
  RETURN_PENDING: '복귀 확인',
  INVITED: '초대 발송',
  EXPIRED: '초대 만료',
  REJECTED: '거절',
  DRAFT: '초안',
} as const;

export type StaffJoinState = keyof typeof STAFF_JOIN_STATE_LABELS;

export const STAFF_JOIN_STATES = Object.keys(
  STAFF_JOIN_STATE_LABELS,
) as readonly StaffJoinState[];

export interface JoinStateInvitation {
  invitationId: number;
  invitationType: InvitationType;
  status: InvitationStatus;
  sentAt: Date;
  /** 미처리 보류(resolution 이 빈 것)만 담는다. */
  linkHolds: ReadonlyArray<unknown>;
}

const SENT_STATE: Record<InvitationType, StaffJoinState> = {
  SIGNUP: 'INVITED',
  REINVITE: 'INVITED',
  AFFILIATION_CONFIRM: 'AFFILIATION_PENDING',
  RETURN_CONFIRM: 'RETURN_PENDING',
};

/**
 * 목록에 보일 초대. 발송 중(SENT)인 초대가 있으면 그것 — 한 직원에 많아야 하나라고 본다(재발송 · 재초대는 이전
 * 초대를 끝내고 새로 만든다, WHALEERP-136). 없으면 가장 늦게 보낸 것, 같은 시각이면 id 가 큰 것.
 */
export function displayInvitation<T extends JoinStateInvitation>(
  invitations: readonly T[],
): T | null {
  const sent = invitations.find((i) => i.status === 'SENT');
  if (sent) return sent;
  let latest: T | null = null;
  for (const i of invitations) {
    if (
      !latest ||
      i.sentAt.getTime() > latest.sentAt.getTime() ||
      (i.sentAt.getTime() === latest.sentAt.getTime() &&
        i.invitationId > latest.invitationId)
    )
      latest = i;
  }
  return latest;
}

export function joinStateOf(
  joinStatus: StaffMemberJoinStatus,
  invitations: readonly JoinStateInvitation[],
): StaffJoinState {
  if (joinStatus === 'JOINED') return 'JOINED';
  if (invitations.some((i) => i.linkHolds.length > 0)) return 'LINK_HOLD';
  if (invitations.some((i) => i.status === 'REJECTED_UNDER_AGE'))
    return 'UNDER_AGE';
  const shown = displayInvitation(invitations);
  if (!shown) return 'DRAFT';
  if (shown.status === 'SENT') return SENT_STATE[shown.invitationType];
  if (shown.status === 'EXPIRED') return 'EXPIRED';
  if (shown.status === 'REJECTED') return 'REJECTED';
  // ACCEPTED 인데 가입 완료가 아니다 — 수락이 가입 완료나 보류로 이어지지 않은 중간 상태. 정상 흐름에는 없지만
  // 화면이 비지 않도록 초대 발송으로 둔다. 필터(INVITED)에는 걸리지 않는다.
  return 'INVITED';
}

const notJoined: Prisma.StaffMemberWhereInput = {
  joinStatus: { not: 'JOINED' },
};
const openHold: Prisma.StaffMemberWhereInput = {
  invitations: { some: { linkHolds: { some: { resolution: null } } } },
};
const underAge: Prisma.StaffMemberWhereInput = {
  invitations: { some: { status: 'REJECTED_UNDER_AGE' } },
};
const anySent: Prisma.StaffMemberWhereInput = {
  invitations: { some: { status: 'SENT' } },
};
const sentOf = (types: InvitationType[]): Prisma.StaffMemberWhereInput => ({
  invitations: { some: { status: 'SENT', invitationType: { in: types } } },
});
const someStatus = (
  status: InvitationStatus,
): Prisma.StaffMemberWhereInput => ({
  invitations: { some: { status } },
});

/**
 * 상태 필터. joinStateOf 의 우선순위를 NOT 으로 옮긴다. EXPIRED · REJECTED 의 「마지막 초대」는 관계 조건으로
 * 표현되지 않아 「발송 중인 초대 없음 + 그 상태의 초대 있음」으로 거른다 — 만료와 거절 초대를 둘 다 가진 직원은
 * 두 필터에 모두 걸리고, 표시는 마지막 것 하나다.
 */
export function joinStateWhere(
  state: StaffJoinState,
): Prisma.StaffMemberWhereInput {
  switch (state) {
    case 'JOINED':
      return { joinStatus: 'JOINED' };
    case 'LINK_HOLD':
      return { AND: [notJoined, openHold] };
    case 'UNDER_AGE':
      return { AND: [notJoined, underAge], NOT: [openHold] };
    case 'AFFILIATION_PENDING':
      return {
        AND: [notJoined, sentOf(['AFFILIATION_CONFIRM'])],
        NOT: [openHold, underAge],
      };
    case 'RETURN_PENDING':
      return {
        AND: [notJoined, sentOf(['RETURN_CONFIRM'])],
        NOT: [openHold, underAge],
      };
    case 'INVITED':
      return {
        AND: [notJoined, sentOf(['SIGNUP', 'REINVITE'])],
        NOT: [openHold, underAge],
      };
    case 'EXPIRED':
      return {
        AND: [notJoined, someStatus('EXPIRED')],
        NOT: [openHold, underAge, anySent],
      };
    case 'REJECTED':
      return {
        AND: [notJoined, someStatus('REJECTED')],
        NOT: [openHold, underAge, anySent],
      };
    case 'DRAFT':
      return { AND: [notJoined, { invitations: { none: {} } }] };
  }
}
```

`src/enums/api-enums.ts` — 끝의 `export const API_ENUMS: EnumSource = {};` 와 바로 위 주석 한 줄(「지금은 없다 — …」)을 바꾼다:

```ts
import type { EnumSource } from './enums.service';
import { STAFF_JOIN_STATE_LABELS } from '../staff-members/join-state';

/**
 * DB 에 없는 API 전용 enum 의 한글. DB enum 은 db-enums.generated.ts(물리 ERD 원본에서 생성)에 있고,
 * 같은 이름을 여기 두면 EnumsService 가 띄울 때 막는다.
 *
 * 값은 코드에 이미 있는 상수에서 가져온다. 값 목록을 여기 따로 적으면 둘이 어긋난다.
 */
export const API_ENUMS: EnumSource = {
  /** 직원 목록의 가입·인증 상태 (WHALEERP-329) */
  StaffJoinState: Object.entries(STAFF_JOIN_STATE_LABELS),
};
```

- [ ] **Step 4: 통과하는지 본다**

Run: `pnpm test join-state` 그리고 `pnpm test enums`
Expected: 둘 다 PASS, passed 수가 0 이 아니다. `enums` 가 「이름이 겹친다」로 실패하면 DB enum 에 `StaffJoinState` 가 있다는 뜻이니 멈추고 보고한다.

- [ ] **Step 5: 커밋한다**

```bash
pnpm lint
git add src/staff-members/join-state.ts src/staff-members/join-state.spec.ts src/enums/api-enums.ts
git commit -m "feat: 직원 목록 가입·인증 상태 파생 규칙 (WHALEERP-329)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 한국 시간 이번 주 경계 (`kstWeekRange`)

**Files:**
- Modify: `src/staff-members/kst-date.ts` (끝에 함수 추가)
- Modify: `src/staff-members/kst-date.spec.ts` (끝에 describe 추가)

**Interfaces:**
- Produces: `function kstWeekRange(now?: Date): { start: Date; end: Date }` — `start` 는 이번 주 월요일 한국 0시, `end` 는 다음 월요일 한국 0시(시각 칸과 `gte start, lt end` 로 견준다)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/staff-members/kst-date.spec.ts` 끝에 더한다(파일 위 import 에 `kstWeekRange` 를 더한다):

```ts
describe('kstWeekRange', () => {
  // 2026-10-12 는 월요일이다. 한국 0시는 UTC 전날 15시.
  const MON_KST_START = new Date('2026-10-11T15:00:00Z');
  const NEXT_MON_KST_START = new Date('2026-10-18T15:00:00Z');

  it('월요일 한국 0시면 그 주', () => {
    expect(kstWeekRange(new Date('2026-10-11T15:00:00Z'))).toEqual({
      start: MON_KST_START,
      end: NEXT_MON_KST_START,
    });
  });

  it('UTC 로는 일요일인 월요일 오전(한국 8시)도 이번 주', () => {
    expect(kstWeekRange(new Date('2026-10-11T23:00:00Z'))).toEqual({
      start: MON_KST_START,
      end: NEXT_MON_KST_START,
    });
  });

  it('일요일 한국 23시 59분은 지난 월요일부터', () => {
    expect(kstWeekRange(new Date('2026-10-11T14:59:00Z'))).toEqual({
      start: new Date('2026-10-04T15:00:00Z'),
      end: MON_KST_START,
    });
  });
});
```

- [ ] **Step 2: 실패하는지 본다**

Run: `pnpm test kst-date -t "kstWeekRange"`
Expected: FAIL — `kstWeekRange is not a function` (또는 import 오류). `Tests: N skipped` 만 나오면 제목이 틀린 것이니 고친다.

- [ ] **Step 3: 구현한다**

`src/staff-members/kst-date.ts` 끝에 더한다:

```ts
/** 한국 시간 이번 주 — 월요일 0시부터 다음 월요일 0시 앞까지. 시각 칸과 `gte start, lt end` 로 견준다. */
export function kstWeekRange(now: Date = new Date()): {
  start: Date;
  end: Date;
} {
  const today = kstToday(now);
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  const monday = addDays(today, -sinceMonday);
  return {
    start: kstDayStart(monday),
    end: kstDayStart(addDays(monday, 7)),
  };
}
```

- [ ] **Step 4: 통과하는지 본다**

Run: `pnpm test kst-date`
Expected: PASS, 새 3건 포함.

- [ ] **Step 5: 커밋한다**

```bash
pnpm lint
git add src/staff-members/kst-date.ts src/staff-members/kst-date.spec.ts
git commit -m "feat: 한국 시간 이번 주 경계 함수 (WHALEERP-329)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 관리 가능한 점포 목록 (`AdminScopeService.getManageableStores`)

**Files:**
- Modify: `src/admin-scope/admin-scope.service.ts`
- Modify: `src/admin-scope/admin-scope.service.spec.ts`

**Interfaces:**
- Produces:
  - `interface ManageableStores { roleTypeCode: string; stores: { storeId: number; storeTypeCode: string }[] }`
  - `AdminScopeService.getManageableStores(adminAccountId: number): Promise<ManageableStores | null>` — 계정이 없거나 사용 중이 아니면 `null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`admin-scope.service.spec.ts` 의 `prisma` mock 타입과 값에 `store.findMany` 를 더한다:

```ts
    store: { count: jest.Mock; findMany: jest.Mock };
```
```ts
      store: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest
          .fn()
          .mockResolvedValue([{ storeId: 5, storeTypeCode: 'DIRECT' }]),
      },
```

파일 끝(마지막 `});` 앞)에 더한다:

```ts
  describe('getManageableStores', () => {
    const get = () => scope.getManageableStores(9);

    it('역할과 점포를 준다 — 매핑 관리자는 삭제되지 않은 매핑의 점포만', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: false,
        roleTypeCode: 'BA',
      });

      await expect(get()).resolves.toEqual({
        roleTypeCode: 'BA',
        stores: [{ storeId: 5, storeTypeCode: 'DIRECT' }],
      });
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: {
          bpCodeId: 2,
          isDeleted: false,
          adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
        },
        select: { storeId: true, storeTypeCode: true },
        orderBy: { storeId: 'asc' },
      });
    });

    it('전체 점포 관리자는 매핑을 보지 않고 자기 BP 의 점포 전부', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
        roleTypeCode: 'BM',
      });

      await get();
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { bpCodeId: 2, isDeleted: false },
        select: { storeId: true, storeTypeCode: true },
        orderBy: { storeId: 'asc' },
      });
    });

    it('사용 중인 계정만 본다 — 없거나 미사용이면 null', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);

      await expect(get()).resolves.toBeNull();
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
      });
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: 실패하는지 본다**

Run: `pnpm test admin-scope -t "getManageableStores"`
Expected: FAIL — `scope.getManageableStores is not a function`

- [ ] **Step 3: 구현한다**

`admin-scope.service.ts` — 클래스 위에 인터페이스를, 클래스 끝에 메서드를 더한다:

```ts
/** 관리자가 관리하는 점포와 그 관리자의 권한 유형(공통코드 ROLE_TYPE — PM · PA · BM · BA · FM · FA). */
export interface ManageableStores {
  roleTypeCode: string;
  stores: { storeId: number; storeTypeCode: string }[];
}
```

```ts
  /**
   * 관리하는 점포 전부. canManageStore 와 같은 규칙이다 — 사용 중인 계정, 자기 BP 의 삭제되지 않은 점포,
   * 전체 점포가 아니면 삭제되지 않은 매핑의 점포만. 계정이 없거나 사용 중이 아니면 null.
   */
  async getManageableStores(
    adminAccountId: number,
  ): Promise<ManageableStores | null> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
    });
    if (!admin) return null;
    const stores = await this.prisma.store.findMany({
      where: {
        bpCodeId: admin.bpCodeId,
        isDeleted: false,
        ...(admin.isAllStores
          ? {}
          : { adminMappings: { some: { adminAccountId, isDeleted: false } } }),
      },
      select: { storeId: true, storeTypeCode: true },
      orderBy: { storeId: 'asc' },
    });
    return { roleTypeCode: admin.roleTypeCode, stores };
  }
```

- [ ] **Step 4: 통과하는지 본다**

Run: `pnpm test admin-scope`
Expected: PASS — 기존 테스트도 그대로 통과.

- [ ] **Step 5: 커밋한다**

```bash
pnpm lint
git add src/admin-scope/admin-scope.service.ts src/admin-scope/admin-scope.service.spec.ts
git commit -m "feat: 관리자가 관리하는 점포 목록 조회 (WHALEERP-329)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 목록 서비스 + 요청 · 응답 DTO

**Files:**
- Create: `src/staff-members/dto/staff-member-list.query.dto.ts`
- Create: `src/staff-members/dto/staff-member-list.response.dto.ts`
- Create: `src/staff-members/staff-member-list.service.ts`
- Create: `src/staff-members/staff-member-list.service.spec.ts`

**Interfaces:**
- Consumes: `joinStateOf`, `joinStateWhere`, `displayInvitation`, `StaffJoinState`, `STAFF_JOIN_STATES` (Task 1) · `kstWeekRange` (Task 2) · `AdminScopeService.getManageableStores`, `ManageableStores` (Task 3)
- Produces:
  - `class StaffMemberListQueryDto { page?: number; pageSize?: number; storeIds?: number[]; keyword?: string; employmentType?: EmploymentType; joinState?: StaffJoinState; employmentStatus?: EmploymentStatus }`
  - `class StaffMemberListResponseDto { items: StaffMemberListItemDto[]; total: number }`
  - `StaffMemberListService.list(adminAccountId: number, query: StaffMemberListQueryDto, now?: Date): Promise<StaffMemberListResponseDto | null>` — `null` 이면 관리자 계정이 없거나 사용 중이 아니다

- [ ] **Step 1: DTO 를 쓴다** (타입 선언이라 따로 테스트하지 않는다 — 검증 동작은 Task 5 e2e 가 본다)

`src/staff-members/dto/staff-member-list.query.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmploymentStatus, EmploymentType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { STAFF_JOIN_STATES, type StaffJoinState } from '../join-state';

const MAX_ID = 2_147_483_647;

/** 직원 목록 조회 (WHALEERP-329). */
export class StaffMemberListQueryDto {
  /** 페이지, 1부터 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 페이지당 건수, 기본 20 · 최대 200 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  /**
   * 쉼표로 구분한 점포 ID. 관리 범위 밖의 ID 는 조용히 빠진다. 없으면 관리 범위 전체.
   * 빈 칸 · 숫자가 아닌 값 · 범위 밖 값이 하나라도 있으면 400 이다.
   */
  @ApiPropertyOptional({ type: String, example: '3,5,8' })
  @IsOptional()
  @Transform(({ value }) =>
    String(value)
      .split(',')
      .map((v) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN)),
  )
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_ID, { each: true })
  storeIds?: number[];

  /** 이름 부분 일치, 또는 하이픈을 뺀 휴대전화번호 부분 일치 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;

  @ApiPropertyOptional({ enum: EmploymentType, enumName: 'EmploymentType' })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @ApiPropertyOptional({ enum: STAFF_JOIN_STATES, enumName: 'StaffJoinState' })
  @IsOptional()
  @IsIn(STAFF_JOIN_STATES)
  joinState?: StaffJoinState;

  /** 없으면 재직 · 퇴직 전체 */
  @ApiPropertyOptional({ enum: EmploymentStatus, enumName: 'EmploymentStatus' })
  @IsOptional()
  @IsEnum(EmploymentStatus)
  employmentStatus?: EmploymentStatus;
}
```

`src/staff-members/dto/staff-member-list.response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import {
  ContractStatus,
  EmploymentStatus,
  EmploymentType,
  InvitationStatus,
  InvitationType,
  LinkHoldMismatchReason,
} from '@prisma/client';
import { STAFF_JOIN_STATES, type StaffJoinState } from '../join-state';

export class StaffMemberStoreDto {
  storeId: number;
  name: string;
  /** 공통코드 STORE_TYPE — DIRECT 직영 · FRANCHISE 가맹 */
  storeType: string;
}

export class StaffMemberInvitationDto {
  @ApiProperty({ enum: InvitationType, enumName: 'InvitationType' })
  invitationType: InvitationType;
  @ApiProperty({ enum: InvitationStatus, enumName: 'InvitationStatus' })
  status: InvitationStatus;
  /** 이 초대를 보낸 일시 */
  lastSentAt: Date;
  expiresAt: Date;
}

/** 미처리 연결 보류. 인증된 번호의 끝 4자리와 불일치 사유만 담는다. */
export class StaffMemberLinkHoldDto {
  linkHoldId: number;
  @ApiProperty({ enum: LinkHoldMismatchReason, enumName: 'LinkHoldMismatchReason' })
  mismatchReason: LinkHoldMismatchReason;
  /** 가입자가 본인인증한 번호의 끝 4자리 */
  verifiedPhoneLast4: string;
  heldAt: Date;
}

/** 가장 최근 근로계약 */
export class StaffMemberContractDto {
  contractId: number;
  @ApiProperty({ enum: ContractStatus, enumName: 'ContractStatus', nullable: true })
  status: ContractStatus | null;
  signDeadlineAt: Date | null;
  /** 계약 종료일(YYYY-MM-DD). 비면 무기한 */
  endDate: string | null;
}

/**
 * 직원 목록 한 줄. isMasked 면 본사 제공 동의가 없는 가맹 점포 직원이고, staffMemberId · store 밖의 칸은 모두
 * null 이다 — 화면은 이름 자리에 「본사 제공 동의 없음 · 가맹 점포 직원」, 나머지에 「—」를 그린다.
 */
export class StaffMemberListItemDto {
  staffMemberId: number;
  isMasked: boolean;
  name: string | null;
  phone: string | null;
  store: StaffMemberStoreDto;
  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType', nullable: true })
  employmentType: EmploymentType | null;
  @ApiProperty({ enum: STAFF_JOIN_STATES, enumName: 'StaffJoinState', nullable: true })
  joinState: StaffJoinState | null;
  invitation: StaffMemberInvitationDto | null;
  linkHold: StaffMemberLinkHoldDto | null;
  contract: StaffMemberContractDto | null;
  /** 이번 주(한국 시간 월~일) 근무스케줄 합계, 휴게 뺀 분 */
  weeklyScheduledMinutes: number | null;
  @ApiProperty({ enum: EmploymentStatus, enumName: 'EmploymentStatus', nullable: true })
  employmentStatus: EmploymentStatus | null;
  /** 퇴직일(YYYY-MM-DD). 재직이면서 값이 있으면 퇴직 예정 */
  retiredDate: string | null;
}

export class StaffMemberListResponseDto {
  items: StaffMemberListItemDto[];
  total: number;
}
```

- [ ] **Step 2: 실패하는 서비스 테스트를 쓴다**

`src/staff-members/staff-member-list.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffMemberListService } from './staff-member-list.service';

// 2026-10-14(수) 한국 12시. 이번 주는 2026-10-12(월) 한국 0시 = 2026-10-11T15:00Z 부터.
const NOW = new Date('2026-10-14T03:00:00Z');

const row = (over: object = {}) => ({
  staffMemberId: 30,
  storeId: 5,
  name: '서지안',
  phone: '01028417702',
  employmentType: 'FULL_TIME',
  joinStatus: 'JOINED',
  employmentStatus: 'EMPLOYED',
  retiredDate: null,
  invitations: [],
  ...over,
});

describe('StaffMemberListService', () => {
  let service: StaffMemberListService;
  let scope: { getManageableStores: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    staffMember: { findMany: jest.Mock; count: jest.Mock };
    store: { findMany: jest.Mock };
    contract: { findMany: jest.Mock };
    workSchedule: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 5, storeTypeCode: 'DIRECT' },
          { storeId: 6, storeTypeCode: 'FRANCHISE' },
        ],
      }),
    };
    prisma = {
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      staffMember: {
        findMany: jest.fn().mockResolvedValue([row()]),
        count: jest.fn().mockResolvedValue(1),
      },
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 5, name: '모리커피 서초점', storeTypeCode: 'DIRECT' },
          { storeId: 6, name: '모리커피 청담점', storeTypeCode: 'FRANCHISE' },
        ]),
      },
      contract: { findMany: jest.fn().mockResolvedValue([]) },
      workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        StaffMemberListService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(StaffMemberListService);
  });

  const where = () => prisma.staffMember.findMany.mock.calls[0][0].where;

  it('사용 중인 관리자가 아니면 null', async () => {
    scope.getManageableStores.mockResolvedValue(null);
    await expect(service.list(9, {}, NOW)).resolves.toBeNull();
    expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
  });

  it('관리 범위와 storeIds 의 교집합이 비면 쿼리 없이 빈 목록', async () => {
    await expect(service.list(9, { storeIds: [99] }, NOW)).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
  });

  it('범위 밖 storeIds 는 조용히 빠진다', async () => {
    await service.list(9, { storeIds: [5, 99] }, NOW);
    expect(where().AND).toContainEqual({ storeId: { in: [5] } });
  });

  it('페이지 · 정렬 · count 가 같은 where 를 쓴다', async () => {
    await service.list(9, { page: 3, pageSize: 10 }, NOW);
    const args = prisma.staffMember.findMany.mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual({ staffMemberId: 'desc' });
    expect(prisma.staffMember.count).toHaveBeenCalledWith({
      where: args.where,
    });
  });

  it('keyword 는 이름과, 숫자만 남긴 번호로 찾는다', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'FM',
      stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
    });
    await service.list(9, { keyword: '010-2841' }, NOW);
    expect(where().AND).toContainEqual({
      OR: [
        { name: { contains: '010-2841', mode: 'insensitive' } },
        { phone: { contains: '0102841' } },
      ],
    });
  });

  it('필터가 있으면 BM · BA 에게 가맹 점포를 뺀다 — 가린 행이 검색으로 드러나지 않게', async () => {
    await service.list(9, { keyword: '홍길동' }, NOW);
    expect(where().AND).toContainEqual({ storeId: { in: [5] } });
  });

  it('필터가 없으면 BM · BA 도 가맹 점포를 포함하고 그 줄을 가린다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({ staffMemberId: 31, storeId: 6, name: '가맹직원' }),
    ]);
    const res = await service.list(9, {}, NOW);
    expect(where().AND).toContainEqual({ storeId: { in: [5, 6] } });
    expect(res.items[0]).toEqual({
      staffMemberId: 31,
      isMasked: true,
      name: null,
      phone: null,
      store: { storeId: 6, name: '모리커피 청담점', storeType: 'FRANCHISE' },
      employmentType: null,
      joinState: null,
      invitation: null,
      linkHold: null,
      contract: null,
      weeklyScheduledMinutes: null,
      employmentStatus: null,
      retiredDate: null,
    });
  });

  it('가맹관리자(FA)와 직영 점포는 가리지 않는다', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'FA',
      stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
    });
    prisma.staffMember.findMany.mockResolvedValue([row({ storeId: 6 })]);
    const res = await service.list(9, {}, NOW);
    expect(res.items[0].isMasked).toBe(false);
    expect(res.items[0].name).toBe('서지안');
  });

  it('보류는 끝 4자리와 사유만 낸다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({
        joinStatus: 'INVITED',
        invitations: [
          {
            invitationId: 1,
            invitationType: 'SIGNUP',
            status: 'ACCEPTED',
            sentAt: new Date('2026-08-31T00:12:00Z'),
            expiresAt: new Date('2026-09-30T00:12:00Z'),
            linkHolds: [
              {
                linkHoldId: 7,
                mismatchReason: 'PHONE_MISMATCH',
                createdAt: new Date('2026-08-31T12:40:00Z'),
                account: { phone: '01099994418' },
              },
            ],
          },
        ],
      }),
    ]);
    const item = (await service.list(9, {}, NOW)).items[0];
    expect(item.joinState).toBe('LINK_HOLD');
    expect(item.linkHold).toEqual({
      linkHoldId: 7,
      mismatchReason: 'PHONE_MISMATCH',
      verifiedPhoneLast4: '4418',
      heldAt: new Date('2026-08-31T12:40:00Z'),
    });
    expect(JSON.stringify(item)).not.toContain('01099994418');
    expect(item.invitation).toEqual({
      invitationType: 'SIGNUP',
      status: 'ACCEPTED',
      lastSentAt: new Date('2026-08-31T00:12:00Z'),
      expiresAt: new Date('2026-09-30T00:12:00Z'),
    });
  });

  it('최근 계약 정렬은 NULL 을 뒤로, 날짜는 YYYY-MM-DD', async () => {
    prisma.contract.findMany.mockResolvedValue([
      {
        staffMemberId: 30,
        contractId: 4,
        status: 'SIGNED',
        signDeadlineAt: null,
        endDate: new Date('2027-02-28T00:00:00Z'),
      },
    ]);
    const item = (await service.list(9, {}, NOW)).items[0];
    expect(prisma.contract.findMany.mock.calls[0][0].orderBy).toEqual([
      { staffMemberId: 'asc' },
      { createdAt: { sort: 'desc', nulls: 'last' } },
      { contractId: 'desc' },
    ]);
    expect(prisma.contract.findMany.mock.calls[0][0].distinct).toEqual([
      'staffMemberId',
    ]);
    expect(item.contract).toEqual({
      contractId: 4,
      status: 'SIGNED',
      signDeadlineAt: null,
      endDate: '2027-02-28',
    });
  });

  it('이번 주 근무시간은 휴게를 빼고, 삭제분과 다른 주는 쿼리에서 거른다', async () => {
    prisma.workSchedule.findMany.mockResolvedValue([
      {
        staffMemberId: 30,
        startAt: new Date('2026-10-13T00:00:00Z'),
        endAt: new Date('2026-10-13T08:00:00Z'),
        breakMinutes: 60,
      },
      {
        staffMemberId: 30,
        startAt: new Date('2026-10-14T04:00:00Z'),
        endAt: new Date('2026-10-14T08:30:00Z'),
        breakMinutes: 0,
      },
    ]);
    const item = (await service.list(9, {}, NOW)).items[0];
    expect(item.weeklyScheduledMinutes).toBe(420 + 270);
    expect(prisma.workSchedule.findMany.mock.calls[0][0].where).toEqual({
      staffMemberId: { in: [30] },
      isDeleted: false,
      startAt: {
        gte: new Date('2026-10-11T15:00:00Z'),
        lt: new Date('2026-10-18T15:00:00Z'),
      },
    });
  });

  it('스케줄 · 계약이 없으면 0분 · null, 퇴직일은 YYYY-MM-DD', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({ retiredDate: new Date('2026-09-30T00:00:00Z') }),
    ]);
    const item = (await service.list(9, {}, NOW)).items[0];
    expect(item.weeklyScheduledMinutes).toBe(0);
    expect(item.contract).toBeNull();
    expect(item.retiredDate).toBe('2026-09-30');
    expect(item.joinState).toBe('JOINED');
  });

  it('빈 페이지면 덧붙이는 조회를 하지 않는다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([]);
    prisma.staffMember.count.mockResolvedValue(12);
    await expect(service.list(9, { page: 9 }, NOW)).resolves.toEqual({
      items: [],
      total: 12,
    });
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 실패하는지 본다**

Run: `pnpm test staff-member-list`
Expected: FAIL — `Cannot find module './staff-member-list.service'`

- [ ] **Step 4: 구현한다**

`src/staff-members/staff-member-list.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffMemberListQueryDto } from './dto/staff-member-list.query.dto';
import {
  StaffMemberListItemDto,
  StaffMemberListResponseDto,
} from './dto/staff-member-list.response.dto';
import { displayInvitation, joinStateOf, joinStateWhere } from './join-state';
import { kstWeekRange } from './kst-date';

/**
 * 본사 역할(BP 마스터 · BP 관리자). 가맹 점포 직원은 본사 제공 동의를 한 경우에만 개인 단위로 본다
 * (운영 정책 ATT-30). 동의 칸(hq_sharing_consent)이 아직 없어 지금은 모두 동의 없음이다 — 칸이 생기면
 * isMaskedFor 에 「동의했으면 false」를 더한다(WHALEERP-137).
 */
const HQ_ROLES = new Set(['BM', 'BA']);
const FRANCHISE = 'FRANCHISE';

const STAFF_SELECT = {
  staffMemberId: true,
  storeId: true,
  name: true,
  phone: true,
  employmentType: true,
  joinStatus: true,
  employmentStatus: true,
  retiredDate: true,
  invitations: {
    orderBy: [{ sentAt: 'asc' }, { invitationId: 'asc' }],
    select: {
      invitationId: true,
      invitationType: true,
      status: true,
      sentAt: true,
      expiresAt: true,
      linkHolds: {
        where: { resolution: null },
        orderBy: [{ createdAt: 'desc' }, { linkHoldId: 'desc' }],
        // 보류 계정은 번호만 읽는다. 실명 · 다른 소속은 가입자의 정보라 관리자에게 보이지 않는다.
        select: {
          linkHoldId: true,
          mismatchReason: true,
          createdAt: true,
          account: { select: { phone: true } },
        },
      },
    },
  },
} satisfies Prisma.StaffMemberSelect;

const dateOnly = (date: Date | null) =>
  date ? date.toISOString().slice(0, 10) : null;

@Injectable()
export class StaffMemberListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 직원 목록. 관리자 계정이 없거나 사용 중이 아니면 null(컨트롤러가 403). */
  async list(
    adminAccountId: number,
    query: StaffMemberListQueryDto,
    now: Date = new Date(),
  ): Promise<StaffMemberListResponseDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) return null;

    const isHq = HQ_ROLES.has(manageable.roleTypeCode);
    // 가린 칸으로 거르면 건수가 그 값을 알려 준다. 본사 역할이 개인 칸으로 거르면 가맹 점포를 뺀다.
    const filtersPersonal =
      query.keyword !== undefined ||
      query.employmentType !== undefined ||
      query.joinState !== undefined ||
      query.employmentStatus !== undefined;
    const storeIds = manageable.stores
      .filter((s) => !query.storeIds || query.storeIds.includes(s.storeId))
      .filter((s) => !(isHq && filtersPersonal && s.storeTypeCode === FRANCHISE))
      .map((s) => s.storeId);
    if (storeIds.length === 0) return { items: [], total: 0 };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = this.whereOf(storeIds, query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.staffMember.findMany({
        where,
        orderBy: { staffMemberId: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: STAFF_SELECT,
      }),
      this.prisma.staffMember.count({ where }),
    ]);
    if (rows.length === 0) return { items: [], total };

    const ids = rows.map((r) => r.staffMemberId);
    const week = kstWeekRange(now);
    const [stores, contracts, schedules] = await Promise.all([
      this.prisma.store.findMany({
        where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
        select: { storeId: true, name: true, storeTypeCode: true },
      }),
      this.prisma.contract.findMany({
        where: { staffMemberId: { in: ids } },
        distinct: ['staffMemberId'],
        // created_at 은 nullable 이다. DESC 의 기본은 NULL 먼저라 오래된 계약이 「최근」이 될 수 있다.
        orderBy: [
          { staffMemberId: 'asc' },
          { createdAt: { sort: 'desc', nulls: 'last' } },
          { contractId: 'desc' },
        ],
        select: {
          staffMemberId: true,
          contractId: true,
          status: true,
          signDeadlineAt: true,
          endDate: true,
        },
      }),
      this.prisma.workSchedule.findMany({
        where: {
          staffMemberId: { in: ids },
          isDeleted: false,
          startAt: { gte: week.start, lt: week.end },
        },
        select: {
          staffMemberId: true,
          startAt: true,
          endAt: true,
          breakMinutes: true,
        },
      }),
    ]);

    const storeById = new Map(stores.map((s) => [s.storeId, s]));
    const contractByStaff = new Map(contracts.map((c) => [c.staffMemberId, c]));
    const minutesByStaff = new Map<number, number>();
    for (const s of schedules) {
      const minutes =
        Math.round((s.endAt.getTime() - s.startAt.getTime()) / 60_000) -
        s.breakMinutes;
      minutesByStaff.set(
        s.staffMemberId,
        (minutesByStaff.get(s.staffMemberId) ?? 0) + minutes,
      );
    }

    const items = rows.map((r): StaffMemberListItemDto => {
      const store = storeById.get(r.storeId);
      const storeDto = {
        storeId: r.storeId,
        name: store?.name ?? '',
        storeType: store?.storeTypeCode ?? '',
      };
      if (isHq && store?.storeTypeCode === FRANCHISE) {
        return {
          staffMemberId: r.staffMemberId,
          isMasked: true,
          name: null,
          phone: null,
          store: storeDto,
          employmentType: null,
          joinState: null,
          invitation: null,
          linkHold: null,
          contract: null,
          weeklyScheduledMinutes: null,
          employmentStatus: null,
          retiredDate: null,
        };
      }
      const shown = displayInvitation(r.invitations);
      const hold = r.invitations
        .flatMap((i) => i.linkHolds)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const contract = contractByStaff.get(r.staffMemberId);
      return {
        staffMemberId: r.staffMemberId,
        isMasked: false,
        name: r.name,
        phone: r.phone,
        store: storeDto,
        employmentType: r.employmentType,
        joinState: joinStateOf(r.joinStatus, r.invitations),
        invitation: shown
          ? {
              invitationType: shown.invitationType,
              status: shown.status,
              lastSentAt: shown.sentAt,
              expiresAt: shown.expiresAt,
            }
          : null,
        linkHold: hold
          ? {
              linkHoldId: hold.linkHoldId,
              mismatchReason: hold.mismatchReason,
              verifiedPhoneLast4: hold.account.phone.slice(-4),
              heldAt: hold.createdAt,
            }
          : null,
        contract: contract
          ? {
              contractId: contract.contractId,
              status: contract.status,
              signDeadlineAt: contract.signDeadlineAt,
              endDate: dateOnly(contract.endDate),
            }
          : null,
        weeklyScheduledMinutes: minutesByStaff.get(r.staffMemberId) ?? 0,
        employmentStatus: r.employmentStatus,
        retiredDate: dateOnly(r.retiredDate),
      };
    });
    return { items, total };
  }

  private whereOf(
    storeIds: number[],
    query: StaffMemberListQueryDto,
  ): Prisma.StaffMemberWhereInput {
    const and: Prisma.StaffMemberWhereInput[] = [
      { storeId: { in: storeIds } },
    ];
    const keyword = query.keyword?.trim();
    if (keyword) {
      const digits = keyword.replace(/\D/g, '');
      and.push({
        OR: [
          { name: { contains: keyword, mode: 'insensitive' } },
          ...(digits ? [{ phone: { contains: digits } }] : []),
        ],
      });
    }
    if (query.employmentType)
      and.push({ employmentType: query.employmentType });
    if (query.employmentStatus)
      and.push({ employmentStatus: query.employmentStatus });
    if (query.joinState) and.push(joinStateWhere(query.joinState));
    return { AND: and };
  }
}
```

- [ ] **Step 5: 통과하는지 본다**

Run: `pnpm test staff-member-list`
Expected: PASS — 14건. 타입 오류(`distinct`, `nulls`)가 나면 Prisma 7 문법을 `node_modules/.prisma/client/index.d.ts` 에서 확인해 맞춘다(동작은 바꾸지 않는다).

- [ ] **Step 6: 커밋한다**

```bash
pnpm lint
git add src/staff-members/dto/staff-member-list.query.dto.ts src/staff-members/dto/staff-member-list.response.dto.ts src/staff-members/staff-member-list.service.ts src/staff-members/staff-member-list.service.spec.ts
git commit -m "feat: 직원 목록 조회 서비스 (WHALEERP-329)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 컨트롤러 · 모듈 연결 · e2e

**Files:**
- Create: `src/staff-members/staff-members.controller.ts`
- Create: `src/staff-members/staff-members.controller.spec.ts`
- Modify: `src/staff-members/staff-members.module.ts`
- Create: `test/staff-members.e2e-spec.ts`

**Interfaces:**
- Consumes: `StaffMemberListService.list` · `StaffMemberListQueryDto` · `StaffMemberListResponseDto` (Task 4)
- Produces: `GET /staff-members`

- [ ] **Step 1: 실패하는 컨트롤러 테스트를 쓴다**

`src/staff-members/staff-members.controller.spec.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StaffMemberListService } from './staff-member-list.service';
import { StaffMembersController } from './staff-members.controller';

describe('StaffMembersController', () => {
  let controller: StaffMembersController;
  let list: { list: jest.Mock };
  const admin = { type: 'admin' as const, id: 9, email: 'a@test.invalid' };

  beforeEach(async () => {
    list = { list: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [StaffMembersController],
      providers: [{ provide: StaffMemberListService, useValue: list }],
    }).compile();
    controller = module.get(StaffMembersController);
  });

  it('관리자 ID 와 쿼리를 넘겨 결과를 그대로 낸다', async () => {
    list.list.mockResolvedValue({ items: [], total: 0 });
    await expect(controller.findAll(admin, { page: 2 })).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(list.list).toHaveBeenCalledWith(9, { page: 2 });
  });

  it('사용 중인 관리자가 아니면 403', async () => {
    list.list.mockResolvedValue(null);
    await expect(controller.findAll(admin, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
```

- [ ] **Step 2: 실패하는지 본다**

Run: `pnpm test staff-members.controller`
Expected: FAIL — `Cannot find module './staff-members.controller'`

- [ ] **Step 3: 컨트롤러를 쓰고 모듈에 연결한다**

`src/staff-members/staff-members.controller.ts`:

```ts
import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { StaffMemberListQueryDto } from './dto/staff-member-list.query.dto';
import { StaffMemberListResponseDto } from './dto/staff-member-list.response.dto';
import { StaffMemberListService } from './staff-member-list.service';

/**
 * 직원 정보 관리 목록 (WHALEERP-329). 관리자 웹만 쓴다 — 직원 앱 토큰은 403. 관리 범위 밖 점포는 storeIds 로
 * 골라도 조용히 빠진다(오류를 주면 다른 BP 에 그 점포가 있다는 것이 드러난다).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님',
})
@ApiBadRequestResponse({ description: '쿼리 형식 오류' })
@UserTypes('admin')
@Controller('staff-members')
export class StaffMembersController {
  constructor(private readonly staffList: StaffMemberListService) {}

  @Get()
  async findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: StaffMemberListQueryDto,
  ): Promise<StaffMemberListResponseDto> {
    const result = await this.staffList.list(user.id, query);
    if (!result)
      throw new ForbiddenException('사용 중인 관리자 계정이 아닙니다');
    return result;
  }
}
```

`src/staff-members/staff-members.module.ts` 를 바꾼다:

```ts
import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { RetirementController } from './retirement.controller';
import { RetirementScheduler } from './retirement.scheduler';
import { RetirementService } from './retirement.service';
import { StaffMemberListService } from './staff-member-list.service';
import { StaffMembersController } from './staff-members.controller';

@Module({
  imports: [BatchModule, AdminScopeModule],
  controllers: [StaffMembersController, RetirementController],
  providers: [RetirementService, RetirementScheduler, StaffMemberListService],
  exports: [RetirementService],
})
export class StaffMembersModule {}
```

Run: `pnpm test staff-members.controller` → PASS 2건.

- [ ] **Step 4: 일회용 DB 를 띄운다** (공용 DB 금지 — CLAUDE.md)

```bash
docker run --rm -d --name petra-pg -p 55432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=whale postgres:18
sleep 3
DATABASE_URL=postgresql://postgres:pw@localhost:55432/whale corepack pnpm exec prisma migrate deploy
```
Expected: 마이그레이션 18개 적용. `pnpm db:deploy` 는 쓰지 않는다(`.env.local` 의 공용 DB 를 읽는다).

- [ ] **Step 5: 실패하는 e2e 를 쓴다**

`test/staff-members.e2e-spec.ts`:

```ts
import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 직원 목록(WHALEERP-329)을 실제 DB 로 확인한다. 가입 상태 필터는 초대 · 보류 관계 조건이라 목으로는 Prisma 가
// 그 조건을 맞게 푸는지 증명되지 않는다.
describe('직원 목록 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let bpCodeId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let otherBpId: number;
  let otherBpStoreId: number;
  let bmId: number; // BP 마스터, 전체 점포
  let fmId: number; // 가맹마스터, 가맹 점포 매핑
  let inactiveId: number; // 미사용 관리자
  const adminIds: number[] = [];
  const staffIds: number[] = [];
  const accountIds: number[] = [];
  const n = randomInt(100_000, 999_999);
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const bp = (code: number, name: string) =>
      prisma.bpCode.create({
        data: {
          bpCode: `BP${code}`,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: name,
        },
      });
    const store = (
      code: number,
      bp: number,
      storeTypeCode: string,
      name: string,
    ) =>
      prisma.store.create({
        data: {
          storeCode: `ST${code}`,
          bpCodeId: bp,
          storeTypeCode,
          name,
          storeStatusCode: 'OPERATING',
        },
      });
    ({ bpCodeId } = await bp(n, '목록 테스트 BP'));
    ({ bpCodeId: otherBpId } = await bp((n + 1) % 1_000_000, '다른 BP'));
    ({ storeId: directStoreId } = await store(n, bpCodeId, 'DIRECT', '직영점'));
    ({ storeId: franchiseStoreId } = await store(
      (n + 1) % 1_000_000,
      bpCodeId,
      'FRANCHISE',
      '가맹점',
    ));
    ({ storeId: otherBpStoreId } = await store(
      (n + 2) % 1_000_000,
      otherBpId,
      'DIRECT',
      '다른 BP 점포',
    ));

    const roleGroupId = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    const admin = async (
      loginId: string,
      roleTypeCode: string,
      roleCode: string,
      extra: object,
    ) => {
      const a = await prisma.adminAccount.create({
        data: {
          loginId,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId: await roleGroupId(roleCode),
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: false,
          ...extra,
        },
      });
      adminIds.push(a.adminAccountId);
      return a.adminAccountId;
    };
    bmId = await admin(`listbm${n}`, 'BM', 'BM000001', { isAllStores: true });
    fmId = await admin(`listfm${n}`, 'FM', 'FM000001', {
      storeMappings: { create: { storeId: franchiseStoreId } },
    });
    inactiveId = await admin(`listoff${n}`, 'BM', 'BM000001', {
      isAllStores: true,
      accountStatusCode: 'INACTIVE',
    });

    const staff = async (
      key: string,
      storeId: number,
      name: string,
      joinStatus: 'DRAFT' | 'INVITED' | 'JOINED',
      extra: object = {},
    ) => {
      const s = await prisma.staffMember.create({
        data: {
          storeId,
          name,
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus,
          ...extra,
        },
      });
      staffIds.push(s.staffMemberId);
      ids[key] = s.staffMemberId;
      return s.staffMemberId;
    };
    const invite = (
      staffMemberId: number,
      invitationType: 'SIGNUP' | 'REINVITE' | 'AFFILIATION_CONFIRM',
      status: 'SENT' | 'EXPIRED' | 'ACCEPTED' | 'REJECTED_UNDER_AGE',
      sentAt = new Date(),
    ) =>
      prisma.invitation.create({
        data: {
          staffMemberId,
          invitationType,
          channel: 'SMS',
          sentAt,
          expiresAt: new Date(sentAt.getTime() + 30 * 86_400_000),
          status,
        },
      });

    await staff('joined', directStoreId, '가입직원', 'JOINED');
    await staff('draft', directStoreId, '초안직원', 'DRAFT');
    await invite(
      await staff('invited', directStoreId, '초대직원', 'INVITED'),
      'SIGNUP',
      'SENT',
    );
    await invite(
      await staff('affiliation', directStoreId, '소속확인직원', 'INVITED'),
      'AFFILIATION_CONFIRM',
      'SENT',
    );
    await invite(
      await staff('underAge', directStoreId, '미성년직원', 'INVITED'),
      'SIGNUP',
      'REJECTED_UNDER_AGE',
    );
    const expiredId = await staff('expired', directStoreId, '만료직원', 'INVITED');
    await invite(expiredId, 'SIGNUP', 'EXPIRED', new Date('2026-08-01T00:00:00Z'));
    // 만료 뒤 재초대가 나간 직원은 INVITED 이고 EXPIRED 필터에 걸리지 않는다.
    const reinvitedId = await staff('reinvited', directStoreId, '재초대직원', 'INVITED');
    await invite(reinvitedId, 'SIGNUP', 'EXPIRED', new Date('2026-08-01T00:00:00Z'));
    await invite(reinvitedId, 'REINVITE', 'SENT');

    const heldId = await staff('held', directStoreId, '보류직원', 'INVITED');
    const heldInvitation = await invite(heldId, 'SIGNUP', 'ACCEPTED');
    const holdAccount = await prisma.account.create({
      data: {
        email: `hold-${n}@test.invalid`,
        passwordHash: '!',
        realName: '가입자실명',
        birthDate: new Date('1990-01-01'),
        phone: `0109999${String(n).slice(-4)}`,
        status: 'JOINED',
      },
    });
    accountIds.push(holdAccount.accountId);
    await prisma.linkHold.create({
      data: {
        invitationId: heldInvitation.invitationId,
        accountId: holdAccount.accountId,
        mismatchReason: 'PHONE_MISMATCH',
      },
    });

    await staff('franchise', franchiseStoreId, '가맹직원', 'JOINED');
    await staff('otherBp', otherBpStoreId, '다른BP직원', 'JOINED');
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    await prisma.linkHold.deleteMany({ where: { invitation: byStaff } });
    await prisma.invitation.deleteMany({ where: byStaff });
    await prisma.staffMember.deleteMany({ where: byStaff });
    await prisma.authSession.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.adminStoreMapping.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [directStoreId, franchiseStoreId, otherBpStoreId] } },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpId] } },
    });
    await app.close();
  });

  const tokenOf = (sub: number) =>
    app
      .get(JwtService)
      .signAsync({ sub, type: 'admin', email: 'a@test.invalid', typ: 'access' });
  const get = async (query: string, sub = bmId) =>
    request(app.getHttpServer())
      .get(`/staff-members${query}`)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
  const idsOf = (body: { items: { staffMemberId: number }[] }) =>
    body.items.map((i) => i.staffMemberId);

  it('관리 범위의 직원만, 최근 등록 먼저 — 다른 BP 는 없다', async () => {
    const res = await get('?pageSize=200');
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).not.toContain(ids.otherBp);
    expect(idsOf(res.body)).toEqual(
      [...staffIds].filter((id) => id !== ids.otherBp).sort((a, b) => b - a),
    );
    expect(res.body.total).toBe(staffIds.length - 1);
  });

  it('BP 마스터에게 가맹 점포 직원은 가린 행이고 total 에 센다', async () => {
    const res = await get('?pageSize=200');
    const row = res.body.items.find(
      (i: { staffMemberId: number }) => i.staffMemberId === ids.franchise,
    );
    expect(row).toMatchObject({ isMasked: true, name: null, phone: null });
    expect(row.store).toEqual({
      storeId: franchiseStoreId,
      name: '가맹점',
      storeType: 'FRANCHISE',
    });
  });

  it('검색으로 가린 행을 찾을 수 없다', async () => {
    const res = await get(`?keyword=${encodeURIComponent('가맹직원')}`);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it('가맹마스터는 자기 가맹 점포 직원을 가리지 않고 본다', async () => {
    const res = await get('', fmId);
    expect(idsOf(res.body)).toEqual([ids.franchise]);
    expect(res.body.items[0]).toMatchObject({
      isMasked: false,
      name: '가맹직원',
    });
  });

  it.each([
    ['JOINED', 'joined'],
    ['DRAFT', 'draft'],
    ['INVITED', 'invited'],
    ['AFFILIATION_PENDING', 'affiliation'],
    ['UNDER_AGE', 'underAge'],
    ['EXPIRED', 'expired'],
    ['LINK_HOLD', 'held'],
  ])('joinState=%s 필터와 표시가 같다', async (state, key) => {
    const res = await get(`?joinState=${state}&storeIds=${directStoreId}`);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toContain(ids[key]);
    for (const item of res.body.items) expect(item.joinState).toBe(state);
  });

  it('만료 뒤 재초대가 나간 직원은 INVITED 로만 나온다', async () => {
    const expired = await get(`?joinState=EXPIRED&storeIds=${directStoreId}`);
    expect(idsOf(expired.body)).not.toContain(ids.reinvited);
    const invited = await get(`?joinState=INVITED&storeIds=${directStoreId}`);
    expect(idsOf(invited.body)).toContain(ids.reinvited);
  });

  it('보류 줄은 끝 4자리와 사유만, 가입자 실명은 없다', async () => {
    const res = await get(`?joinState=LINK_HOLD&storeIds=${directStoreId}`);
    const row = res.body.items.find(
      (i: { staffMemberId: number }) => i.staffMemberId === ids.held,
    );
    expect(row.linkHold).toMatchObject({
      mismatchReason: 'PHONE_MISMATCH',
      verifiedPhoneLast4: String(n).slice(-4),
    });
    expect(JSON.stringify(res.body)).not.toContain('가입자실명');
  });

  it('범위 밖 storeIds 는 빈 목록이다(404 · 403 이 아니다)', async () => {
    const res = await get(`?storeIds=${otherBpStoreId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it('마지막 페이지를 넘기면 빈 items 와 total', async () => {
    const res = await get('?page=999');
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(staffIds.length - 1);
  });

  it.each([
    'storeIds=abc',
    'storeIds=3,,5',
    'storeIds=0',
    'storeIds=2147483648',
    'pageSize=201',
    'joinState=NOPE',
    'unknown=1',
  ])('쿼리 형식 오류는 400 — %s', async (query) => {
    expect((await get(`?${query}`)).status).toBe(400);
  });

  it('미사용 관리자는 403', async () => {
    expect((await get('', inactiveId)).status).toBe(403);
  });

  it('토큰이 없으면 401', async () => {
    expect((await request(app.getHttpServer()).get('/staff-members')).status).toBe(
      401,
    );
  });

  it('직원 앱 토큰으로는 닿을 수 없다(403)', async () => {
    // 살아 있는 접속의 토큰이어야 한다 — 접속 상태가 없는 account 토큰은 종류를 따지기 전에 401 로 끝난다.
    const accountId = accountIds[0];
    const session = await app
      .get(AuthSessionService)
      .issue({ accountId, deviceIdentifier: 'staff-list-e2e' });
    const token = await app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
    const res = await request(app.getHttpServer())
      .get('/staff-members')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 6: e2e 를 돌린다**

Run:
```bash
APP_ENV=test DATABASE_URL=postgresql://postgres:pw@localhost:55432/whale JWT_SECRET=$(node -e "console.log('x'.repeat(48))") pnpm test:e2e staff-members
```
Expected: 컨트롤러가 이미 있으니 대부분 PASS 여야 한다. 실패가 있으면 그 테스트의 기대가 설계 문서와 맞는지 먼저 보고, 설계대로면 구현을 고친다. 특히 `joinState` 표시 · 필터가 어긋나면 `join-state.ts` 두 함수를 함께 본다. `INACTIVE` 가 공통코드 `ACCOUNT_STATUS` 값이 아니라 insert 가 실패하면 `SELECT item_code FROM code_items WHERE group_code='ACCOUNT_STATUS'` 로 확인해 사용 중이 아닌 값으로 바꾼다.

- [ ] **Step 7: 전체 단위 테스트와 커밋**

```bash
pnpm test
pnpm lint
git add src/staff-members/staff-members.controller.ts src/staff-members/staff-members.controller.spec.ts src/staff-members/staff-members.module.ts test/staff-members.e2e-spec.ts
git commit -m "feat: 직원 목록 조회 API GET /staff-members (WHALEERP-329)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: OpenAPI 갱신 · 지식 문서 · 마무리 확인

**Files:**
- Modify: `openapi/openapi.json` (생성)
- Create: `okf/api/staff-members.md`
- Modify: `okf/index.md`, `okf/log.md`, `okf/conventions/naming.md` (「worked example 이 아직 없다」 문장)

**Interfaces:**
- Consumes: Task 1~5 전체

- [ ] **Step 1: OpenAPI 를 내보낸다**

Run: `pnpm openapi:export`
Expected: `openapi/openapi.json` 에 `/staff-members` GET, `StaffJoinState` · `StaffMemberListResponseDto` 스키마가 생긴다. 확인:

```bash
node -e "const d=require('./openapi/openapi.json'); console.log(!!d.paths['/staff-members']?.get, !!d.components.schemas.StaffJoinState, !!d.components.schemas.StaffMemberListResponseDto)"
```
Expected: `true true true`

- [ ] **Step 2: okf 개념을 쓴다**

`okf/api/staff-members.md` — 같은 폴더의 다른 개념(`okf/api/staff-retirement.md`)의 frontmatter 모양을 그대로 따른다(`type`, `sources[].resource` · `last_modified`, `generated.at`(지금 UTC ISO) · `generated.by: claude-code/opus-5.5`). `verified` 는 쓰지 않는다. 본문에 담을 것 — 설정값을 옮기지 말고 결과와 함정을 쓴다:

```markdown
# 직원 목록 (GET /staff-members)

관리자 웹 직원 정보 관리 목록을 한 번에 그린다(WHALEERP-329). 이 저장소의 첫 실제 도메인 목록 API 라 목록
규칙(`{ items, total }`, page · pageSize, `$transaction`, id 로 끝나는 정렬)의 참고 구현이다.

# 가입·인증 상태는 DB 칸이 아니다

`StaffJoinState` 는 직원 레코드 · 초대 · 연결 보류에서 만든 API 전용 enum 이다. 표시(`joinStateOf`)와 필터
(`joinStateWhere`)는 `src/staff-members/join-state.ts` 한 파일에 있다 — 한쪽만 고치면 필터 결과에 다른 상태가
섞인다. 「한 직원에 발송 중 초대는 하나」라는 가정(136 의 재발송 규칙)에 기대며, 만료 · 거절 필터는 「마지막
초대」를 관계 조건으로 표현하지 못해 근사로 거른다.

# 본사 제공 동의 가림

BP 마스터 · BP 관리자에게 가맹 점포 직원은 가린 행이다(ATT-30). 동의 칸이 아직 없어 지금은 모두 가린다. 개인
칸으로 거르면(검색 · 고용형태 · 가입 상태 · 재직 상태) 가맹 점포를 아예 뺀다 — 가린 행 하나가 검색에 걸리는
것만으로 그 사람이 있다는 것이 드러나기 때문이다. 동의 칸이 생기면(137) `isMasked` 판단 한 곳만 고친다.

# 범위 밖 점포는 오류가 아니다

`storeIds` 의 범위 밖 ID 는 조용히 빠진다. 403 · 404 를 주면 다른 BP 에 그 점포가 있다는 것이 드러난다.

# 아직 정해지지 않은 값

재발송 가능 여부(간격 미정)와 갱신 예정 기준 일수는 응답에 없다. `invitation.lastSentAt` 과
`contract.endDate` 를 주고, 값이 정해지면 서버에서 판단을 더한다.
```

- [ ] **Step 3: 색인 · 로그 · 네이밍 문장을 고친다**

- `okf/index.md`: 머리말의 「the first real domain module becomes the worked example.」을 「직원 목록(`/api/staff-members.md`)이 목록 API 의 참고 구현이다.」로 바꾸고, Service 목록 아래에 `* [직원 목록](/api/staff-members.md) - GET /staff-members, 가입·인증 상태 파생 · 본사 제공 동의 가림.` 한 줄을 더한다.
- `okf/conventions/naming.md`: 「there is also no worked example yet — the first real domain module becomes it, and `okf/index.md` should point there.」를 「the worked example for list responses is `GET /staff-members` ([staff members](/api/staff-members.md)).」로 바꾸고, 그 개념의 `generated.at` · `generated.by` 를 갱신한다. `verified` 는 건드리지 않는다.
- `okf/log.md`: 맨 위 `## 2026-10-12` 아래(없으면 만든다)에 `- api/staff-members 추가 — 직원 목록 API(WHALEERP-329). index · naming 의 worked example 문장 갱신.`

- [ ] **Step 4: 전체 확인**

```bash
pnpm lint
pnpm test
pnpm build
APP_ENV=test DATABASE_URL=postgresql://postgres:pw@localhost:55432/whale JWT_SECRET=$(node -e "console.log('x'.repeat(48))") pnpm test:e2e staff-members
```
Expected: 모두 성공, 단위 · e2e 의 passed 수가 0 이 아니다. 출력의 숫자를 PR 본문에 옮긴다.

- [ ] **Step 5: 커밋하고 일회용 DB 를 내린다**

```bash
git add openapi/openapi.json okf/api/staff-members.md okf/index.md okf/log.md okf/conventions/naming.md
git commit -m "docs: 직원 목록 API 를 OpenAPI 와 okf 에 반영 (WHALEERP-329)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
docker stop petra-pg
```

푸시 · PR 은 이 계획 밖이다 — 사용자에게 묻고 한다. PR 본문과 Plane 329 댓글에는 설계 문서 「마무리」의 세 가지(재발송 가능 여부 제외, BM · BA × 가맹 전부 가림과 필터 시 제외, 갱신 예정 일수 미정)를 적는다.
