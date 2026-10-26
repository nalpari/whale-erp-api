import { Prisma, PrismaClient, Weekday } from '@prisma/client';
import { addDays, kstDayStart, kstToday } from '../staff-members/kst-date';
import { addDay } from './pay-calculation';

// 급여명세서 검토 대기 분류 가운데 출퇴근에서 나오는 셋(WHALEERP-229) — 출퇴근 누락(빠진 날 · 일수), 계약 만료 후 기록,
// 확인 필요 기록 포함(ATT-11). 기간 중 계약 변경은 계약 수로 붙이고(`reviewReasonsOf`), 공제 미입력은 저장하지 않고 확정이
// 막는다(230).
// 날짜는 모두 한국 날짜 `YYYY-MM-DD` 다.

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * 이 파일이 다루는 출퇴근 검토 대기 사유. 「출퇴근으로 다시 계산」은 이것과 기간 중 계약 변경을 지금 데이터로 모두 새로 판정하고
 * 앞서 「확인」한 표시(확인 일시)는 지운다(2026-10-26 재영)
 */
export const ATTENDANCE_REVIEW_REASONS = [
  'MISSING_ATTENDANCE',
  'AFTER_CONTRACT_END',
  'ATTENDANCE_NEEDS_REVIEW',
] as const;

export const NO_ATTENDANCE_DETAIL = '급여 기간에 출퇴근 기록이 없습니다';
/** 상세에 날짜를 늘어놓는 최대 개수 — 넘으면 「외 N일」 */
const LISTED_DAYS = 10;
const WEEKDAYS: readonly Weekday[] = [
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
];
const weekdayOf = (day: string) =>
  WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const kstDate = (at: Date) =>
  new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const mmdd = (day: string) => day.slice(5);

export interface ContractSpan {
  start: string;
  /** 없으면 무기한 */
  end: string | null;
  workDays: readonly Weekday[];
}

export interface MissingDay {
  date: string;
  /** 출근 · 퇴근 모두 없음 · 퇴근 미등록 */
  kind: 'NONE' | 'NO_CHECK_OUT';
}

/**
 * 출퇴근 기록이 빠진 날 — 그날을 덮는 근로계약의 근무 요일인데 출근이 없는 날(출근 · 퇴근 모두 없음)과 출근만 있고 퇴근이 없는 날
 * (퇴근 미등록). 근무스케줄은 보지 않는다(STAFF-40 — 급여는 근로계약과 출퇴근 기록으로만). 급여 기간 안, 마지막 날(`until`)까지,
 * 퇴직일 이후는 빼고 날짜 내림차순.
 */
export function missingDays(input: {
  periodStart: string;
  until: string;
  contracts: readonly ContractSpan[];
  retiredDate: string | null;
  /** 출근한 날 → 그날 모든 출근에 퇴근 짝이 있는가 */
  checkedIn: ReadonlyMap<string, boolean>;
}): MissingDay[] {
  const out: MissingDay[] = [];
  for (let day = input.until; day >= input.periodStart; day = addDay(day, -1)) {
    if (input.retiredDate && day > input.retiredDate) continue;
    const closed = input.checkedIn.get(day);
    if (closed === false) {
      out.push({ date: day, kind: 'NO_CHECK_OUT' });
      continue;
    }
    if (closed) continue;
    const scheduled = input.contracts.some(
      (c) =>
        day >= c.start &&
        (c.end === null || day <= c.end) &&
        c.workDays.includes(weekdayOf(day)),
    );
    if (scheduled) out.push({ date: day, kind: 'NONE' });
  }
  return out;
}

/** 근로계약 만료 뒤 출근한 날 — 급여 기간에 걸친 계약 가운데 가장 늦은 종료일보다 뒤. 무기한 계약이 있으면 없다. 날짜 오름차순 */
export function afterContractEndDays(
  contracts: readonly ContractSpan[],
  checkedInDays: Iterable<string>,
): { end: string; days: string[] } | null {
  if (!contracts.length || contracts.some((c) => c.end === null)) return null;
  const end = contracts
    .map((c) => c.end!)
    .sort()
    .at(-1)!;
  const days = [...checkedInDays].filter((d) => d > end).sort();
  return days.length ? { end, days } : null;
}

