import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { PrismaService } from '../prisma/prisma.service';
import { HomeService, openRejectionAt } from './home.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_CONSENT_VERSION,
} from '../admin-scope/hq-sharing';

const date = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
// 2026-10-27(화) 한국 시각 오전 7시 — UTC 로는 전날 밤이라 한국 날짜로 정하는지 함께 본다
const NOW = new Date('2026-10-26T22:00:00Z');
const TODAY = date('2026-10-27');
const HOUR = 60 * 60 * 1000;
// 본사 역할에게 가맹 점포(2)는 가려진다 — 근로계약 목록(ContractsService.list)과 같은 조건
const SHOWN_CONTRACT = {
  OR: [
    { storeId: { in: [1] } },
    {
      storeId: { in: [2] },
      staffMember: {
        account: HQ_SHARING_CONSENTED.account,
      },
    },
  ],
};
const SHOWN_STAFF = {
  OR: [
    { storeId: { in: [1] } },
    {
      storeId: { in: [2] },
      account: HQ_SHARING_CONSENTED.account,
    },
  ],
};

describe('HomeService', () => {
  let service: HomeService;
  let scope: {
    platformAdminAccess: jest.Mock;
    getManageableStores: jest.Mock;
  };
  let denied: Set<string>;
  let storeRows: {
    storeId: number;
    name: string;
    storeTypeCode: string;
    status: string;
  }[];
  let prisma: Record<string, Record<string, jest.Mock>>;

  beforeEach(async () => {
    denied = new Set();
    scope = {
      platformAdminAccess: jest.fn().mockResolvedValue('denied'),
      getManageableStores: jest.fn().mockResolvedValue({
        // 가맹마스터 — 가림이 없다. 본사 역할의 가림은 따로 본다
        roleTypeCode: 'FM',
        stores: [
          { storeId: 1, storeTypeCode: 'DIRECT' },
          { storeId: 2, storeTypeCode: 'FRANCHISE' },
        ],
      }),
    };
    storeRows = [
      {
        storeId: 1,
        name: '성수점',
        storeTypeCode: 'DIRECT',
        status: 'OPERATING',
      },
      {
        storeId: 2,
        name: '연남점',
        storeTypeCode: 'FRANCHISE',
        status: 'OPERATING',
      },
    ];
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 3 }),
      },
      roleGroupMenu: {
        count: jest.fn(({ where }: { where: { menu: { url: string } } }) =>
          Promise.resolve(denied.has(where.menu.url) ? 0 : 1),
        ),
      },
      menu: { count: jest.fn().mockResolvedValue(1) },
      // where 의 점포 ID · 폐점 제외를 따른다
      store: {
        findMany: jest.fn(
          ({ where }: { where: { storeId: { in: number[] } } }) =>
            Promise.resolve(
              storeRows
                .filter(
                  (r) =>
                    where.storeId.in.includes(r.storeId) &&
                    r.status !== 'CLOSED',
                )
                .map((r) => ({
                  storeId: r.storeId,
                  name: r.name,
                  storeTypeCode: r.storeTypeCode,
                })),
            ),
        ),
      },
      staffMember: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      contract: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      attendanceRecord: { findMany: jest.fn().mockResolvedValue([]) },
      inquiry: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      inquiryReply: { groupBy: jest.fn().mockResolvedValue([]) },
      todo: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        HomeService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(HomeService);
  });

  const firstArg = (mock: jest.Mock) =>
    (mock.mock.calls[0] as [Record<string, any>])[0];
  /** 호출 인자의 where.AND — 범위 · 가림 조건을 다른 조건과 AND 로 묶는다 */
  const andOf = (arg: Record<string, any>) =>
    (arg.where as { AND: unknown[] }).AND;

  /** 열린 소속 확인 거절 한 건의 직원 행 */
  const rejectedStaff = (storeId: number, name: string, at: Date) => ({
    storeId,
    name,
    retiredDate: null,
    account: { isHqSharingConsented: false },
    invitations: [
      {
        invitationType: 'AFFILIATION_CONFIRM',
        status: 'REJECTED',
        sentAt: at,
        respondedAt: at,
      },
    ],
    contracts: [{ createdAt: new Date(at.getTime() - HOUR) }],
  });

  describe('범위 · 계정', () => {
    it('고른 점포 중 관리 범위 밖 ID 는 조용히 빠진다', async () => {
      await service.summary(9, [2, 99], NOW);
      expect(firstArg(prisma.staffMember.groupBy).where).toMatchObject({
        storeId: { in: [2] },
      });
      expect(firstArg(prisma.contract.groupBy).where).toMatchObject({
        AND: [{ storeId: { in: [2] } }, {}],
      });
      expect(firstArg(prisma.store.findMany).where).toEqual({
        storeId: { in: [2] },
        storeStatusCode: { not: 'CLOSED' },
      });
    });

    it('폐점 점포는 모든 집계에서 빠진다 — 카드 · 표 · 처리 대기 · 경고 밴드가 같은 점포를 센다', async () => {
      storeRows[1].status = 'CLOSED';
      await service.summary(9, undefined, NOW);
      await service.pending(9, undefined, NOW);
      const only1 = { storeId: { in: [1] } };
      expect(firstArg(prisma.staffMember.groupBy).where).toMatchObject(only1);
      expect(andOf(firstArg(prisma.contract.groupBy))).toContainEqual(only1);
      expect(firstArg(prisma.workSchedule.findMany).where).toMatchObject(only1);
      expect(
        andOf(firstArg(prisma.attendanceRecord.findMany))[0],
      ).toMatchObject(only1);
      for (const call of prisma.contract.findMany.mock.calls)
        expect(andOf((call as [Record<string, any>])[0])).toContainEqual(only1);
      for (const call of prisma.todo.findMany.mock.calls)
        expect((call as [Record<string, any>])[0].where).toMatchObject(only1);
      for (const call of prisma.staffMember.findMany.mock.calls)
        expect(andOf((call as [Record<string, any>])[0])).toContainEqual(only1);
    });

    it('고르지 않으면 관리 범위 전체', async () => {
      await service.pending(9, undefined, NOW);
      expect(firstArg(prisma.todo.findMany).where).toMatchObject({
        storeId: {
          in: [1, 2],
        },
      });
    });

    it('플랫폼 계정은 403 이 아니라 platform: true 인 빈 결과 — 범위 · 집계를 읽지 않는다', async () => {
      scope.platformAdminAccess.mockResolvedValue('allowed');
      await expect(service.summary(9, undefined, NOW)).resolves.toEqual({
        asOf: NOW,
        platform: true,
        cards: null,
        storeTable: { total: 0, items: [] },
      });
      await expect(service.pending(9, undefined, NOW)).resolves.toEqual({
        asOf: NOW,
        platform: true,
        renewals: null,
        items: [],
      });
      expect(scope.getManageableStores).not.toHaveBeenCalled();
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });

    it('사용 중인 관리자 계정이 아니면 403', async () => {
      scope.platformAdminAccess.mockResolvedValue('unavailable');
      await expect(service.summary(9, undefined, NOW)).rejects.toThrow(
        new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
      );
    });
  });

  describe('summary', () => {
    it('재직 직원 — 퇴직하지 않았고 임시저장 말고 다른 계약이 있는 레코드를 고용 형태별로 센다', async () => {
      // 점포별 총수 · 고용 형태 나눔을 따로 센다
      prisma.staffMember.groupBy
        .mockResolvedValueOnce([
          { storeId: 1, _count: { _all: 5 } },
          { storeId: 2, _count: { _all: 4 } },
        ])
        .mockResolvedValueOnce([
          { employmentType: 'FULL_TIME', _count: { _all: 2 } },
          { employmentType: 'PART_TIME', _count: { _all: 7 } },
        ]);
      const res = await service.summary(9, undefined, NOW);
      expect(firstArg(prisma.staffMember.groupBy).where).toMatchObject({
        employmentStatus: 'EMPLOYED',
        contracts: { some: { status: { not: 'DRAFT' } } },
      });
      expect(res.cards!.staff).toEqual({ total: 9, fullTime: 2, partTime: 7 });
      expect(res.storeTable.items.map((r) => r.staffCount)).toEqual([5, 4]);
    });

    it('운영 점포 — 폐점이 아닌 점포를 직영 · 가맹으로', async () => {
      const res = await service.summary(9, undefined, NOW);
      expect(res.cards!.stores).toEqual({ total: 2, direct: 1, franchise: 1 });
    });

    /** 오늘 근무스케줄 한 줄(직원 레코드의 계정 동의를 함께 읽는다) */
    const schedule = (
      storeId: number,
      staffMemberId: number,
      startAt: Date,
      consented = false,
    ) => ({
      storeId,
      staffMemberId,
      startAt,
      staffMember: {
        account: {
          isHqSharingConsented: consented,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        },
      },
    });
    const punch = (
      storeId: number,
      staffMemberId: number,
      kind: 'CHECK_IN' | 'CHECK_OUT',
      checkInAttendanceRecordId: number | null = null,
    ) => ({
      attendanceRecordId: staffMemberId * 10,
      storeId,
      staffMemberId,
      kind,
      recordedAt: new Date(NOW.getTime() - HOUR / 2),
      reviewReason: null,
      entryMethod: 'SELF',
      checkInAttendanceRecordId,
    });

    it('오늘 출근 — 근무 예정 · 출근 · 미출근. 미출근은 출퇴근 현황(api #159 attendanceDayStatus)과 같다', async () => {
      const before = new Date(NOW.getTime() - HOUR);
      prisma.workSchedule.findMany.mockResolvedValue([
        schedule(1, 10, before),
        // 시작 시각 정각은 아직 예정이다(#159 는 now > 시작)
        schedule(1, 11, NOW),
        schedule(2, 20, before),
        // 시작 전 — 근무 예정에는 들고 미출근은 아니다(운영 정책 ATT-34)
        schedule(2, 22, new Date(NOW.getTime() + 1)),
        // 출근 없는 퇴근만 있다 — 출근 미등록이지 미출근이 아니다
        schedule(2, 23, before),
        // 어제 출근의 짝 퇴근만 오늘 찍혔다 — 그 퇴근은 어제 것이라 오늘은 미출근
        schedule(2, 24, before),
      ]);
      prisma.attendanceRecord.findMany.mockResolvedValue([
        punch(1, 10, 'CHECK_IN'),
        // 근무 예정이 아니어도 출근은 센다
        punch(2, 21, 'CHECK_IN'),
        punch(2, 23, 'CHECK_OUT'),
        punch(2, 24, 'CHECK_OUT', 900),
      ]);
      const res = await service.summary(9, undefined, NOW);
      const day = {
        gte: new Date('2026-10-26T15:00:00Z'),
        lt: new Date('2026-10-27T15:00:00Z'),
      };
      expect(firstArg(prisma.workSchedule.findMany).where).toMatchObject({
        startAt: day,
      });
      expect(andOf(firstArg(prisma.attendanceRecord.findMany))[0]).toEqual({
        storeId: { in: [1, 2] },
        recordedAt: day,
      });
      expect(firstArg(prisma.workSchedule.findMany).orderBy).toEqual([
        { staffMemberId: 'asc' },
        { startAt: 'asc' },
      ]);
      expect(res.cards!.todayAttendance).toEqual({
        scheduled: 6,
        checkedIn: 2,
        notCheckedIn: 2,
      });
      const store1 = res.storeTable.items.find((r) => r.storeId === 1)!;
      expect([store1.checkedInCount, store1.scheduledCount]).toEqual([1, 2]);
    });

    it('오늘 출근 — 본사 역할에게 출근 · 미출근은 동의한 직원만, 근무 예정은 그대로 센다(운영 정책 ATT-30 v217)', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 1, storeTypeCode: 'DIRECT' },
          { storeId: 2, storeTypeCode: 'FRANCHISE' },
        ],
      });
      const before = new Date(NOW.getTime() - HOUR);
      prisma.workSchedule.findMany.mockResolvedValue([
        schedule(1, 10, before),
        schedule(2, 20, before), // 동의 안 함 — 미출근에 들지 않는다
        schedule(2, 21, before, true),
      ]);
      const res = await service.summary(9, undefined, NOW);
      expect(andOf(firstArg(prisma.attendanceRecord.findMany))).toContainEqual({
        staffMember: SHOWN_STAFF,
      });
      expect(res.cards!.todayAttendance).toEqual({
        scheduled: 3,
        checkedIn: 0,
        notCheckedIn: 2,
      });
      const store2 = res.storeTable.items.find((r) => r.storeId === 2)!;
      expect([store2.checkedInCount, store2.scheduledCount]).toEqual([0, 2]);
    });

    it('내 문의 — 내가 쓴 문의의 답변 대기(접수 · 처리중) · 답변완료', async () => {
      prisma.inquiry.groupBy.mockResolvedValue([
        { status: 'RECEIVED', _count: { _all: 1 } },
        { status: 'IN_PROGRESS', _count: { _all: 2 } },
        { status: 'ANSWERED', _count: { _all: 4 } },
      ]);
      const res = await service.summary(9, undefined, NOW);
      expect(firstArg(prisma.inquiry.groupBy).where).toEqual({ createdBy: 9 });
      expect(res.cards!.myInquiries).toEqual({ waiting: 3, answered: 4 });
    });

    it('미조치 — 서명 대기 + 수정 요청 + 소속 확인 거절 + 긴급 TO-DO 미완료(배정 그룹은 한 줄). 발송 대기는 미체결에만', async () => {
      prisma.contract.groupBy.mockResolvedValue([
        { storeId: 1, status: 'PENDING_SEND', _count: { _all: 5 } },
        { storeId: 1, status: 'PENDING_SIGNATURE', _count: { _all: 2 } },
        { storeId: 2, status: 'CORRECTION_REQUESTED', _count: { _all: 1 } },
      ]);
      prisma.staffMember.findMany.mockResolvedValue([
        rejectedStaff(2, '이준호', date('2026-10-20')),
      ]);
      prisma.todo.findMany.mockResolvedValue([
        { todoId: 1, assignmentGroupId: 7, storeId: 2, title: 'a' },
        { todoId: 2, assignmentGroupId: 7, storeId: 2, title: 'a' },
        { todoId: 3, assignmentGroupId: null, storeId: 2, title: 'b' },
      ]);
      const res = await service.summary(9, undefined, NOW);
      expect(res.cards!.unsignedContractCount).toBe(8);
      const byId = new Map(res.storeTable.items.map((r) => [r.storeId, r]));
      expect(byId.get(1)).toMatchObject({
        unsignedContractCount: 7,
        pendingActionCount: 2,
      });
      expect(byId.get(2)).toMatchObject({
        unsignedContractCount: 1,
        pendingActionCount: 1 + 1 + 2,
      });
    });

    it('표 — 미조치 많은 순, 같으면 점포명. 일곱 곳과 전체 수', async () => {
      const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'BM',
        stores: ids.map((storeId) => ({ storeId, storeTypeCode: 'DIRECT' })),
      });
      const names = ['다', '가', '나', '라', '마', '바', '사', '아', '자'];
      prisma.store.findMany.mockResolvedValue(
        ids.map((storeId, i) => ({
          storeId,
          name: names[i],
          storeTypeCode: 'DIRECT',
        })),
      );
      prisma.contract.groupBy.mockResolvedValue([
        { storeId: 9, status: 'PENDING_SIGNATURE', _count: { _all: 3 } },
        { storeId: 4, status: 'PENDING_SIGNATURE', _count: { _all: 1 } },
      ]);
      const res = await service.summary(9, undefined, NOW);
      expect(res.storeTable.total).toBe(9);
      expect(res.storeTable.items.map((r) => r.storeName)).toEqual([
        '자',
        '라',
        '가',
        '나',
        '다',
        '마',
        '바',
      ]);
    });

    it('권한이 없는 영역은 null, 미조치에서도 뺀다', async () => {
      denied = new Set([
        '/contracts',
        '/attendance-records',
        '/support-inquiries',
      ]);
      prisma.contract.groupBy.mockResolvedValue([
        { storeId: 1, status: 'PENDING_SIGNATURE', _count: { _all: 2 } },
      ]);
      prisma.todo.findMany.mockResolvedValue([
        { todoId: 1, assignmentGroupId: null, storeId: 1, title: 'a' },
      ]);
      const res = await service.summary(9, undefined, NOW);
      expect(res.cards).toMatchObject({
        unsignedContractCount: null,
        todayAttendance: null,
        myInquiries: null,
      });
      expect(res.cards!.staff).not.toBeNull();
      expect(res.storeTable.items[0]).toMatchObject({
        storeId: 1,
        unsignedContractCount: null,
        checkedInCount: null,
        scheduledCount: null,
        pendingActionCount: 1,
      });
      expect(prisma.contract.groupBy).not.toHaveBeenCalled();
      expect(prisma.workSchedule.findMany).not.toHaveBeenCalled();
      expect(prisma.inquiry.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('pending', () => {
    it('경고 밴드 — 종료일이 한국 날짜 오늘부터 7일 안인 갱신 예정(하루 배치와 같은 대상 규칙)', async () => {
      prisma.contract.findMany.mockResolvedValueOnce([
        {
          contractId: 5,
          storeId: 1,
          endDate: date('2026-11-01'),
          staffMember: {
            staffMemberId: 50,
            name: '서지안',
            retiredDate: null,
            account: null,
            contracts: [],
          },
        },
        // 같은 직원에게 새 계약이 진행 중 — 이미 갱신했다
        {
          contractId: 6,
          storeId: 1,
          endDate: date('2026-11-02'),
          staffMember: {
            staffMemberId: 60,
            name: '문태경',
            retiredDate: null,
            account: null,
            contracts: [
              { contractId: 7, status: 'PENDING_SIGNATURE', endDate: null },
            ],
          },
        },
      ]);
      const res = await service.pending(9, undefined, NOW);
      expect(firstArg(prisma.contract.findMany).where).toEqual({
        AND: [
          {
            status: 'SIGNED',
            endDate: { gte: TODAY, lte: date('2026-11-03') },
            staffMember: { employmentStatus: 'EMPLOYED' },
          },
          { storeId: { in: [1, 2] } },
        ],
      });
      expect(res.renewals).toEqual([
        {
          contractId: 5,
          staffMemberId: 50,
          name: '서지안',
          isMasked: false,
          storeId: 1,
          storeName: '성수점',
          endDate: '2026-11-01',
        },
      ]);
      expect(res.items[0]).toMatchObject({
        type: 'CONTRACT_RENEWAL',
        count: 1,
        waitingDays: null,
        filter: { storeIds: [1], status: ['SIGNED'] },
      });
    });

    it('순서는 갱신 예정 → 계약 → 직원 → 문의 → TO-DO, 0건 유형은 뺀다', async () => {
      prisma.contract.findMany
        .mockResolvedValueOnce([]) // 갱신 예정 없음
        .mockResolvedValueOnce([
          {
            storeId: 1,
            status: 'PENDING_SIGNATURE',
            sentAt: date('2026-10-23'),
            staffMember: { name: '박하늘', account: null },
            contractStatusHistories: [],
          },
          {
            storeId: 1,
            status: 'PENDING_SIGNATURE',
            sentAt: date('2026-10-21'),
            staffMember: { name: '남도현', account: null },
            contractStatusHistories: [],
          },
        ]);
      prisma.todo.findMany.mockResolvedValue([
        {
          todoId: 1,
          assignmentGroupId: null,
          storeId: 2,
          title: '냉장고 재료 폐기',
          createdAt: date('2026-10-26'),
        },
      ]);
      prisma.staffMember.findMany.mockResolvedValue([
        rejectedStaff(1, '이준호', date('2026-10-25')),
      ]);
      const res = await service.pending(9, undefined, NOW);
      expect(res.items.map((i) => i.type)).toEqual([
        'CONTRACT_PENDING_SIGNATURE',
        'AFFILIATION_REJECTED',
        'URGENT_TODO',
      ]);
      // 가장 오래 기다린 사람이 대표, 서명 대기는 발송 뒤 경과 일수
      expect(res.items[0]).toEqual({
        type: 'CONTRACT_PENDING_SIGNATURE',
        count: 2,
        firstName: '남도현',
        isFirstNameMasked: false,
        othersCount: 1,
        waitingDays: 6,
        filter: { storeIds: [1], status: ['PENDING_SIGNATURE'] },
      });
      expect(res.items[1]).toMatchObject({
        firstName: '이준호',
        waitingDays: 2,
        filter: { storeIds: [1], status: ['REJECTED'] },
      });
    });

    it('본사 역할 — 가려지는 점포의 계약 · 갱신 예정 · 소속 확인 거절은 동의한 직원 것만 센다(근로계약 목록과 같은 조건)', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 1, storeTypeCode: 'DIRECT' },
          { storeId: 2, storeTypeCode: 'FRANCHISE' },
        ],
      });
      await service.pending(9, undefined, NOW);
      const [renewal, waiting] = prisma.contract.findMany.mock.calls.map(
        (c) => (c as [Record<string, any>])[0],
      );
      expect(andOf(renewal)).toContainEqual(SHOWN_CONTRACT);
      expect(andOf(waiting)).toContainEqual(SHOWN_CONTRACT);
      expect(andOf(firstArg(prisma.staffMember.findMany))).toContainEqual(
        SHOWN_STAFF,
      );
    });

    it('본사 역할 — summary 의 미체결 · 미조치 · 정직원/파트 나눔도 같은 조건이고, 재직 직원 총수는 그대로 센다(운영 정책 ATT-30)', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'BA',
        stores: [
          { storeId: 1, storeTypeCode: 'DIRECT' },
          { storeId: 2, storeTypeCode: 'FRANCHISE' },
        ],
      });
      await service.summary(9, undefined, NOW);
      const [totals, split] = prisma.staffMember.groupBy.mock.calls.map(
        (c) => (c as [Record<string, any>])[0],
      );
      expect(totals.where).toMatchObject({ storeId: { in: [1, 2] } });
      expect(totals.where).not.toHaveProperty('AND');
      expect(andOf(split)).toContainEqual(SHOWN_STAFF);
      expect(andOf(firstArg(prisma.contract.groupBy))).toContainEqual(
        SHOWN_CONTRACT,
      );
      expect(andOf(firstArg(prisma.staffMember.findMany))).toContainEqual(
        SHOWN_STAFF,
      );
    });

    it('문의 — 내가 쓴 답변완료 문의 중 마지막 답변이 한국 날짜 7일 전 0시 이후인 것', async () => {
      const boundary = new Date('2026-10-19T15:00:00Z'); // 2026-10-20 한국 0시
      prisma.inquiryReply.groupBy.mockResolvedValue([
        { inquiryId: 1, _max: { repliedAt: boundary } },
        { inquiryId: 2, _max: { repliedAt: new Date(boundary.getTime() - 1) } },
      ]);
      prisma.inquiry.findMany.mockResolvedValue([
        { inquiryId: 1, title: 'KIOSK 영수증 프린터 연동 문의' },
      ]);
      const res = await service.pending(9, undefined, NOW);
      expect(firstArg(prisma.inquiryReply.groupBy)).toMatchObject({
        where: { inquiry: { createdBy: 9, status: 'ANSWERED' } },
        _max: { repliedAt: true },
      });
      expect(firstArg(prisma.inquiry.findMany).where).toEqual({
        inquiryId: { in: [1] },
      });
      expect(res.items).toEqual([
        {
          type: 'INQUIRY_ANSWERED',
          count: 1,
          firstName: 'KIOSK 영수증 프린터 연동 문의',
          isFirstNameMasked: false,
          othersCount: 0,
          waitingDays: 7,
          filter: { storeIds: [], status: ['ANSWERED'] },
        },
      ]);
    });

    it('권한이 없는 영역은 처리 대기에서 빠지고 경고 밴드는 null', async () => {
      denied = new Set(['/contracts', '/staff-members', '/todos']);
      prisma.todo.findMany.mockResolvedValue([
        { todoId: 1, assignmentGroupId: null, storeId: 1, title: 'a' },
      ]);
      const res = await service.pending(9, undefined, NOW);
      expect(res).toEqual({
        asOf: NOW,
        platform: false,
        renewals: null,
        items: [],
      });
      expect(prisma.contract.findMany).not.toHaveBeenCalled();
      expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
      expect(prisma.todo.findMany).not.toHaveBeenCalled();
    });
  });
});

