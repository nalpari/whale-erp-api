import { BadRequestException } from '@nestjs/common';
import { INT4_MAX, PLATFORM_BP_CODE } from '../code-groups/code-format';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * 최저임금(시급)은 공통코드 하나로 관리한다(WHALEERP-595, 2026-10-30 김민식 — 별도 테이블 없이, 시행일마다 행을 늘리지 않고
 * 값 하나를 매년 고친다). 그룹 `MINIMUM_WAGE` 의 상세 `HOURLY`, 코드명이 시급(원, 숫자만 — 10320)이다. 플랫폼고정 그룹이라
 * 플랫폼 원본(BP000000) 행만 본다. 검사는 계약 시작일과 상관없이 지금 등록된 값으로 한다.
 */
export const MINIMUM_WAGE_GROUP = 'MINIMUM_WAGE';
export const MINIMUM_WAGE_ITEM = 'HOURLY';

const ASK = '플랫폼 관리자에게 문의해 주세요.';
export const MINIMUM_WAGE_MISSING = `최저임금 공통코드(MINIMUM_WAGE · HOURLY)가 없어 수습 중 시급을 확인할 수 없습니다. ${ASK}`;
export const MINIMUM_WAGE_INACTIVE = `최저임금 공통코드(MINIMUM_WAGE · HOURLY)가 사용 중지되어 수습 중 시급을 확인할 수 없습니다. ${ASK}`;
export const MINIMUM_WAGE_NOT_NUMBER = `최저임금 공통코드(MINIMUM_WAGE · HOURLY)의 코드명이 숫자가 아니어서 수습 중 시급을 확인할 수 없습니다. ${ASK}`;

/** 지금 최저임금 — 쓸 수 있으면 시급, 아니면 그 까닭(저장 400 문장 그대로) */
export type MinimumWage = { hourlyWage: number } | { problem: string };

/**
 * 지금 등록된 최저임금. 코드가 없거나(삭제 포함) · 그룹이나 상세가 사용 중지됐거나 · 코드명이 1 이상 숫자가 아니면 그 까닭을
 * 준다 — 검사가 조용히 꺼지지 않게 저장이 그 문장으로 400 이다(2026-10-30 김민식).
 */
export async function readMinimumWage(
  prisma: Pick<PrismaService, 'codeItem'>,
): Promise<MinimumWage> {
  const row = await prisma.codeItem.findUnique({
    where: {
      groupCode_itemCode_bpCode: {
        groupCode: MINIMUM_WAGE_GROUP,
        itemCode: MINIMUM_WAGE_ITEM,
        bpCode: PLATFORM_BP_CODE,
      },
    },
    select: {
      label: true,
      status: true,
      isDeleted: true,
      codeGroup: { select: { status: true, isDeleted: true } },
    },
  });
  if (!row || row.isDeleted || row.codeGroup.isDeleted)
    return { problem: MINIMUM_WAGE_MISSING };
  if (row.status !== 'ACTIVE' || row.codeGroup.status !== 'ACTIVE')
    return { problem: MINIMUM_WAGE_INACTIVE };
  const hourlyWage = Number(row.label);
  if (!/^\d+$/.test(row.label) || hourlyWage < 1 || hourlyWage > INT4_MAX)
    return { problem: MINIMUM_WAGE_NOT_NUMBER };
  return { hourlyWage };
}

/** 수습 중 시급의 하한 — 최저임금의 90%, 원 미만 올림(노무사 확인 2026-10-14, 질문 19). 관리자 웹과 같다 */
export const probationWageFloor = (minimumWage: number) =>
  Math.ceil((minimumWage * 90) / 100);

/** 수습 중 시급 = 시급 × (1 − 감액률), 원 미만 반올림. 관리자 웹과 같다 */
export const probationWageOf = (wage: number, reductionRate: number) =>
  Math.round((wage * (100 - reductionRate)) / 100);

interface ProbationWageInput {
  wageAmount?: number;
  probationMonths?: number | null;
  probationWageReductionRate?: number | null;
}

/** 수습을 두고 시급을 넣었는가 — 수습 중 시급 검사를 할 때. 둘 중 하나라도 없으면(임시저장) 넣은 값만 보는 다른 검사처럼 보지 않는다 */
export const needsProbationWageCheck = (dto: ProbationWageInput) =>
  dto.probationMonths != null &&
  dto.probationWageReductionRate != null &&
  !!dto.wageAmount;

/**
 * 수습 중 시급이 지금 최저임금의 90% 이상인지(WHALEERP-595). 계약 시작일과 상관없이 지금 값으로 본다 — 지난 날짜에 시작한
 * 계약도, 연초 값을 고치기 전에는 지난해 값으로 본다(2026-10-30 김민식). 최저임금을 쓸 수 없으면 그 까닭으로 400 이다.
 */
export function checkProbationWage(
  dto: ProbationWageInput,
  minimum: MinimumWage,
): void {
  if (!needsProbationWageCheck(dto)) return;
  if ('problem' in minimum) throw new BadRequestException(minimum.problem);
  const floor = probationWageFloor(minimum.hourlyWage);
  if (probationWageOf(dto.wageAmount!, dto.probationWageReductionRate!) < floor)
    throw new BadRequestException(
      `수습 중 시급은 최저임금의 90%(${floor.toLocaleString('ko-KR')}원) 이상이어야 합니다.`,
    );
}
