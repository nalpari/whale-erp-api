import { validContractWhere } from './payslip-attendance-reasons';
import {
  insuranceOf,
  insuredWhere,
  payslipInsurance,
  payslipInsuranceMany,
} from './payslip-insurance';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const OCTOBER = {
  periodStartDate: d('2026-10-01'),
  periodEndDate: d('2026-10-31'),
};

describe('payslip-insurance — 4대보험 가입 여부(WHALEERP-756)', () => {
  let prisma: { contract: { findMany: jest.Mock } };
  const contract = (
    staffMemberId: number,
    isHealthPensionInsured: boolean | null,
    isEmploymentInjuryInsured: boolean | null,
  ) => ({ staffMemberId, isHealthPensionInsured, isEmploymentInjuryInsured });

  beforeEach(() => {
    prisma = { contract: { findMany: jest.fn().mockResolvedValue([]) } };
  });

  it('계약의 체크가 null 이면 미가입으로 본다', () => {
    expect(insuranceOf([contract(1, null, null)])).toEqual({
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: false,
    });
    expect(insuranceOf([])).toEqual({
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: false,
    });
  });

  it('기간 계약 중 하나라도 체크했으면 가입 — 달 중간에 미가입 → 가입 계약으로 바뀌면 가입한 보험만 true', async () => {
    prisma.contract.findMany.mockResolvedValue([
      contract(30, false, false),
      contract(30, true, false),
    ]);
    await expect(
      payslipInsurance(prisma as never, { staffMemberId: 30, ...OCTOBER }),
    ).resolves.toEqual({
      isHealthPensionInsured: true,
      isEmploymentInjuryInsured: false,
    });
  });

  it('「기간 중 계약 변경」과 같은 계약을 본다 — 그 직원 레코드의, 급여 기간에 효력이 있던 계약(validContractWhere)', async () => {
    await payslipInsurance(prisma as never, { staffMemberId: 30, ...OCTOBER });
    expect(prisma.contract.findMany).toHaveBeenCalledWith({
      where: {
        staffMemberId: { in: [30] },
        ...validContractWhere(OCTOBER.periodStartDate, OCTOBER.periodEndDate),
      },
      select: {
        staffMemberId: true,
        isHealthPensionInsured: true,
        isEmploymentInjuryInsured: true,
      },
    });
  });

  it('여러 명세서는 급여 기간마다 한 번만 읽고 직원별로 가른다(줄마다 읽지 않는다)', async () => {
    prisma.contract.findMany.mockResolvedValue([
      contract(30, true, true),
      contract(31, false, true),
    ]);
    const of = await payslipInsuranceMany(prisma as never, [
      { staffMemberId: 30, ...OCTOBER },
      { staffMemberId: 31, ...OCTOBER },
      { staffMemberId: 32, ...OCTOBER },
    ]);
    expect(prisma.contract.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.contract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          staffMemberId: { in: [30, 31, 32] },
        }) as unknown,
      }),
    );
    expect(of({ staffMemberId: 30, ...OCTOBER })).toEqual({
      isHealthPensionInsured: true,
      isEmploymentInjuryInsured: true,
    });
    expect(of({ staffMemberId: 31, ...OCTOBER })).toEqual({
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: true,
    });
    // 기간 계약이 없으면 미가입
    expect(of({ staffMemberId: 32, ...OCTOBER })).toEqual({
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: false,
    });
  });

  it('명세서가 없으면 읽지 않는다', async () => {
    await payslipInsuranceMany(prisma as never, []);
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  it('where 조각 — 그 칸을 체크한 기간 계약이 직원 레코드에 있다(스키마 관계 staffMember.contracts)', () => {
    expect(
      insuredWhere(
        'isEmploymentInjuryInsured',
        OCTOBER.periodStartDate,
        OCTOBER.periodEndDate,
      ),
    ).toEqual({
      staffMember: {
        contracts: {
          some: {
            isEmploymentInjuryInsured: true,
            ...validContractWhere(
              OCTOBER.periodStartDate,
              OCTOBER.periodEndDate,
            ),
          },
        },
      },
    });
  });
});
