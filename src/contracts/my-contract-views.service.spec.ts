import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MyContractViewsService } from './my-contract-views.service';

const NOW = new Date('2026-10-21T05:00:00.000Z');
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

/** 직원 앱 근로계약 목록 · 상세(WHALEERP-610) */
describe('MyContractViewsService', () => {
  let tx: {
    contract: { findMany: jest.Mock; findFirst: jest.Mock };
    store: { findMany: jest.Mock; findUnique: jest.Mock };
    contractDocument: { findMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  const service = () =>
    new MyContractViewsService(prisma as unknown as PrismaService);

  /** 목록 한 줄 — 기본은 날인을 기다리는 서명 대기 */
  const row = (o: Record<string, unknown> = {}) => ({
    contractId: 41,
    status: 'PENDING_SIGNATURE',
    storeId: 11,
    employmentType: 'PART_TIME',
    contractMethod: 'ELECTRONIC',
    startDate: day('2026-11-01'),
    endDate: null,
    sentAt: new Date('2026-10-20T01:00:00.000Z'),
    signDeadlineAt: new Date('2026-11-19T01:00:00.000Z'),
    contractStatusHistories: [
      {
        toStatus: 'PENDING_SIGNATURE',
        changedAt: new Date('2026-10-20T01:00:00.000Z'),
      },
    ],
    staffMember: {
      employmentStatus: 'EMPLOYED',
      retiredDate: null,
      employmentType: 'FULL_TIME',
    },
    ...o,
  });

  beforeEach(() => {
    tx = {
      contract: { findMany: jest.fn(), findFirst: jest.fn() },
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 11, name: '웨일 카페 홍대점' },
          { storeId: 12, name: '웨일 카페 합정점' },
        ]),
        findUnique: jest.fn(),
      },
      contractDocument: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma = {
      $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    };
  });

  describe('목록', () => {
    it('내 계정에 이어진 직원 레코드의 서명 대기 이후 계약만 읽는다 — 임시저장 · 발송 대기 · 후보 계정 계약은 없다', async () => {
      tx.contract.findMany.mockResolvedValue([]);
      await expect(service().list(77, NOW)).resolves.toEqual({
        items: [],
        total: 0,
      });
      const [args] = tx.contract.findMany.mock.calls[0] as [
        Prisma.ContractFindManyArgs,
      ];
      expect(args.where).toEqual({
        status: {
          in: [
            'PENDING_SIGNATURE',
            'CORRECTION_REQUESTED',
            'SIGNED',
            'REJECTED',
            'EXPIRED',
            'ENDED',
          ],
        },
        staffMember: { accountId: 77 },
      });
    });

    it('한 줄 — 근무지 이름 · 날짜 · 지금 상태가 된 시각 · 날인을 기다리는지', async () => {
      tx.contract.findMany.mockResolvedValue([row()]);
      const { items } = await service().list(77, NOW);
      expect(items).toEqual([
        {
          contractId: 41,
          status: 'PENDING_SIGNATURE',
          storeId: 11,
          storeName: '웨일 카페 홍대점',
          employmentType: 'PART_TIME',
          contractMethod: 'ELECTRONIC',
          startDate: '2026-11-01',
          endDate: null,
          sentAt: '2026-10-20T01:00:00.000Z',
          signDeadlineAt: '2026-11-19T01:00:00.000Z',
          processedAt: '2026-10-20T01:00:00.000Z',
          awaitingSignature: true,
        },
      ]);
    });

    it.each<[string, Record<string, unknown>]>([
      ['날인 기한이 지났으면', { signDeadlineAt: NOW }],
      [
        '퇴직했으면',
        {
          staffMember: {
            employmentStatus: 'RETIRED',
            retiredDate: day('2026-10-01'),
          },
        },
      ],
      [
        '퇴직일이 지났으면(배치 전)',
        {
          staffMember: {
            employmentStatus: 'EMPLOYED',
            retiredDate: day('2026-10-20'),
          },
        },
      ],
      ['서명 대기가 아니면', { status: 'CORRECTION_REQUESTED' }],
    ])(
      '%s 날인을 기다리지 않는다 — 날인 API 와 같은 판정',
      async (_label, o) => {
        tx.contract.findMany.mockResolvedValue([row(o)]);
        const { items } = await service().list(77, NOW);
        expect(items[0].awaitingSignature).toBe(false);
      },
    );

    it('마지막 이력이 지금 상태가 아니면 처리 시각은 비운다', async () => {
      tx.contract.findMany.mockResolvedValue([
        row({
          status: 'SIGNED',
          contractStatusHistories: [
            { toStatus: 'PENDING_SIGNATURE', changedAt: NOW },
          ],
        }),
      ]);
      const { items } = await service().list(77, NOW);
      expect(items[0].processedAt).toBeNull();
    });

    it('서명 대기면 처리 시각은 마지막 발송 시각 — 서명 대기 그대로 다시 보내면 이력이 쌓이지 않는다', async () => {
      tx.contract.findMany.mockResolvedValue([
        row({ sentAt: new Date('2026-10-21T02:00:00.000Z') }),
      ]);
      const { items } = await service().list(77, NOW);
      expect(items[0].processedAt).toBe('2026-10-21T02:00:00.000Z');
    });

    it('계약의 고용 형태가 비어 있으면 직원 레코드 값 — 관리자 상세와 같다', async () => {
      tx.contract.findMany.mockResolvedValue([row({ employmentType: null })]);
      const { items } = await service().list(77, NOW);
      expect(items[0].employmentType).toBe('FULL_TIME');
    });

    it('기한이 없는 날인 대기는 뒤로, 처리 시각이 없으면 발송 일시로 줄 세운다', async () => {
      tx.contract.findMany.mockResolvedValue([
        row({ contractId: 1, signDeadlineAt: null }),
        row({ contractId: 2 }),
        row({
          contractId: 3,
          status: 'SIGNED',
          contractStatusHistories: [],
          sentAt: new Date('2026-10-19T00:00:00.000Z'),
        }),
        row({
          contractId: 4,
          status: 'SIGNED',
          contractStatusHistories: [
            {
              toStatus: 'SIGNED',
              changedAt: new Date('2026-10-18T00:00:00.000Z'),
            },
          ],
        }),
      ]);
      const { items } = await service().list(77, NOW);
      expect(items.map((i) => i.contractId)).toEqual([2, 1, 3, 4]);
    });

    it('날인을 기다리는 계약을 기한이 급한 순으로 먼저, 그다음 최근 것부터', async () => {
      const at = (iso: string) => [
        { toStatus: 'SIGNED', changedAt: new Date(iso) },
      ];
      tx.contract.findMany.mockResolvedValue([
        row({
          contractId: 1,
          status: 'SIGNED',
          contractStatusHistories: at('2026-09-01T00:00:00.000Z'),
        }),
        row({
          contractId: 2,
          signDeadlineAt: new Date('2026-11-30T00:00:00.000Z'),
        }),
        row({
          contractId: 3,
          status: 'SIGNED',
          storeId: 12,
          contractStatusHistories: at('2026-10-01T00:00:00.000Z'),
        }),
        row({
          contractId: 4,
          signDeadlineAt: new Date('2026-11-10T00:00:00.000Z'),
        }),
      ]);
      const { items, total } = await service().list(77, NOW);
      expect(items.map((i) => i.contractId)).toEqual([4, 2, 3, 1]);
      expect(total).toBe(4);
      expect(items[2].storeName).toBe('웨일 카페 합정점');
    });
  });

  describe('상세', () => {
    const party = {
      enteredName: '홍길동',
      enteredPhone: '01090145563',
      enteredBirthDate: day('1995-03-02'),
      enteredGender: 'FEMALE',
      isForeigner: false,
      zipCode: null,
      address: null,
      addressDetail: null,
    };
    const account = {
      realName: '홍 길동',
      phone: '010-9014-5563',
      birthDate: day('1995-03-02'),
      gender: 'FEMALE',
      isForeigner: false,
      zipCode: '04001',
      address: '서울 마포구 동교로 1',
      addressDetail: '2층',
    };
    /** 상세 행 — 근무 조건은 관리자 상세와 같은 칸(contract-terms) */
    const detail = (o: Record<string, unknown> = {}) => ({
      ...row(),
      workLocation: '홍대점',
      weeklyHoliday: 'SUN',
      wageAmount: 10030,
      mealAllowanceAmount: null,
      carAllowanceAmount: null,
      childcareAllowanceAmount: null,
      baseHours: new Prisma.Decimal(60.5),
      monthlyOvertimeHours: null,
      baseNightHours: null,
      baseHolidayHours: null,
      monthlyExtraHolidayHours: null,
      annualLeaveTerms: '근로기준법에 따른다',
      severancePayTerms: null,
      payMonth: 'NEXT_MONTH',
      payDay: 10,
      payMethod: 'ACCOUNT',
      probationMonths: null,
      probationWageReductionRate: null,
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: true,
      contractWorkDays: [
        {
          weekday: 'TUE',
          startTime: new Date('1970-01-01T10:00:00.000Z'),
          endTime: new Date('1970-01-01T16:00:00.000Z'),
          breakStartTime: new Date('1970-01-01T12:00:00.000Z'),
          breakEndTime: new Date('1970-01-01T13:00:00.000Z'),
        },
      ],
      contractParty: party,
      staffMember: {
        employmentStatus: 'EMPLOYED',
        retiredDate: null,
        jobTitle: '바리스타',
        name: '홍길동',
        phone: '01090145563',
        account,
      },
      ...o,
    });
    const store = (o: Record<string, unknown> = {}) => ({
      name: '웨일 카페 홍대점',
      phone: '0212345678',
      zipCode: '04002',
      address: '서울 마포구 와우산로 1',
      addressDetail: '1층',
      businessProfile: {
        bizTradeName: '웨일 카페',
        bizRegistrationNumber: '1234567890',
        bizCeoName: '김대표',
        bizZipCode: '04003',
        bizAddress: '서울 마포구 양화로 1',
        bizAddressDetail: null,
      },
      ...o,
    });

    beforeEach(() => {
      tx.contract.findFirst.mockResolvedValue(detail());
      tx.store.findUnique.mockResolvedValue(store());
    });

    it('계약서에 그릴 값 · 근로자 칸 · 사용자 칸 · 본인인증 정보, 본인 대조가 맞으면 날인할 수 있다', async () => {
      const d = await service().findOne(77, 41, NOW);
      expect(d).toMatchObject({
        contractId: 41,
        status: 'PENDING_SIGNATURE',
        storeName: '웨일 카페 홍대점',
        sentAt: '2026-10-20T01:00:00.000Z',
        awaitingSignature: true,
        signable: true,
        mismatches: [],
        workLocation: '홍대점',
        baseHours: 60.5,
        startDate: '2026-11-01',
        workDays: [
          {
            weekday: 'TUE',
            startTime: '10:00',
            endTime: '16:00',
            breakStartTime: '12:00',
            breakEndTime: '13:00',
          },
        ],
        worker: {
          name: '홍길동',
          phone: '01090145563',
          birthDate: '1995-03-02',
          gender: 'FEMALE',
          isForeigner: false,
          jobTitle: '바리스타',
          address: null,
        },
        employer: {
          storeName: '웨일 카페 홍대점',
          storePhone: '0212345678',
          tradeName: '웨일 카페',
          registrationNumber: '1234567890',
          ceoName: '김대표',
          bizAddress: '서울 마포구 양화로 1',
        },
        account: {
          name: '홍 길동',
          phone: '010-9014-5563',
          birthDate: '1995-03-02',
          address: '서울 마포구 동교로 1',
        },
        documents: [],
      });
      const [args] = tx.contract.findFirst.mock.calls[0] as [
        Prisma.ContractFindFirstArgs,
      ];
      expect(args.where).toMatchObject({
        contractId: 41,
        staffMember: { accountId: 77 },
      });
      // 직원 필기 서명은 싣지 않고, 보낸 원본은 지금 발송분만 — 고쳐 다시 보내기 전 원본에는 다른 사람 정보가 있을 수 있다
      // (api #211 리뷰)
      expect(tx.contractDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            contractId: 41,
            kind: { not: 'SIGNATURE' },
            OR: [
              { kind: { not: 'SENT_ORIGINAL' } },
              { sentAt: new Date('2026-10-20T01:00:00.000Z') },
            ],
          },
        }),
      );
    });

    it('본인 대조가 틀리면 다른 항목을 싣고 날인할 수 없다 — 날인 API 의 409 IDENTITY_MISMATCH 와 같은 항목', async () => {
      tx.contract.findFirst.mockResolvedValue(
        detail({ contractParty: { ...party, enteredPhone: '01011112222' } }),
      );
      const d = await service().findOne(77, 41, NOW);
      expect(d).toMatchObject({
        awaitingSignature: true,
        signable: false,
        mismatches: ['phone'],
      });
    });

    it('당사자 행이 없으면 빈 계약서로 대조한다', async () => {
      tx.contract.findFirst.mockResolvedValue(detail({ contractParty: null }));
      const d = await service().findOne(77, 41, NOW);
      expect(d.mismatches).toEqual(['name', 'phone', 'birthDate', 'gender']);
      // 근로자 칸은 직원 레코드 값으로 채운다 — 관리자 상세와 같다
      expect(d.worker).toMatchObject({
        name: '홍길동',
        phone: '01090145563',
        birthDate: null,
        isForeigner: false,
      });
    });

    it('체결 완료면 날인을 기다리지 않는다 — 대조가 맞아도 signable 은 false', async () => {
      tx.contract.findFirst.mockResolvedValue(detail({ status: 'SIGNED' }));
      const d = await service().findOne(77, 41, NOW);
      expect(d).toMatchObject({ awaitingSignature: false, signable: false });
    });

    it('조항은 PDF 와 같은 템플릿으로 싣는다(WHALEERP-131) — 근무 장소 · 직무 · 요일 표', async () => {
      const d = await service().findOne(77, 41, NOW);
      expect(d.articles).toHaveLength(10);
      expect(d.articles[1]).toEqual({
        title: '제2조(근무장소와 업무)',
        blocks: [{ type: 'TEXT', text: '홍대점에서 바리스타 업무를 한다.' }],
      });
      expect(d.articles[2].blocks[1]).toMatchObject({
        type: 'TABLE',
        tableRows: expect.arrayContaining([
          {
            cells: ['화', '10:00', '16:00', '12:00–13:00', '5시간'],
            off: false,
          },
        ]) as unknown,
      });
    });

    it('날인한 계약은 사용자 칸을 날인 때 고정한 값으로 준다 — 처리 완료본과 같다(WHALEERP-131)', async () => {
      tx.contract.findFirst.mockResolvedValue(
        detail({
          status: 'SIGNED',
          contractParty: {
            ...party,
            employerName: '옛 상호',
            employerCeoName: '옛 대표',
            employerRegistrationNumber: '9998887776',
            employerAddress: '옛 주소',
            employerAddressDetail: '3층',
            employerPhone: '0299990000',
            employerFixedAt: NOW,
            fixedWorkLocation: '옛 근무 장소',
            fixedJobTitle: '옛 직무',
          },
        }),
      );
      const d = await service().findOne(77, 41, NOW);
      // 제2조 · 근로자 직무도 날인 때 고정한 값(2026-10-30 김민식)
      expect(d.articles[1].blocks[0]).toEqual({
        type: 'TEXT',
        text: '옛 근무 장소에서 옛 직무 업무를 한다.',
      });
      expect(d.worker.jobTitle).toBe('옛 직무');
      expect(d.employer).toMatchObject({
        storeName: '웨일 카페 홍대점',
        tradeName: '옛 상호',
        ceoName: '옛 대표',
        registrationNumber: '9998887776',
        bizAddress: '옛 주소',
        bizAddressDetail: '3층',
        storePhone: '0299990000',
      });
    });

    it('사업자 정보가 없으면 그 칸은 비운다', async () => {
      tx.store.findUnique.mockResolvedValue(store({ businessProfile: null }));
      const d = await service().findOne(77, 41, NOW);
      expect(d.employer).toMatchObject({
        storeName: '웨일 카페 홍대점',
        tradeName: null,
        registrationNumber: null,
        ceoName: null,
        bizAddress: null,
      });
    });

    it('내 계약이 아니면 404 — 점포 · 파일을 읽지 않는다', async () => {
      tx.contract.findFirst.mockResolvedValue(null);
      await expect(service().findOne(77, 41, NOW)).rejects.toThrow(
        NotFoundException,
      );
      expect(tx.store.findUnique).not.toHaveBeenCalled();
      expect(tx.contractDocument.findMany).not.toHaveBeenCalled();
    });

    it('점포 행이 없으면 데이터가 깨진 것이라 500', async () => {
      tx.store.findUnique.mockResolvedValue(null);
      await expect(service().findOne(77, 41, NOW)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