describe('openRejectionAt (소속 확인 거절의 「새 진행」 판정)', () => {
  const rejectedAt = new Date('2026-10-20T03:00:00Z');
  const row = (over: Partial<Parameters<typeof openRejectionAt>[0]> = {}) => ({
    retiredDate: null,
    invitations: [
      {
        invitationType: 'RETURN_CONFIRM' as const,
        status: 'REJECTED',
        sentAt: new Date('2026-10-18T03:00:00Z'),
        respondedAt: rejectedAt,
      },
    ],
    contracts: [{ createdAt: new Date('2026-10-18T02:00:00Z') }],
    ...over,
  });

  it('마지막 초대가 소속 확인 거절이고 새 진행이 없으면 거절 시각', () => {
    expect(openRejectionAt(row())).toEqual(rejectedAt);
  });

  it('재발송 · 재초대로 마지막 초대가 바뀌면 닫힌다', () => {
    expect(
      openRejectionAt(
        row({
          invitations: [
            {
              invitationType: 'AFFILIATION_CONFIRM',
              status: 'SENT',
              sentAt: new Date('2026-10-21T00:00:00Z'),
              respondedAt: null,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('거절보다 늦게 만든 근로계약이 있으면 닫힌다', () => {
    expect(
      openRejectionAt(
        row({ contracts: [{ createdAt: new Date('2026-10-20T03:00:01Z') }] }),
      ),
    ).toBeNull();
  });

  it('퇴직 처리(퇴직일이 정해짐)면 닫힌다', () => {
    expect(
      openRejectionAt(row({ retiredDate: new Date('2026-10-31T00:00:00Z') })),
    ).toBeNull();
  });

  it('가입 초대의 거절은 소속 확인 거절이 아니다', () => {
    expect(
      openRejectionAt(
        row({
          invitations: [
            {
              invitationType: 'SIGNUP',
              status: 'REJECTED',
              sentAt: rejectedAt,
              respondedAt: rejectedAt,
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
