import type { EmploymentType } from '@prisma/client';
import { DB_ENUMS } from './db-enums.generated';

/** 고용 형태 표시 문구(정직원 · 파트타이머) — DB enum 주석(DB_ENUMS)에서 읽는다. 값이 없거나 모르는 값이면 null */
export const employmentTypeLabel = (
  type: EmploymentType | null | undefined,
): string | null =>
  DB_ENUMS.EmploymentType.find(([value]) => value === type)?.[1] ?? null;
