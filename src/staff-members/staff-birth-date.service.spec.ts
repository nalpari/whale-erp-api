import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StaffBirthDateService } from './staff-birth-date.service';

// 규칙의 경계만 목으로 본다. 계정이 여러 BP 소속에 걸쳐 같이 바뀌는 것과 계약 값이 그대로인 것은
// test/staff-birth-date.e2e-spec.ts 가 실제 DB 로 본다.
describe('StaffBirthDateService', () => {
  // 한국 2026-10-26 12:00
  const now = new Date('2026-10-26T03:00:00Z');
  const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

  let service: StaffBirthDateService;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    staffMember: { findUnique: jest.Mock };
    account: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };

  const staff = (overrides: Record<string, unknown> = {}) => ({
    accountId: 70,
    employmentStatus: 'EMPLOYED',
    retiredDate: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
      staffMember: { findUnique: jest.fn().mockResolvedValue(staff()) },
      account: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          birthDate: date('1990-05-17'),
          status: 'JOINED',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((run: (tx: unknown) => unknown) =>
      run(prisma),
    );
    const module = await Test.createTestingModule({
      providers: [
        StaffBirthDateService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(StaffBirthDateService);
  });

  const correct = (birthDate: string) => service.correct(9, 42, birthDate, now);
  const errorOf = async (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (e: { getResponse: () => Record<string, unknown> }) => e.getResponse(),
    );

  it('계정 생년월일을 바꾸고 같은 트랜잭션에서 이력을 남긴다', async () => {
    await correct('1991-06-18');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { accountId: 70 },
      data: { birthDate: date('1991-06-18') },
    });
    expect(prisma.accountChangeHistory.create).toHaveBeenCalledWith({
      data: {
        accountId: 70,
        field: 'BIRTH_DATE',
        beforeValue: '1990-05-17',
        afterValue: '1991-06-18',
        channel: 'ADMIN_CORRECTION',
        requestedBy: 9,
        changedAt: now,
      },
    });
  });

  it('잠금 → 직원 조회 → 계정 잠금 → 계정 조회 순서로 읽는다', async () => {
    await correct('1991-06-18');

    const order = (m: jest.Mock, i = 0) => m.mock.invocationCallOrder[i];
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(order(prisma.$queryRaw, 0)).toBeLessThan(
      order(prisma.staffMember.findUnique),
    );
    expect(order(prisma.staffMember.findUnique)).toBeLessThan(
      order(prisma.$queryRaw, 1),
    );
    expect(order(prisma.$queryRaw, 1)).toBeLessThan(
      order(prisma.account.findUniqueOrThrow),
    );
  });

  it('계정 잠금 뒤 다시 읽은 상태가 WITHDRAWN 이면 409 BIRTH_DATE_NOT_JOINED 이다', async () => {
    // 직원 조회 시점에는 계정이 살아 있었다 — 판정은 잠근 뒤 읽은 값으로 한다.
    prisma.account.findUniqueOrThrow.mockResolvedValue({
      birthDate: date('1990-05-17'),
      status: 'WITHDRAWN',
    });

    expect(await errorOf(correct('1991-06-18'))).toMatchObject({
      statusCode: 409,
      code: 'BIRTH_DATE_NOT_JOINED',
    });
    expect(prisma.account.update).not.toHaveBeenCalled();
  });

  it('now 를 넣지 않으면 잠금을 잡은 뒤의 시각을 쓴다', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-26T03:00:00Z') });
    try {
      await service.correct(9, 42, '1991-06-18');
    } finally {
      jest.useRealTimers();
    }
    const call = prisma.accountChangeHistory.create.mock.calls[0] as [
      { data: { changedAt: Date } },
    ];
    expect(call[0].data.changedAt).toEqual(new Date('2026-10-26T03:00:00Z'));
  });

  it('직원 레코드가 아니라 계정만 고친다 — 다른 BP 소속은 같은 계정을 가리켜 같이 바뀐다', async () => {
    await correct('1991-06-18');

    expect(prisma.account.update).toHaveBeenCalledTimes(1);
    expect(prisma.staffMember.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each(['1990/05/17', '19900517', '1990-5-7', '1990-02-30', '', 'abc'])(
    '형식 오류 · 없는 날짜(%p)는 400 BIRTH_DATE_INVALID 이고 DB 를 열지 않는다',
    async (raw) => {
      expect(await errorOf(correct(raw))).toMatchObject({
        statusCode: 400,
        code: 'BIRTH_DATE_INVALID',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('오늘(KST) 뒤 날짜는 400 BIRTH_DATE_INVALID — 오늘은 허용(이 검사에선 통과, 나이 검사에서 걸림)', async () => {
    expect(await errorOf(correct('2026-10-27'))).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'BIRTH_DATE_INVALID',
      message: '오늘 이후 날짜는 넣을 수 없습니다.',
    });
    // UTC 로는 아직 10-26 이지만 한국은 10-27 인 시각 — 한국 날짜로 판단한다.
    const lateUtc = new Date('2026-10-26T16:00:00Z');
    expect(
      await errorOf(service.correct(9, 42, '2026-10-28', lateUtc)),
    ).toMatchObject({ code: 'BIRTH_DATE_INVALID' });
    expect(
      await errorOf(service.correct(9, 42, '2026-10-27', lateUtc)),
    ).toMatchObject({ code: 'BIRTH_DATE_UNDER_AGE' });
  });

  it('오늘(KST) 기준 만 19세 미만은 400 BIRTH_DATE_UNDER_AGE, 만 19세가 되는 생일 당일은 통과', async () => {
    expect(await errorOf(correct('2007-10-27'))).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'BIRTH_DATE_UNDER_AGE',
      message: '만 19세 미만으로 정정할 수 없습니다.',
    });
    await correct('2007-10-26');
    expect(prisma.account.update).toHaveBeenCalledTimes(1);
  });

  it('직원 레코드가 없으면 404', async () => {
    prisma.staffMember.findUnique.mockResolvedValue(null);

    await expect(correct('1991-06-18')).rejects.toThrow(
      '직원을 찾을 수 없습니다',
    );
  });

  it.each([
    ['계정이 없는 직원(가입 전)', staff({ accountId: null }), 'JOINED'],
    ['탈퇴한 계정', staff(), 'WITHDRAWN'],
    ['연결 보류 계정', staff(), 'LINK_HOLD'],
  ])('%s 는 409 BIRTH_DATE_NOT_JOINED', async (_name, row, status) => {
    prisma.staffMember.findUnique.mockResolvedValue(row);
    // 상태는 계정 행을 잠근 뒤 다시 읽은 값으로 판정한다.
    prisma.account.findUniqueOrThrow.mockResolvedValue({
      birthDate: date('1990-05-17'),
      status,
    });

    expect(await errorOf(correct('1991-06-18'))).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'BIRTH_DATE_NOT_JOINED',
      message: '가입 전 직원은 생년월일을 정정할 수 없습니다.',
    });
    expect(prisma.account.update).not.toHaveBeenCalled();
  });

  it('퇴직한 레코드는 409 BIRTH_DATE_RETIRED, 퇴직 예정(재직)은 허용', async () => {
    prisma.staffMember.findUnique.mockResolvedValue(
      staff({ employmentStatus: 'RETIRED' }),
    );
    expect(await errorOf(correct('1991-06-18'))).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'BIRTH_DATE_RETIRED',
      message: '퇴직한 직원은 생년월일을 정정할 수 없습니다.',
    });
    expect(prisma.account.update).not.toHaveBeenCalled();

    // 퇴직 예정은 employmentStatus 가 아직 EMPLOYED 다.
    prisma.staffMember.findUnique.mockResolvedValue(staff());
    await correct('1991-06-18');
    expect(prisma.account.update).toHaveBeenCalledTimes(1);
  });

  it('퇴직일이 지났는데 배치가 아직 RETIRED 로 바꾸지 않은 레코드도 409 BIRTH_DATE_RETIRED, 퇴직일 당일은 허용', async () => {
    // now 는 한국 2026-10-26
    prisma.staffMember.findUnique.mockResolvedValue(
      staff({ retiredDate: date('2026-10-25') }),
    );
    expect(await errorOf(correct('1991-06-18'))).toMatchObject({
      statusCode: 409,
      code: 'BIRTH_DATE_RETIRED',
    });
    expect(prisma.account.update).not.toHaveBeenCalled();

    prisma.staffMember.findUnique.mockResolvedValue(
      staff({ retiredDate: date('2026-10-26') }),
    );
    await correct('1991-06-18');
    expect(prisma.account.update).toHaveBeenCalledTimes(1);
  });

  it('윤년 2/29생은 평년 2/28 에 만 19세 미만, 3/1 에 만 19세다', async () => {
    // 2007-02-29 는 없는 날짜라 2008-02-29 생(윤년)으로 본다: 만 19세 = 2027-02-28 은 아직, 2027-03-01 부터.
    const feb28 = new Date('2027-02-28T03:00:00Z');
    expect(
      await errorOf(service.correct(9, 42, '2008-02-29', feb28)),
    ).toMatchObject({ code: 'BIRTH_DATE_UNDER_AGE' });
    const mar1 = new Date('2027-03-01T03:00:00Z');
    await service.correct(9, 42, '2008-02-29', mar1);
    expect(prisma.account.update).toHaveBeenCalledTimes(1);
  });

  it('한국 0~9시(UTC 로는 전날)에도 한국 날짜로 판단한다', async () => {
    // UTC 2026-10-25 15:30 = 한국 2026-10-26 00:30. 만 19세 생일(2007-10-26)은 이미 지났다.
    const earlyKst = new Date('2026-10-25T15:30:00Z');
    await service.correct(9, 42, '2007-10-26', earlyKst);
    expect(prisma.account.update).toHaveBeenCalledTimes(1);
    // 한국 오늘(10-26)은 미래가 아니다 — UTC 날짜(10-25)로 보면 BIRTH_DATE_INVALID 가 됐을 것이다.
    expect(
      await errorOf(service.correct(9, 42, '2026-10-26', earlyKst)),
    ).toMatchObject({ code: 'BIRTH_DATE_UNDER_AGE' });
  });

  it('지금 값과 같으면 409 BIRTH_DATE_UNCHANGED 이고 이력도 남기지 않는다', async () => {
    expect(await errorOf(correct('1990-05-17'))).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'BIRTH_DATE_UNCHANGED',
      message: '지금 생년월일과 같습니다.',
    });
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(prisma.accountChangeHistory.create).not.toHaveBeenCalled();
  });
});
