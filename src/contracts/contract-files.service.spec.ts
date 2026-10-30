import { Prisma } from '@prisma/client';
import { ContractFilesService, pdfInputOf } from './contract-files.service';
import { renderContractPdf } from './contract-pdf';

jest.mock('./contract-pdf', () => ({
  ...jest.requireActual<typeof import('./contract-pdf')>('./contract-pdf'),
  renderContractPdf: jest.fn(() => Promise.resolve(Buffer.from('%PDF-1.3'))),
}));

const SENT_AT = new Date('2026-10-20T01:00:00Z');
const SIGNED_AT = new Date('2026-10-22T03:00:00Z');

const party = {
  enteredName: '홍길동',
  enteredPhone: '01012345678',
  enteredBirthDate: new Date('2000-01-02T00:00:00Z'),
  address: '서울 마포구',
  addressDetail: '101호',
  employerName: null as string | null,
  employerCeoName: null as string | null,
  employerRegistrationNumber: null as string | null,
  employerAddress: null as string | null,
  employerAddressDetail: null as string | null,
  employerPhone: null as string | null,
  employerFixedAt: null as Date | null,
  fixedWorkLocation: null as string | null,
  fixedJobTitle: null as string | null,
};

const contractRow = (over: Record<string, unknown> = {}) => ({
  startDate: new Date('2026-11-01T00:00:00Z'),
  endDate: null,
  workLocation: null,
  weeklyHoliday: null,
  wageAmount: 10320,
  mealAllowanceAmount: null,
  carAllowanceAmount: null,
  childcareAllowanceAmount: null,
  baseHours: null,
  monthlyOvertimeHours: null,
  baseNightHours: null,
  baseHolidayHours: null,
  monthlyExtraHolidayHours: null,
  annualLeaveTerms: null,
  severancePayTerms: null,
  payMonth: null,
  payDay: null,
  payMethod: null,
  probationMonths: null,
  probationWageReductionRate: null,
  isHealthPensionInsured: false,
  isEmploymentInjuryInsured: false,
  contractWorkDays: [],
  employmentType: 'PART_TIME',
  jobTitle: '홀',
  storeId: 3,
  sentAt: SENT_AT,
  contractMethod: 'ELECTRONIC',
  staffMember: { name: '레코드 이름', phone: '01000000000', jobTitle: null },
  contractParty: party,
  ...over,
});

const store = {
  name: '강남점',
  phone: '0212345678',
  businessProfile: {
    bizTradeName: '고래상회',
    bizRegistrationNumber: '1234567890',
    bizCeoName: '김대표',
    bizAddress: '서울 강남구',
    bizAddressDetail: '2층',
  },
};

