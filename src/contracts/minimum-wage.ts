import { BadRequestException, type Logger } from '@nestjs/common';
import { INT4_MAX, PLATFORM_BP_CODE } from '../code-groups/code-format';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * 최저임금(시급)은 공통코드 `MINIMUM_WAGE` 로 관리한다(WHALEERP-595, 2026-10-30 김민식 — 별도 테이블을 두지 않음).
 * 플랫폼고정 그룹이라 플랫폼 원본(BP000000) 행만 본다. 한 행이 한 시행일이다 — 상세코드는 `D` + 시행일 8자리
 * (D20260101 = 2026-01-01부터, 상세코드는 영문으로 시작해야 해서 D 를 붙인다), 코드명은 시급(원, 숫자만 — 10320).
 */
export const MINIMUM_WAGE_GROUP = 'MINIMUM_WAGE';

export interface MinimumWage {
  /** 시행일 YYYY-MM-DD */
  effectiveDate: string;
  /** 시급(원) */
  hourlyWage: number;
}

const ITEM_CODE = /^D(\d{4})(\d{2})(\d{2})$/;

/** 상세코드 · 코드명을 시행일 · 시급으로. 형식이 틀리거나(없는 날짜 포함) 시급이 0 이하 · int 범위 밖이면 null */
export function parseMinimumWage(
  itemCode: string,
  label: string,
): MinimumWage | null {
  const m = ITEM_CODE.exec(itemCode);
  if (!m || !/^\d+$/.test(label)) return null;
  const effectiveDate = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${effectiveDate}T00:00:00Z`);
  if (
    Number.isNaN(d.getTime()) ||
    d.toISOString().slice(0, 10) !== effectiveDate
  )
    return null;
  const hourlyWage = Number(label);
  if (hourlyWage < 1 || hourlyWage > INT4_MAX) return null;
  return { effectiveDate, hourlyWage };
}

/**
 * 사용 중인 최저임금 전부, 시행일 오름차순. 형식이 틀린 행은 빼고 경고를 남긴다 — 공통코드 화면에서 코드명을 잘못
 * 고쳐도 저장이 500 이 되지 않게(그 행만 없는 것과 같다). 상세의 사용 상태만 보고 그룹의 사용 상태는 보지 않는다 —
 * 법정 하한이라 그룹을 사용중지해도 검사는 꺼지지 않는다(시행일 하나를 빼려면 그 상세를 사용중지한다).
 */
export async function readMinimumWages(
  prisma: Pick<PrismaService, 'codeItem'>,
  logger: Pick<Logger, 'warn'>,
): Promise<MinimumWage[]> {
  const rows = await prisma.codeItem.findMany({
    where: {
      groupCode: MINIMUM_WAGE_GROUP,
      bpCode: PLATFORM_BP_CODE,
      status: 'ACTIVE',
      isDeleted: false,
    },
    select: { itemCode: true, label: true },
  });
  const out: MinimumWage[] = [];
  for (const row of rows) {
    const wage = parseMinimumWage(row.itemCode, row.label);
    if (wage) out.push(wage);
    else
      logger.warn(
        `최저임금 공통코드 형식이 틀려 뺍니다: ${row.itemCode} = ${row.label}`,
      );
  }
  return out.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

/** 그날 적용되는 최저임금 — 시행일이 그날 이전(그날 포함)인 것 중 가장 늦은 것. 없으면 null */
export function minimumWageOn(
  wages: readonly MinimumWage[],
  date: string,
): MinimumWage | null {
  let found: MinimumWage | null = null;
  for (const w of wages)
    if (
      w.effectiveDate <= date &&
      (!found || w.effectiveDate > found.effectiveDate)
    )
      found = w;
  return found;
}

/** 수습 중 시급의 하한 — 최저임금의 90%, 원 미만 올림(노무사 확인 2026-10-14, 질문 19). 관리자 웹과 같다 */
export const probationWageFloor = (minimumWage: number) =>
  Math.ceil((minimumWage * 90) / 100);

/** 수습 중 시급 = 시급 × (1 − 감액률), 원 미만 반올림. 관리자 웹과 같다 */
export const probationWageOf = (wage: number, reductionRate: number) =>
  Math.round((wage * (100 - reductionRate)) / 100);

interface ProbationWageInput {
  startDate?: string;
  wageAmount?: number;
  probationMonths?: number | null;
  probationWageReductionRate?: number | null;
}

/**
 * 수습 중 시급이 계약 시작일의 최저임금 90% 이상인지(WHALEERP-595). 수습 · 시급 · 시작일 중 하나라도 없으면(임시저장)
 * 보지 않는다 — 넣은 값만 보는 다른 검사와 같다. 시작일에 적용되는 최저임금이 없으면(첫 시행일 전 계약) 보지 않는다 —
 * 지난 연도 값을 지어 넣지 않았고, 그 무렵 종이 계약을 등록할 수 있어야 해서다.
 */
export function checkProbationWage(
  dto: ProbationWageInput,
  wages: readonly MinimumWage[],
): void {
  const rate = dto.probationWageReductionRate ?? null;
  if (dto.probationMonths == null || rate === null) return;
  if (!dto.wageAmount || !dto.startDate) return;
  const minimum = minimumWageOn(wages, dto.startDate);
  if (!minimum) return;
  const floor = probationWageFloor(minimum.hourlyWage);
  if (probationWageOf(dto.wageAmount, rate) < floor)
    throw new BadRequestException(
      `수습 중 시급은 최저임금의 90%(${floor.toLocaleString('ko-KR')}원) 이상이어야 합니다.`,
    );
}