const listed = (items: string[]) =>
  items.length > LISTED_DAYS
    ? `${items.slice(0, LISTED_DAYS).join(', ')} 외 ${items.length - LISTED_DAYS}일`
    : items.join(', ');

/** 「출퇴근 기록이 2일 누락되었습니다 — 09-05 퇴근 미등록, 08-22 출근·퇴근 모두 없음」(데모 payrolls-detail) */
export const missingDetail = (days: readonly MissingDay[]) =>
  `출퇴근 기록이 ${days.length}일 누락되었습니다 — ${listed(
    days.map(
      (d) =>
        `${mmdd(d.date)} ${d.kind === 'NONE' ? '출근·퇴근 모두 없음' : '퇴근 미등록'}`,
    ),
  )}`;

export const afterEndDetail = (r: { end: string; days: string[] }) =>
  `근로계약 만료일(${r.end}) 뒤 출퇴근 기록이 ${r.days.length}일 있습니다 — ${listed(r.days.map(mmdd))}`;

/**
 * 명세서 하나의 출퇴근 검토 대기 사유. 급여 기간(한국)의 그 직원 레코드 출퇴근 기록과 급여 기간에 걸친 근로계약(`contractIds`)을 본다.
 * - 출퇴근 누락: 기록이 한 건도 없으면 「급여 기간에 출퇴근 기록이 없습니다」, 있으면 빠진 날과 일수(오늘은 아직 끝나지 않아 어제까지).
 * - 계약 만료 후 기록: 가장 늦은 계약 종료일 뒤에 출근한 날.
 * - 확인 필요 기록 포함: 확인 필요 사유가 남은(검토 전) 기록 건수(ATT-11). 확인 필요 기록도 급여 계산에는 넣는다.
 */
export async function attendanceReviewReasons(
  db: Db,
  basis: {
    staffMemberId: number;
    contractIds: readonly number[];
    periodStartDate: Date;
    periodEndDate: Date;
  },
  now: Date = new Date(),
): Promise<Prisma.PayslipReviewReasonCreateManyPayslipInput[]> {
  const from = kstDayStart(basis.periodStartDate);
  const to = kstDayStart(addDays(basis.periodEndDate, 1));
  const [contracts, staff, checkIns, flagged] = await Promise.all([
    db.contract.findMany({
      where: { contractId: { in: [...basis.contractIds] } },
      select: {
        startDate: true,
        endDate: true,
        contractWorkDays: { select: { weekday: true } },
      },
    }),
    db.staffMember.findUniqueOrThrow({
      where: { staffMemberId: basis.staffMemberId },
      select: { retiredDate: true },
    }),
    db.attendanceRecord.findMany({
      where: {
        staffMemberId: basis.staffMemberId,
        kind: 'CHECK_IN',
        recordedAt: { gte: from, lt: to },
      },
      select: {
        recordedAt: true,
        _count: { select: { attendanceRecordsAsCheckIn: true } },
      },
    }),
    db.attendanceRecord.count({
      where: {
        staffMemberId: basis.staffMemberId,
        recordedAt: { gte: from, lt: to },
        reviewReason: { not: null },
      },
    }),
  ]);

  const checkedIn = new Map<string, boolean>();
  for (const r of checkIns) {
    const day = kstDate(r.recordedAt);
    const closed = r._count.attendanceRecordsAsCheckIn > 0;
    checkedIn.set(day, (checkedIn.get(day) ?? true) && closed);
  }
  const spans: ContractSpan[] = contracts.map((c) => ({
    start: c.startDate ? ymd(c.startDate) : ymd(basis.periodStartDate),
    end: c.endDate ? ymd(c.endDate) : null,
    workDays: c.contractWorkDays.map((d) => d.weekday),
  }));
  const reasons: Prisma.PayslipReviewReasonCreateManyPayslipInput[] = [];

  if (checkIns.length === 0)
    reasons.push({
      reviewReason: 'MISSING_ATTENDANCE',
      detail: NO_ATTENDANCE_DETAIL,
    });
  else {
    const yesterday = ymd(addDays(kstToday(now), -1));
    const periodEnd = ymd(basis.periodEndDate);
    const missing = missingDays({
      periodStart: ymd(basis.periodStartDate),
      until: periodEnd < yesterday ? periodEnd : yesterday,
      contracts: spans,
      retiredDate: staff.retiredDate ? ymd(staff.retiredDate) : null,
      checkedIn,
    });
    if (missing.length)
      reasons.push({
        reviewReason: 'MISSING_ATTENDANCE',
        detail: missingDetail(missing),
      });
  }
  const afterEnd = afterContractEndDays(spans, checkedIn.keys());
  if (afterEnd)
    reasons.push({
      reviewReason: 'AFTER_CONTRACT_END',
      detail: afterEndDetail(afterEnd),
    });
  if (flagged > 0)
    reasons.push({
      reviewReason: 'ATTENDANCE_NEEDS_REVIEW',
      detail: `급여 기간에 확인 필요 출퇴근 기록이 ${flagged}건 있습니다`,
    });
  return reasons;
}

