import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreatePayslipDto, PayslipMonthDto } from './payslip-draft.dto';
import { SavePayslipDto } from './payslip-edit.dto';
import { PayslipListQueryDto } from './payslip-list.query.dto';
import { SendPayslipsDto } from './payslip-send.dto';

// ValidationPipe 처럼 바꾸고 검사한다. 걸린 칸 이름이 곧 400 이다.
const check = <T extends object>(cls: ClassConstructor<T>, plain: object) => {
  const dto = plainToInstance(cls, plain);
  return { dto, failed: validateSync(dto).map((e) => e.property) };
};

describe('PayslipListQueryDto (관리자 목록 쿼리)', () => {
  const list = (query: Record<string, unknown>) =>
    check(PayslipListQueryDto, { month: '2026-09', ...query });

  it('쉼표 목록을 배열로 바꾼다', () =>
    expect(
      list({ status: 'REVIEWING,CONFIRMED', storeIds: '3,5' }),
    ).toMatchObject({
      dto: { status: ['REVIEWING', 'CONFIRMED'], storeIds: [3, 5] },
      failed: [],
    }));

  it('점포 유형은 쉼표 목록 — 모르는 값 · 빈 값은 400', () => {
    expect(list({ storeTypes: 'DIRECT,FRANCHISE' })).toMatchObject({
      dto: { storeTypes: ['DIRECT', 'FRANCHISE'] },
      failed: [],
    });
    expect(list({ storeTypes: 'HQ' }).failed).toEqual(['storeTypes']);
    expect(list({ storeTypes: '' }).failed).toEqual(['storeTypes']);
  });

  it.each(['', 'FOO', 'REVIEWING,'])('상태 %p 는 400', (status) =>
    expect(list({ status }).failed).toEqual(['status']),
  );

  it.each(['3,,5', 'a', '0', '2147483648'])('점포 %p 는 400', (storeIds) =>
    expect(list({ storeIds }).failed).toEqual(['storeIds']),
  );

  it('점포는 1000개까지(직원 목록과 같다)', () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => i + 1).join(',');
    expect(list({ storeIds: ids(1000) }).failed).toEqual([]);
    expect(list({ storeIds: ids(1001) }).failed).toEqual(['storeIds']);
  });

  it('빈칸 이름은 없는 것, 51자는 400', () => {
    expect(list({ staffName: '  ' }).dto.staffName).toBeUndefined();
    expect(list({ staffName: '가'.repeat(51) }).failed).toEqual(['staffName']);
  });

  it.each([
    [{ month: '2026-13' }, 'month'],
    [{ month: '2026-9' }, 'month'],
    [{ pageSize: '30' }, 'pageSize'],
    [{ page: '0' }, 'page'],
    [{ page: '1000001' }, 'page'],
  ])('%p 는 400', (query, field) =>
    expect(list(query).failed).toEqual([field]),
  );
});

describe('SavePayslipDto (금액 저장)', () => {
  const save = (item: object) =>
    check(SavePayslipDto, {
      updatedAt: '2026-10-21T01:00:00.000Z',
      isPremiumApplied: true,
      isWithholdingApplied: false,
      items: [{ payslipItemMasterId: 1, ...item }],
    });

  it.each([null, 0, 100_000_000])('금액 %p 는 받는다', (amount) =>
    expect(save({ amount }).failed).toEqual([]),
  );

  it.each([-1, 1.5, 100_000_001, '100', undefined])(
    '금액 %p 는 400',
    (amount) => expect(save({ amount }).failed).toEqual(['items']),
  );

  it('금액 칸이 아예 없으면 400', () => {
    const dto = plainToInstance(SavePayslipDto, {
      updatedAt: '2026-10-21T01:00:00.000Z',
      isPremiumApplied: true,
      isWithholdingApplied: false,
      items: [{ payslipItemMasterId: 1 }],
    });
    expect(validateSync(dto).map((e) => e.property)).toEqual(['items']);
  });

  it('항목 id 0 · 101줄은 400', () => {
    expect(save({ payslipItemMasterId: 0, amount: 1 }).failed).toEqual([
      'items',
    ]);
    const many = check(SavePayslipDto, {
      updatedAt: '2026-10-21T01:00:00.000Z',
      isPremiumApplied: true,
      isWithholdingApplied: false,
      items: Array.from({ length: 101 }, (_, i) => ({
        payslipItemMasterId: i + 1,
        amount: 0,
      })),
    });
    expect(many.failed).toEqual(['items']);
  });
});

describe('SendPayslipsDto · CreatePayslipDto · PayslipMonthDto', () => {
  it('빈 점포 목록은 받는다 — 보낼 것이 없다는 뜻', () =>
    expect(
      check(SendPayslipsDto, { month: '2026-09', storeIds: [] }).failed,
    ).toEqual([]));

  it.each([[['1']], [Array.from({ length: 1001 }, (_, i) => i + 1)]])(
    '점포 %#번 경우는 400',
    (storeIds) =>
      expect(
        check(SendPayslipsDto, { month: '2026-09', storeIds }).failed,
      ).toEqual(['storeIds']),
  );

  it('점포 유형은 DIRECT · FRANCHISE 만', () => {
    expect(
      check(SendPayslipsDto, { month: '2026-09', storeTypes: ['FRANCHISE'] })
        .failed,
    ).toEqual([]);
    expect(
      check(SendPayslipsDto, { month: '2026-09', storeTypes: ['HQ'] }).failed,
    ).toEqual(['storeTypes']);
  });

  it('빈칸 이름은 없는 것', () =>
    expect(
      check(SendPayslipsDto, { month: '2026-09', staffName: '  ' }).dto
        .staffName,
    ).toBeUndefined());

  it.each([0, 2147483648])('직원 %p 는 400', (staffMemberId) =>
    expect(
      check(CreatePayslipDto, { staffMemberId, month: '2026-09' }).failed,
    ).toEqual(['staffMemberId']),
  );

  it('달 2026-00 은 400', () => {
    expect(check(PayslipMonthDto, { month: '2026-00' }).failed).toEqual([
      'month',
    ]);
    expect(check(SendPayslipsDto, { month: '2026-00' }).failed).toEqual([
      'month',
    ]);
  });
});
