import { randomBytes } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
import { hashPassword } from '../auth/password';
import {
  decryptPersonalData,
  encryptPersonalData,
  staffTaxProfileAad,
} from '../common/personal-data-cipher';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_STAFF } from '../todos/todo-rules';
import {
  birthDateOfRrn,
  MyMembershipsService,
  TAX_PROFILE_PURPOSE,
} from './my-memberships.service';
import { CURRENT_PASSWORD_MISMATCH_MESSAGE } from './my-password.service';

const KEY = randomBytes(32);
const NOW = new Date('2026-10-20T07:00:00.000Z');
const RRN = '9803041234567';
const ACCOUNT_NO = '110123456789';
const PASSWORD = 'now-pass-1234';
/** 고칠 때는 지금 비밀번호를 함께 보낸다(WHALEERP-333 · 334 후속, 2026-10-23) */
const withPw = <T extends object>(dto: T) => ({
  ...dto,
  currentPassword: PASSWORD,
});

// 신고 정보 작성 · 수정(WHALEERP-334)
describe('MyMembershipsService.saveTaxProfile', () => {
  let tx: {
    $queryRaw: jest.Mock;
    staffMember: { findFirst: jest.Mock; count: jest.Mock };
    account: { findUniqueOrThrow: jest.Mock };
    codeItem: { count: jest.Mock };
    staffTaxProfile: {
      count: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    staffTaxProfileHistory: { createMany: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };
  let logError: jest.SpyInstance;
  let passwordHash: string;
  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  /** 이미 낸 신고 정보 — 같은 키 · AAD 로 암호화한 앞 값. 고친 칸만 바꿔 돌려준다 */
  const existing = () => ({
    rrnEncrypted: encryptPersonalData(
      KEY,
      '9803047654321',
      staffTaxProfileAad('rrn_encrypted', 31),
    ),
    bankCode: 'B004',
    payrollAccountNumberEncrypted: encryptPersonalData(
      KEY,
      '22233334444',
      staffTaxProfileAad('payroll_account_number_encrypted', 31),
    ),
    purpose: TAX_PROFILE_PURPOSE,
    collectedAt: new Date('2026-09-01T00:00:00Z'),
  });

  /** 내 소속 하나 — 이미 낸 신고 정보가 있으면 `existing()` 을 읽는다 */
  const staff = (hasProfile: boolean, birth = '1998-03-04') => {
    tx.staffMember.findFirst.mockResolvedValue({
      account: { birthDate: new Date(`${birth}T00:00:00.000Z`) },
    });
    tx.staffTaxProfile.count.mockResolvedValue(hasProfile ? 1 : 0);
    tx.staffTaxProfile.findUnique.mockResolvedValue(
      hasProfile ? existing() : null,
    );
  };
  /** 쓴 값 그대로 돌려준다 — 응답이 실제로 풀리는지 본다 */
  const echo = (m: jest.Mock, base: Record<string, unknown> = {}) =>
    m.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        rrnEncrypted: base.rrnEncrypted,
        bankCode: base.bankCode,
        payrollAccountNumberEncrypted: base.payrollAccountNumberEncrypted,
        purpose: TAX_PROFILE_PURPOSE,
        collectedAt: base.collectedAt,
        ...data,
      }),
    );
  const service = (key: Buffer | null = KEY) =>
    new MyMembershipsService(prisma as unknown as PrismaService, key);
  const thrown = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('던지지 않았다');
  };
  const codeOf = (e: HttpException) =>
    (e.getResponse() as { code?: string }).code;
  const dataOf = (m: jest.Mock) =>
    (m.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
  /** 남긴 이력 — 무엇을 · 언제 · 누가만, 값은 없다 */
  const historyOf = (...fields: string[]) =>
    expect(tx.staffTaxProfileHistory.createMany).toHaveBeenCalledWith({
      data: fields.map((field) => ({
        staffMemberId: 31,
        field,
        accountId: 77,
        changedAt: NOW,
      })),
    });
  const open = (
    sealed: unknown,
    column: Parameters<typeof staffTaxProfileAad>[0],
  ) =>
    decryptPersonalData(
      KEY,
      sealed as Uint8Array,
      staffTaxProfileAad(column, 31),
    );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      staffMember: {
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      account: {
        findUniqueOrThrow: jest.fn(() => Promise.resolve({ passwordHash })),
      },
      codeItem: { count: jest.fn().mockResolvedValue(1) },
      staffTaxProfile: {
        count: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      staffTaxProfileHistory: { createMany: jest.fn() },
    };
    prisma = {
      ...tx,
      $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    };
    echo(tx.staffTaxProfile.create);
  });
  afterEach(() => {
    jest.useRealTimers();
    logError.mockRestore();
  });

  it('birthDateOfRrn — 뒷자리 첫 자리로 세기를 정한다(외국인등록번호 포함)', () => {
    expect(birthDateOfRrn('9803041234567')).toBe('1998-03-04');
    expect(birthDateOfRrn('0501013234567')).toBe('2005-01-01');
    expect(birthDateOfRrn('9803045234567')).toBe('1998-03-04');
    expect(birthDateOfRrn('0501017234567')).toBe('2005-01-01');
  });

  it('처음 작성 — 내 소속만 찾고, 셋을 암호화해 넣고 수집 일시 · 목적을 정한다. 응답은 가린 값', async () => {
    staff(false);
    await expect(
      service().saveTaxProfile(77, 31, {
        rrn: RRN,
        bankCode: 'B004',
        payrollAccountNumber: ACCOUNT_NO,
      }),
    ).resolves.toEqual({
      staffMemberId: 31,
      taxProfile: {
        rrnMasked: '980304-1******',
        bankCode: 'B004',
        payrollAccountNumberMasked: '********6789',
        purpose: TAX_PROFILE_PURPOSE,
        collectedAt: NOW,
      },
    });
    expect(
      (tx.staffMember.findFirst.mock.calls[0] as [{ where: unknown }])[0].where,
    ).toEqual({ staffMemberId: 31, accountId: 77, ...ACTIVE_STAFF });
    const data = dataOf(tx.staffTaxProfile.create);
    expect(data).toMatchObject({
      staffMemberId: 31,
      purpose: TAX_PROFILE_PURPOSE,
      bankCode: 'B004',
      collectedAt: NOW,
    });
    // #79 의 조회가 같은 키 · AAD 로 풀 수 있다
    expect(open(data.rrnEncrypted, 'rrn_encrypted')).toBe(RRN);
    expect(
      open(
        data.payrollAccountNumberEncrypted,
        'payroll_account_number_encrypted',
      ),
    ).toBe(ACCOUNT_NO);
    expect(
      (tx.codeItem.count.mock.calls[0] as [{ where: unknown }])[0].where,
    ).toEqual({
      groupCode: 'BANK',
      itemCode: 'B004',
      status: 'ACTIVE',
      isDeleted: false,
    });
    // 처음 작성도 항목마다 이력 한 행
    historyOf('RRN', 'PAYROLL_ACCOUNT');
  });

  it('처음인데 셋 중 하나라도 빠지면 400 TAX_PROFILE_INCOMPLETE', async () => {
    staff(false);
    const e = await thrown(service().saveTaxProfile(77, 31, { rrn: RRN }));
    expect(codeOf(e)).toBe('TAX_PROFILE_INCOMPLETE');
    expect(tx.staffTaxProfile.create).not.toHaveBeenCalled();
  });

  it('주민등록번호만 고치면 수집 일시를 지금으로 바꾸고 계좌는 그대로 둔다', async () => {
    staff(true);
    echo(tx.staffTaxProfile.update, existing());
    const res = await service().saveTaxProfile(77, 31, withPw({ rrn: RRN }));
    const data = dataOf(tx.staffTaxProfile.update);
    expect(Object.keys(data).sort()).toEqual(['collectedAt', 'rrnEncrypted']);
    expect(data.collectedAt).toEqual(NOW);
    expect(open(data.rrnEncrypted, 'rrn_encrypted')).toBe(RRN);
    expect(res.taxProfile).toMatchObject({
      rrnMasked: '980304-1******',
      payrollAccountNumberMasked: '*******4444',
      collectedAt: NOW,
    });
    expect(tx.codeItem.count).not.toHaveBeenCalled();
    historyOf('RRN');
  });

  it('급여 계좌만 고치면 수집 일시 · 주민등록번호는 그대로 둔다', async () => {
    staff(true);
    echo(tx.staffTaxProfile.update, existing());
    const res = await service().saveTaxProfile(
      77,
      31,
      withPw({
        bankCode: 'B088',
        payrollAccountNumber: ACCOUNT_NO,
      }),
    );
    const data = dataOf(tx.staffTaxProfile.update);
    expect(Object.keys(data).sort()).toEqual([
      'bankCode',
      'payrollAccountNumberEncrypted',
    ]);
    expect(res.taxProfile).toMatchObject({
      rrnMasked: '980304-7******',
      bankCode: 'B088',
      payrollAccountNumberMasked: '********6789',
      collectedAt: new Date('2026-09-01T00:00:00Z'),
    });
    historyOf('PAYROLL_ACCOUNT');
  });

  it('직원 행을 잡은 뒤 신고 정보를 읽는다 — 처음 작성을 두 번 보내도 뒤쪽은 고치기로 간다(api #86 리뷰)', async () => {
    staff(false);
    await service().saveTaxProfile(77, 31, {
      rrn: RRN,
      bankCode: 'B004',
      payrollAccountNumber: ACCOUNT_NO,
    });
    // FOR NO KEY UPDATE — 직원 출근의 외래키 잠금(FOR KEY SHARE)과 부딪히지 않게(PR #159 리뷰)
    expect(String((tx.$queryRaw.mock.calls[0] as [string[]])[0])).toContain(
      'FOR NO KEY UPDATE',
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.staffTaxProfile.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('같은 값을 다시 보내면 아무것도 쓰지 않고 지금 값을 준다 — 수집 일시 · 이력 그대로(api #86 리뷰)', async () => {
    // 앞 값 9803047… 은 뒷자리 첫 자리 7 이라 2098년생이다
    staff(true, '2098-03-04');
    const res = await service().saveTaxProfile(
      77,
      31,
      withPw({
        rrn: '9803047654321',
        bankCode: 'B004',
        payrollAccountNumber: '22233334444',
      }),
    );
    expect(tx.staffTaxProfile.update).not.toHaveBeenCalled();
    expect(tx.staffTaxProfileHistory.createMany).not.toHaveBeenCalled();
    expect(res.taxProfile).toMatchObject({
      rrnMasked: '980304-7******',
      payrollAccountNumberMasked: '*******4444',
      collectedAt: new Date('2026-09-01T00:00:00Z'),
    });
  });

  it('셋을 다시 보내도 실제로 바뀐 항목만 쓰고 이력에 남긴다', async () => {
    staff(true);
    echo(tx.staffTaxProfile.update, existing());
    await service().saveTaxProfile(
      77,
      31,
      withPw({
        rrn: RRN,
        bankCode: 'B004',
        payrollAccountNumber: '22233334444',
      }),
    );
    expect(Object.keys(dataOf(tx.staffTaxProfile.update)).sort()).toEqual([
      'collectedAt',
      'rrnEncrypted',
    ]);
    historyOf('RRN');
  });

  it('계좌번호가 같아도 은행이 바뀌면 급여 계좌가 바뀐 것이다', async () => {
    staff(true);
    echo(tx.staffTaxProfile.update, existing());
    await service().saveTaxProfile(
      77,
      31,
      withPw({
        bankCode: 'B088',
        payrollAccountNumber: '22233334444',
      }),
    );
    historyOf('PAYROLL_ACCOUNT');
  });

  /** 다른 레코드의 AAD 로 봉한 값 — 이 레코드에서는 풀리지 않는다(손상 · 키 바뀜과 같다) */
  const unreadable = (column: Parameters<typeof staffTaxProfileAad>[0]) =>
    encryptPersonalData(KEY, '0000000000', staffTaxProfileAad(column, 99));
  /** 트랜잭션 안에서 던졌는가 — 그렇다면 DB 에서는 쓰기도 함께 되돌아간다 */
  const rolledBack = () =>
    expect(
      (prisma.$transaction.mock.results[0] as { value: Promise<unknown> })
        .value,
    ).rejects.toMatchObject({ status: 500 });

  it.each([
    ['주민등록번호', { rrn: RRN }, 'rrnEncrypted', 'rrn_encrypted'],
    [
      '급여 계좌(은행이 같아도)',
      { bankCode: 'B004', payrollAccountNumber: '22233334444' },
      'payrollAccountNumberEncrypted',
      'payroll_account_number_encrypted',
    ],
  ] as const)(
    '보낸 %s 의 저장값을 풀 수 없으면 500 — 덮어쓰지 않는다(키를 잘못 배포했을 때 잘못된 키로 다시 봉하지 않게, 2026-10-21)',
    async (_label, dto, field, column) => {
      staff(true);
      tx.staffTaxProfile.findUnique.mockResolvedValue({
        ...existing(),
        [field]: unreadable(column),
      });
      const e = await thrown(service().saveTaxProfile(77, 31, withPw(dto)));
      expect(e.getStatus()).toBe(500);
      expect(tx.staffTaxProfile.update).not.toHaveBeenCalled();
      expect(tx.staffTaxProfileHistory.createMany).not.toHaveBeenCalled();
      const logged = String((logError.mock.calls[0] as unknown[])[0]);
      expect(logged).toContain(`staffMemberId=31 칸=${column}`);
      expect(logged).not.toContain(RRN);
    },
  );

  it.each([
    ['풀 수 없음', unreadable('payroll_account_number_encrypted')],
    [
      '풀리지만 형식이 깨짐',
      encryptPersonalData(
        KEY,
        'not-a-number',
        staffTaxProfileAad('payroll_account_number_encrypted', 31),
      ),
    ],
  ])(
    '보내지 않은 칸이 %s 이면 응답을 만들 수 없어 트랜잭션 안에서 500 — 쓰기도 되돌아간다',
    async (_label, sealed) => {
      staff(true);
      tx.staffTaxProfile.findUnique.mockResolvedValue({
        ...existing(),
        payrollAccountNumberEncrypted: sealed,
      });
      echo(tx.staffTaxProfile.update, {
        ...existing(),
        payrollAccountNumberEncrypted: sealed,
      });
      const e = await thrown(
        service().saveTaxProfile(77, 31, withPw({ rrn: RRN })),
      );
      expect(e.getStatus()).toBe(500);
      await rolledBack();
    },
  );

  it('잠근 뒤 다시 읽으니 내 재직 소속이 아니면(그사이 퇴직 확정) 404 — 쓰지 않는다(api #86 재리뷰)', async () => {
    staff(true);
    tx.staffMember.findFirst.mockResolvedValue(null);
    const e = await thrown(
      service().saveTaxProfile(77, 31, withPw({ rrn: RRN })),
    );
    expect(e.getStatus()).toBe(404);
    const order = (m: jest.Mock) => m.mock.invocationCallOrder[0];
    // 소속 확인 → 잠금 → 소속 · 생년월일 다시 읽기
    expect(order(tx.staffMember.count)).toBeLessThan(order(tx.$queryRaw));
    expect(order(tx.$queryRaw)).toBeLessThan(order(tx.staffMember.findFirst));
    expect(
      (tx.staffMember.count.mock.calls[0] as [{ where: unknown }])[0].where,
    ).toEqual({ staffMemberId: 31, accountId: 77, ...ACTIVE_STAFF });
    expect(tx.staffTaxProfile.update).not.toHaveBeenCalled();
    expect(tx.staffTaxProfileHistory.createMany).not.toHaveBeenCalled();
  });

  it('주민등록번호 앞자리가 가입 생년월일과 다르면 400 RRN_BIRTH_MISMATCH — 관리자에게 정정 요청', async () => {
    staff(true, '1998-03-05');
    const e = await thrown(
      service().saveTaxProfile(77, 31, withPw({ rrn: RRN })),
    );
    expect(codeOf(e)).toBe('RRN_BIRTH_MISMATCH');
    expect(tx.staffTaxProfile.update).not.toHaveBeenCalled();
    expect(tx.staffTaxProfileHistory.createMany).not.toHaveBeenCalled();
  });

  it('없는 은행이면 400 BANK_CODE_UNKNOWN', async () => {
    staff(true);
    tx.codeItem.count.mockResolvedValue(0);
    const e = await thrown(
      service().saveTaxProfile(
        77,
        31,
        withPw({
          bankCode: 'ZZZ',
          payrollAccountNumber: ACCOUNT_NO,
        }),
      ),
    );
    expect(codeOf(e)).toBe('BANK_CODE_UNKNOWN');
  });

  it('내 소속이 아니면 404 — 남의 직원 행을 잠그지 않는다', async () => {
    tx.staffMember.count.mockResolvedValue(0);
    const e = await thrown(service().saveTaxProfile(77, 31, { rrn: RRN }));
    expect(e.getStatus()).toBe(404);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('암호화 키가 없으면 503 — DB 를 읽지 않는다', async () => {
    const e = await thrown(service(null).saveTaxProfile(77, 31, { rrn: RRN }));
    expect(e.getStatus()).toBe(503);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // 고칠 때 지금 비밀번호 확인(WHALEERP-333 · 334 후속, 2026-10-23) — 토큰만 손에 넣은 사람이 급여 계좌를 바꾸지 못하게
  describe('지금 비밀번호', () => {
    const mismatch = async (promise: Promise<unknown>) => {
      const e = await thrown(promise);
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toMatchObject({
        code: 'CURRENT_PASSWORD_MISMATCH',
        message: CURRENT_PASSWORD_MISMATCH_MESSAGE,
      });
      expect(tx.staffTaxProfile.update).not.toHaveBeenCalled();
      expect(tx.staffTaxProfileHistory.createMany).not.toHaveBeenCalled();
      return e;
    };

    it('고칠 때 맞으면 고친다 — 확인한 해시를 계정 행을 잡은 뒤 다시 본다', async () => {
      staff(true);
      echo(tx.staffTaxProfile.update, existing());
      await service().saveTaxProfile(
        77,
        31,
        withPw({ bankCode: 'B088', payrollAccountNumber: ACCOUNT_NO }),
      );
      expect(tx.staffTaxProfile.update).toHaveBeenCalled();
      const where = (m: jest.Mock, i: number) =>
        (m.mock.calls[i] as [{ where: unknown }])[0].where;
      expect(where(tx.account.findUniqueOrThrow, 0)).toEqual({
        accountId: 77,
      });
      // 직원 행 → 계정 행 순서로 잡고, 잡은 뒤 다시 읽는다
      const locks = tx.$queryRaw.mock.calls.map((c) =>
        (c as [string[]])[0].join('?'),
      );
      expect(locks[0]).toContain('staff_members');
      expect(locks[1]).toContain('accounts');
      expect(locks[1]).toContain('FOR SHARE');
      expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        tx.account.findUniqueOrThrow.mock.invocationCallOrder[1],
      );
    });

    it('고칠 때 틀리면 400 CURRENT_PASSWORD_MISMATCH — 트랜잭션에 들어가지 않는다', async () => {
      staff(true);
      await mismatch(
        service().saveTaxProfile(77, 31, {
          rrn: RRN,
          currentPassword: 'wrong-pass',
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('고칠 때 없으면 400 CURRENT_PASSWORD_MISMATCH — 틀림과 같은 본문, 같은 값을 다시 보내도(풀어 비교하지 않는다)', async () => {
      staff(true, '2098-03-04');
      await mismatch(service().saveTaxProfile(77, 31, { rrn: RRN }));
      await mismatch(
        service().saveTaxProfile(77, 31, { rrn: '9803047654321' }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.account.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('비밀번호가 맞아도 다른 검사보다 먼저 본다 — 틀리면 생년월일 · 은행 검사까지 가지 않는다', async () => {
      staff(true, '1998-03-05');
      tx.codeItem.count.mockResolvedValue(0);
      await mismatch(
        service().saveTaxProfile(77, 31, {
          rrn: RRN,
          currentPassword: 'wrong-pass',
        }),
      );
      expect(tx.codeItem.count).not.toHaveBeenCalled();
    });

    it('확인한 사이 비밀번호가 바뀌었으면(잡은 뒤 해시가 다름) 400 — 쓰지 않는다', async () => {
      staff(true);
      tx.account.findUniqueOrThrow
        .mockResolvedValueOnce({ passwordHash })
        .mockResolvedValueOnce({ passwordHash: 'scrypt$changed' });
      await mismatch(service().saveTaxProfile(77, 31, withPw({ rrn: RRN })));
    });

    it('처음 작성은 비밀번호 없이 된다 — 계정 비밀번호를 읽지 않는다', async () => {
      staff(false);
      await service().saveTaxProfile(77, 31, {
        rrn: RRN,
        bankCode: 'B004',
        payrollAccountNumber: ACCOUNT_NO,
      });
      expect(tx.staffTaxProfile.create).toHaveBeenCalled();
      expect(tx.account.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('처음 작성에 보낸 비밀번호는 보지 않는다 — 틀려도 만든다', async () => {
      staff(false);
      await service().saveTaxProfile(77, 31, {
        rrn: RRN,
        bankCode: 'B004',
        payrollAccountNumber: ACCOUNT_NO,
        currentPassword: 'wrong-pass',
      });
      expect(tx.staffTaxProfile.create).toHaveBeenCalled();
    });

    it('확인할 때 없던 신고 정보가 잡은 뒤 있으면(처음 작성을 두 번 보냄) 비밀번호를 보지 않았으니 400 — 고치지 않는다', async () => {
      staff(false);
      tx.staffTaxProfile.findUnique.mockResolvedValue(existing());
      await mismatch(
        service().saveTaxProfile(77, 31, {
          rrn: RRN,
          bankCode: 'B004',
          payrollAccountNumber: ACCOUNT_NO,
        }),
      );
      expect(tx.staffTaxProfile.create).not.toHaveBeenCalled();
    });

    it('내 소속이 아니면 비밀번호보다 먼저 404 — 비밀번호 없이도 · 틀려도 같다', async () => {
      tx.staffMember.count.mockResolvedValue(0);
      for (const dto of [
        { rrn: RRN },
        { rrn: RRN, currentPassword: 'wrong-pass' },
      ]) {
        const e = await thrown(service().saveTaxProfile(77, 31, dto));
        expect(e.getStatus()).toBe(404);
      }
      expect(tx.staffTaxProfile.count).not.toHaveBeenCalled();
      expect(tx.account.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });
});