function setup(
  over: {
    contract?: Record<string, unknown> | null;
    documents?: { kind: string; storageKey: string; sentAt: Date | null }[];
    create?: jest.Mock;
  } = {},
) {
  const tx = {
    contract: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          over.contract === null ? null : contractRow(over.contract),
        ),
    },
    store: { findUnique: jest.fn().mockResolvedValue(store) },
    contractDocument: {
      findMany: jest.fn().mockResolvedValue(
        over.documents ?? [
          {
            kind: 'SIGNATURE',
            storageKey: 'contracts/1/sig.png',
            sentAt: null,
          },
        ],
      ),
    },
    contractStatusHistory: {
      findFirst: jest.fn().mockResolvedValue({ changedAt: SIGNED_AT }),
    },
    contractParty: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const create = over.create ?? jest.fn().mockResolvedValue({});
  // 파일 행 쓰기(와 백필 값 적기)도 트랜잭션 안이다
  Object.assign(tx.contractDocument, { create });
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    contractDocument: {
      create,
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const storage = {
    get: jest.fn().mockResolvedValue(Buffer.from('png')),
    put: jest.fn<Promise<void>, [string, Buffer, string]>(() =>
      Promise.resolve(),
    ),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ContractFilesService(prisma as never, storage as never);
  return { service, prisma, storage, create, tx };
}

describe('pdfInputOf', () => {
  const source = (p: Partial<typeof party>) => ({
    contract: {
      ...contractRow({ contractParty: { ...party, ...p } }),
      contractId: 1,
    } as never,
    store,
    signedAt: SIGNED_AT,
  });

  it('처리 완료본은 날인 때 고정한 사용자 칸을 쓴다', () => {
    const input = pdfInputOf(
      'SIGNED_COPY',
      source({
        employerName: '옛 상호',
        employerCeoName: '옛 대표',
        employerRegistrationNumber: '1234567890',
        employerAddress: '옛 주소',
        employerAddressDetail: null,
        employerPhone: '0299998888',
        employerFixedAt: SIGNED_AT,
        fixedWorkLocation: '옛 점포명',
        fixedJobTitle: '옛 직무',
      }),
    );
    expect(input.employerFixed).toBe(true);
    // 제2조도 날인 때 고정한 근무 장소 · 직무(2026-10-30 김민식)
    expect(input.articles[1].blocks[0]).toEqual({
      type: 'TEXT',
      text: '옛 점포명에서 옛 직무 업무를 한다.',
    });
    expect(input.employer).toEqual({
      name: '옛 상호',
      ceoName: '옛 대표',
      registrationNumber: '1234567890',
      address: '옛 주소',
      addressDetail: null,
      phone: '0299998888',
    });
  });

  it('고정 전에 체결된 계약 · 보낸 원본은 지금 점포 정보(상호 없으면 점포명)', () => {
    const fixed = {
      employerName: '옛 상호',
      employerFixedAt: SIGNED_AT,
    };
    expect(pdfInputOf('SIGNED_COPY', source({})).employer).toEqual({
      name: '고래상회',
      ceoName: '김대표',
      registrationNumber: '1234567890',
      address: '서울 강남구',
      addressDetail: '2층',
      phone: '0212345678',
    });
    expect(pdfInputOf('SIGNED_COPY', source({})).employerFixed).toBe(false);
    expect(pdfInputOf('SENT_ORIGINAL', source(fixed)).employer.name).toBe(
      '고래상회',
    );
    expect(
      pdfInputOf('SENT_ORIGINAL', {
        ...source({}),
        store: { ...store, businessProfile: null },
      }).employer.name,
    ).toBe('강남점');
  });

  it('보낸 원본은 근로자 주소를 비운다 — 날인 때 고정한 값이라 보낼 때는 없었다', () => {
    expect(pdfInputOf('SENT_ORIGINAL', source({})).worker).toMatchObject({
      name: '홍길동',
      address: null,
      addressDetail: null,
    });
  });

  it('근로자 칸은 계약서에 적은 값', () => {
    expect(pdfInputOf('SIGNED_COPY', source({})).worker).toEqual({
      name: '홍길동',
      birthDate: '2000-01-02',
      address: '서울 마포구',
      addressDetail: '101호',
      phone: '01012345678',
    });
  });
});

describe('ContractFilesService.make', () => {
  beforeEach(() => jest.mocked(renderContractPdf).mockClear());

  it('처리 완료본 — 서명을 합성해 올리고 발송 일시와 함께 행을 만든다', async () => {
    const { service, storage, create } = setup();
    await expect(service.make('SIGNED_COPY', 1)).resolves.toBe('CREATED');
    expect(storage.get).toHaveBeenCalledWith('contracts/1/sig.png');
    expect(renderContractPdf).toHaveBeenCalledWith(
      expect.objectContaining({ signed: true }),
      Buffer.from('png'),
    );
    const key = storage.put.mock.calls[0][0];
    expect(key).toMatch(/^contracts\/1\/[0-9a-f-]{36}\.pdf$/);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contractId: 1,
        kind: 'SIGNED_COPY',
        storageKey: key,
        fileName: '근로계약서-처리완료본-1.pdf',
        sentAt: SENT_AT,
      }) as unknown,
    });
  });

  it('고정 전 체결 계약(백필)이면 만든 점포 정보를 당사자 행에 적는다 — 고정 일시는 비운 채(그 기록)', async () => {
    const { service, tx } = setup();
    await service.make('SIGNED_COPY', 1);
    expect(tx.contractParty.updateMany).toHaveBeenCalledWith({
      where: { contractId: 1, employerName: null },
      data: {
        employerName: '고래상회',
        employerCeoName: '김대표',
        employerRegistrationNumber: '1234567890',
        employerAddress: '서울 강남구',
        employerAddressDetail: '2층',
        employerPhone: '0212345678',
        // 근무 장소를 비운 계약은 만드는 때의 점포명, 직무는 계약 칸
        fixedWorkLocation: '강남점',
        fixedJobTitle: '홀',
      },
    });

    const fixed = setup({
      contract: {
        contractParty: {
          ...party,
          employerName: '날인 때 상호',
          employerFixedAt: SIGNED_AT,
        },
      },
    });
    await fixed.service.make('SIGNED_COPY', 1);
    expect(fixed.tx.contractParty.updateMany).not.toHaveBeenCalled();
  });

  it('서명이 없거나 종이 계약 · 발송 전이면 만들지 않는다', async () => {
    for (const s of [
      setup({ documents: [] }),
      setup({ contract: { contractMethod: 'PAPER' } }),
      setup({ contract: { sentAt: null } }),
      setup({ contract: null }),
    ]) {
      await expect(s.service.make('SIGNED_COPY', 1)).resolves.toBe('SKIPPED');
      expect(s.storage.put).not.toHaveBeenCalled();
    }
  });

  it('이미 처리 완료본이 있으면 EXISTS', async () => {
    const { service, storage } = setup({
      documents: [
        {
          kind: 'SIGNED_COPY',
          storageKey: 'contracts/1/a.pdf',
          sentAt: SENT_AT,
        },
        { kind: 'SIGNATURE', storageKey: 'contracts/1/sig.png', sentAt: null },
      ],
    });
    await expect(service.make('SIGNED_COPY', 1)).resolves.toBe('EXISTS');
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('보낸 원본 — 지금 발송분이 있으면 EXISTS, 앞 발송분만 있으면 새로 만든다(서명 없이)', async () => {
    const old = {
      kind: 'SENT_ORIGINAL',
      storageKey: 'contracts/1/o.pdf',
      sentAt: new Date('2026-10-01T00:00:00Z'),
    };
    const same = setup({ documents: [{ ...old, sentAt: SENT_AT }] });
    await expect(same.service.make('SENT_ORIGINAL', 1)).resolves.toBe('EXISTS');

    const resent = setup({ documents: [old] });
    await expect(resent.service.make('SENT_ORIGINAL', 1)).resolves.toBe(
      'CREATED',
    );
    expect(renderContractPdf).toHaveBeenLastCalledWith(
      expect.objectContaining({ signed: false }),
      null,
    );
    expect(resent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'SENT_ORIGINAL',
        fileName: '근로계약서-보낸원본-1-202610201000.pdf',
        sentAt: SENT_AT,
      }) as unknown,
    });
  });

  it('다른 실행이 먼저 만들었으면(고유 위반) 올린 파일을 지우고 EXISTS', async () => {
    const create = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const { service, storage } = setup({ create });
    await expect(service.make('SIGNED_COPY', 1)).resolves.toBe('EXISTS');
    expect(storage.delete).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
  });

  it('행 저장이 다른 까닭으로 실패하면 파일을 지우고 던진다', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));
    const { service, storage } = setup({ create });
    await expect(service.make('SIGNED_COPY', 1)).rejects.toThrow('db down');
    expect(storage.delete).toHaveBeenCalled();
  });
});