/**
 * 명세서에 붙는 검토 대기 사유 모두 — 출퇴근 누락 · 기간 중 계약 변경(급여 기간에 걸친 계약이 둘 이상) · 그 밖의 출퇴근 사유 순.
 * 초안과 「출퇴근으로 다시 계산」이 같이 쓴다.
 */
export function reviewReasonsOf(
  attendance: readonly Prisma.PayslipReviewReasonCreateManyPayslipInput[],
  contractIds: readonly number[],
): Prisma.PayslipReviewReasonCreateManyPayslipInput[] {
  return [
    ...attendance.filter((r) => r.reviewReason === 'MISSING_ATTENDANCE'),
    ...(contractIds.length > 1
      ? [
          {
            reviewReason: 'CONTRACT_CHANGED' as const,
            detail: `급여 기간에 근로계약이 ${contractIds.length}건 걸쳐 있어 날마다 그날 효력이 있는 계약으로 나눠 계산했습니다`,
          },
        ]
      : []),
    ...attendance.filter((r) => r.reviewReason !== 'MISSING_ATTENDANCE'),
  ];
}

/**
 * 급여 기간에 효력이 있던 근로계약 — 체결 완료이거나 체결 완료에서 종료된 계약이고, 계약 기간이 급여 기간과 겹친다. 하루 배치가
 * 종료일 지난 체결 완료를 종료로 바꾸므로(WHALEERP-152) 지난달 명세서를 만들 때 그달에 끝난 계약이 빠지지 않게 종료된 계약도
 * 넣는다(api #150 리뷰). 종료된 계약의 효력 끝은 종료일과 종료 처리한 날(체결 완료 → 종료 이력의 시각) 가운데 이른 쪽이다 — 대체로
 * 닫힌 체결 완료는 원래 종료일이 남아 있어, 종료일만 보면 닫힌 뒤에도 매달 명세서 초안 · 계약 변경 검토 사유가 생긴다(api #152
 * 리뷰). 「체결 완료였다」는 종료 줄의 from 으로 본다 — 체결 이력 없이 넣은 옛 계약도 빠지지 않게. 종료일이 비면 체결 완료는 기간의
 * 정함이 없다. 초안 · 「출퇴근으로 다시 계산」 · 근태 요약이 같이 쓴다.
 */
export const validContractWhere = (periodStart: Date, periodEnd: Date) =>
  ({
    startDate: { lte: periodEnd },
    OR: [
      {
        status: 'SIGNED',
        OR: [{ endDate: { gte: periodStart } }, { endDate: null }],
      },
      {
        status: 'ENDED',
        OR: [{ endDate: { gte: periodStart } }, { endDate: null }],
        contractStatusHistories: {
          some: {
            fromStatus: 'SIGNED',
            toStatus: 'ENDED',
            changedAt: { gte: kstDayStart(periodStart) },
          },
        },
      },
    ],
  }) satisfies Prisma.ContractWhereInput;

/** 급여 기간에 효력이 있던 근로계약(`validContractWhere`) — 늦게 시작한 것부터 */
export async function periodContractIds(
  db: Db,
  staffMemberId: number,
  periodStartDate: Date,
  periodEndDate: Date,
): Promise<number[]> {
  const rows = await db.contract.findMany({
    where: {
      staffMemberId,
      ...validContractWhere(periodStartDate, periodEndDate),
    },
    orderBy: [{ startDate: 'desc' }, { contractId: 'desc' }],
    select: { contractId: true },
  });
  return rows.map((r) => r.contractId);
}
