import { randomBytes } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
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

const KEY = randomBytes(32);
const NOW = new Date('2026-10-20T07:00:00.000Z');
const RRN = '9803041234567';
const ACCOUNT_NO = '110123456789';

// 신고 정보 작성 · 수정(WHALEERP-334)
describe('MyMembershipsService.saveTaxProfile', () => {
  let tx: {
    staffMember: { findFirst: jest.Mock };
    codeItem: { count: jest.Mock };
    staffTaxProfile: { create: jest.Mock; update: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };
  let logError: jest.SpyInstance;

  const staff = (hasProfile: boolean, birth = '1998-03-04') =>
    tx.staffMember.findFirst.mockResolvedValue({
      account: { birthDate: new Date(`${birth}T00:00:00.000Z`) },
      staffTaxProfile: hasProfile ? { staffMemberId: 31 } : null,
    });
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
      staffMember: { findFirst: jest.fn() },
      codeItem: { count: jest.fn().mockResolvedValue(1) },
      staffTaxProfile: { create: jest.fn(), update: jest.fn() },
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
  });

  it('처음인데 셋 중 하나라도 빠지면 400 TAX_PROFILE_INCOMPLETE', async () => {
    staff(false);
    const e = await thrown(service().saveTaxProfile(77, 31, { rrn: RRN }));
    expect(codeOf(e)).toBe('TAX_PROFILE_INCOMPLETE');
    expect(tx.staffTaxProfile.create).not.toHaveBeenCalled();
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

  it('주민등록번호만 고치면 수집 일시를 지금으로 바꾸고 계좌는 그대로 둔다', async () => {
    staff(true);
    echo(tx.staffTaxProfile.update, existing());
    const res = await service().saveTaxProfile(77, 31, { rrn: RRN });
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
  });

  it('급여 계좌만 고치면 수집 일시 · 주민등록번호는 그대로 둔다', async () => {
    staff(true);
    echo(tx.staffTaxProfile.update, existing());
    const res = await service().saveTaxProfile(77, 31, {
      bankCode: 'B088',
      payrollAccountNumber: ACCOUNT_NO,
    });
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
  });

  it.each([
    ['아무것도 없음', {}, 'TAX_PROFILE_EMPTY'],
    ['은행만', { bankCode: 'B004' }, 'TAX_PROFILE_ACCOUNT_INCOMPLETE'],
    [
      '계좌번호만',
      { payrollAccountNumber: ACCOUNT_NO },
      'TAX_PROFILE_ACCOUNT_INCOMPLETE',
    ],
  ])('%s — 400 %s, DB 를 읽지 않는다', async (_label, dto, code) => {
    const e = await thrown(service().saveTaxProfile(77, 31, dto));
    expect(e.getStatus()).toBe(400);
    expect(codeOf(e)).toBe(code);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('주민등록번호 앞자리가 가입 생년월일과 다르면 400 RRN_BIRTH_MISMATCH — 관리자에게 정정 요청', async () => {
    staff(true, '1998-03-05');
    const e = await thrown(service().saveTaxProfile(77, 31, { rrn: RRN }));
    expect(codeOf(e)).toBe('RRN_BIRTH_MISMATCH');
    expect(tx.staffTaxProfile.update).not.toHaveBeenCalled();
  });

  it('없는 은행이면 400 BANK_CODE_UNKNOWN', async () => {
    staff(true);
    tx.codeItem.count.mockResolvedValue(0);
    const e = await thrown(
      service().saveTaxProfile(77, 31, {
        bankCode: 'ZZZ',
        payrollAccountNumber: ACCOUNT_NO,
      }),
    );
    expect(codeOf(e)).toBe('BANK_CODE_UNKNOWN');
  });

  it('내 소속이 아니면 404', async () => {
    tx.staffMember.findFirst.mockResolvedValue(null);
    const e = await thrown(service().saveTaxProfile(77, 31, { rrn: RRN }));
    expect(e.getStatus()).toBe(404);
  });

  it('암호화 키가 없으면 503 — DB 를 읽지 않는다', async () => {
    const e = await thrown(service(null).saveTaxProfile(77, 31, { rrn: RRN }));
    expect(e.getStatus()).toBe(503);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