describe('ContractFilesService.fillMissing', () => {
  it('실패한 계약은 한 시간 미뤄 다음 실행에서 빼고 고른다 — 늘 실패하는 계약이 자리를 차지하지 않게', async () => {
    const prisma = {
      contract: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ contractId: 5 }])
          .mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ contract_id: 6 }]),
    };
    const service = new ContractFilesService(prisma as never, {} as never);
    const make = jest
      .spyOn(service, 'make')
      .mockResolvedValue('EXISTS')
      .mockRejectedValueOnce(new Error('서명 파일 없음'))
      .mockRejectedValueOnce(new Error('그릴 수 없는 이미지'));
    const now = new Date('2026-10-29T00:00:00Z');
    await expect(service.fillMissing(now)).resolves.toBe(0);
    expect(make).toHaveBeenCalledTimes(2);

    await service.fillMissing(new Date(now.getTime() + 10 * 60_000));
    // 보낸 원본 쪽도 미룬다 — 원시 쿼리 값에 미룬 계약(6)이 실린다
    expect(prisma.$queryRaw.mock.calls[1]).toContainEqual([6]);
    expect(prisma.contract.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contractId: { notIn: [5] },
        }) as unknown,
      }),
    );
    // 한 시간이 지나면 다시 고른다
    await service.fillMissing(new Date(now.getTime() + 61 * 60_000));
    expect(prisma.contract.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contractId: { notIn: [] },
        }) as unknown,
      }),
    );
  });
});

describe('ContractFilesService 저장소 없음', () => {
  it('배치는 아무것도 하지 않는다', async () => {
    const service = new ContractFilesService({} as never, null);
    await expect(service.fillMissing()).resolves.toBe(0);
  });
});
