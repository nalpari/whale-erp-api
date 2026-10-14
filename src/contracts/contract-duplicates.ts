import { ConflictException, HttpStatus } from '@nestjs/common';
import { ContractStatus, Prisma, Weekday } from '@prisma/client';
import { lockContract, transition } from './contract-status';
import { CreateContractDto } from './dto/create-contract.dto';

/**
 * 계약 중복 검사 (WHALEERP-129, 2026-10-13 김민식 결정).
 *   같은 점포 · 같은 번호에 진행 중 계약이 있으면 409 로 묻고, 관리자가 대체를 확인하면 기존 계약을 닫는다.
 *   다른 점포 · 같은 번호의 계약과 요일별 근무 시간이 겹치면 초안 저장(발송 전)을 409 로 막는다.
 * 같은 사람은 휴대전화번호로 본다 — 가입 전 직원 레코드에는 계정이 없다.
 */

/** 진행 중 — 체결 전이고 끝나지 않은 계약. 같은 점포에 둘이 되지 않게 대체를 묻는다. */
export const IN_PROGRESS: ContractStatus[] = [
  'DRAFT',
  'PENDING_SEND',
  'PENDING_SIGNATURE',
];
/** 근무 시간을 차지하는 다른 점포 계약 — 발송 대기부터 체결 완료까지. 임시저장은 아직 계약이 아니라 뺀다. */
const OCCUPYING: ContractStatus[] = [
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'SIGNED',
];

export type InProgressContract = {
  contractId: number;
  status: ContractStatus | null;
  staffMemberId: number;
};

const replacedMeanwhile = () =>
  new ConflictException(
    '다른 요청이 먼저 기존 근로계약을 고쳤습니다. 다시 저장해 주세요',
  );

/** 이 점포에서 같은 번호의 직원 레코드에 걸린 진행 중 계약. 이어 쓰는 계약 자신은 뺀다. */
export function inProgressAtStore(
  db: Prisma.TransactionClient,
  storeId: number,
  phone: string,
  exceptContractId?: number,
): Promise<InProgressContract[]> {
  return db.contract.findMany({
    where: {
      storeId,
      status: { in: IN_PROGRESS },
      staffMember: { phone },
      ...(exceptContractId !== undefined && {
        contractId: { not: exceptContractId },
      }),
    },
    select: { contractId: true, status: true, staffMemberId: true },
    orderBy: { contractId: 'asc' },
  });
}

/**
 * 진행 중 계약이 있는데 대체 확인(replaceContractIds)이 그 목록과 같지 않으면 409. 그사이 목록이 바뀌었으면
 * (다른 요청이 지웠거나 새로 만들었으면) 지금 목록으로 다시 묻는다. 진행 중 계약이 없으면 확인 값은 보지 않는다.
 */
export function checkReplace(
  current: InProgressContract[],
  confirmed: number[] | undefined,
): void {
  if (current.length === 0) return;
  const ids = new Set(confirmed ?? []);
  const same =
    ids.size === current.length && current.every((c) => ids.has(c.contractId));
  if (same) return;
  throw new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'CONTRACT_IN_PROGRESS',
    message:
      '이 점포에 같은 직원의 진행 중인 근로계약이 있습니다. 기존 계약을 대체할지 확인해 주세요',
    contracts: current.map((c) => ({
      contractId: c.contractId,
      status: c.status,
    })),
  });
}

/**
 * 대체 — 임시저장은 행을 지우고(보낸 적이 없다, 2026-10-12 결정), 발송 대기 · 서명 대기는 종료로 닫고 이력을 남긴다.
 * 계약마다 행을 잠그고 상태 · 점포 · 번호를 다시 읽는다. 읽은 뒤 다른 요청이 바꿨으면(이어 쓰기로 번호를 바꿈 ·
 * 삭제 · 상태 변경) 아무것도 지우지 않고 409 로 트랜잭션째 되돌린다. 직원 레코드는 남긴다 — 새 계약이 다시 쓴다.
 */
export async function replaceContracts(
  db: Prisma.TransactionClient,
  contracts: InProgressContract[],
  at: { storeId: number; phone: string },
): Promise<void> {
  for (const c of contracts) {
    await lockContract(db, c.contractId);
    const now = await db.contract.findUnique({
      where: { contractId: c.contractId },
      select: {
        status: true,
        storeId: true,
        staffMember: { select: { phone: true } },
      },
    });
    if (
      !now ||
      now.status !== c.status ||
      now.storeId !== at.storeId ||
      now.staffMember.phone !== at.phone
    )
      throw replacedMeanwhile();
    if (c.status === 'DRAFT') {
      const where = { contractId: c.contractId };
      await db.contractWorkDay.deleteMany({ where });
      await db.contractParty.deleteMany({ where });
      await db.contractStatusHistory.deleteMany({ where });
      const { count } = await db.contract.deleteMany({
        where: { ...where, status: 'DRAFT' },
      });
      if (count === 0) throw replacedMeanwhile();
      continue;
    }
    // 발송 대기 · 서명 대기는 종료로 닫는다 — 상태 전환(contract-status)이 다시 읽은 상태에서만 바꾸고 이력을 남긴다.
    await transition(db, c.contractId, 'ENDED', 'ADMIN', {
      from: now.status ? [now.status] : [],
    });
  }
}

/**
 * 가입 전(초안 · 초대) 직원 레코드 중 계약이 하나도 남지 않은 것을 지운다. 대체로 계약을 잃은 레코드가 쌓여
 * 같은 사람의 레코드가 점포에 여럿 되지 않게 한다. keep 은 새 계약이 쓰는 레코드다.
 */
export async function dropOrphanRecords(
  db: Prisma.TransactionClient,
  staffMemberIds: number[],
  keep: number,
): Promise<void> {
  const ids = staffMemberIds.filter((id) => id !== keep);
  if (ids.length === 0) return;
  await db.staffMember.deleteMany({
    where: {
      staffMemberId: { in: ids },
      joinStatus: { not: 'JOINED' },
      contracts: { none: {} },
    },
  });
}

type Period = { start: string | null; end: string | null };
type Shift = { weekday: Weekday; start: number; end: number };

const minutes = (hm: string) =>
  Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const timeOf = (d: Date) => d.toISOString().slice(11, 16);

/** 두 계약 기간이 하루라도 겹치는가. 시작일이 없으면 처음부터, 종료일이 없으면 끝없이로 본다. */
export function periodsOverlap(a: Period, b: Period): boolean {
  const startsBeforeEnd = (x: Period, y: Period) =>
    x.start === null || y.end === null || x.start <= y.end;
  return startsBeforeEnd(a, b) && startsBeforeEnd(b, a);
}

const WEEKDAY_ORDER: Weekday[] = [
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
];

/**
 * 요일이 같고 시업~종업이 겹치는 구간. 끝과 시작이 맞닿는 것(10:00 종업 · 10:00 시업)은 겹침이 아니다. 휴게는
 * 보지 않는다 — 휴게도 그 점포에 매인 시간이다. 같은 요일의 구간은 이어 붙여 하나로 준다.
 */
export function shiftOverlaps(mine: Shift[], others: Shift[]): Shift[] {
  const found: Shift[] = [];
  for (const m of mine)
    for (const o of others)
      if (m.weekday === o.weekday && m.start < o.end && o.start < m.end)
        found.push({
          weekday: m.weekday,
          start: Math.max(m.start, o.start),
          end: Math.min(m.end, o.end),
        });
  found.sort(
    (a, b) =>
      WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday) ||
      a.start - b.start,
  );
  const merged: Shift[] = [];
  for (const s of found) {
    const last = merged.at(-1);
    if (last && last.weekday === s.weekday && s.start <= last.end)
      last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** 둘 중 이른 날짜(YYYY-MM-DD). 없는 쪽은 끝없음이다. */
const earlier = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a < b ? a : b;

/**
 * 다른 점포에서 같은 번호로 근무 시간을 차지하는 계약과 기간 · 요일 · 시간이 겹치면 409. 겹쳤다는 것만 알린다 —
 * 다른 점포는 다른 BP 일 수 있어, 겹친 요일 · 시각을 주면 번호만으로 남의 근무 패턴을 캐낼 수 있다(운영 정책
 * CTR-26, 2026-10-13 재영). 퇴직한 직원 레코드의 계약은 퇴직일까지만 본다 — 퇴직 처리는 체결 완료 계약을 닫지
 * 않아, 그대로 두면 다른 점포의 새 계약을 영영 막는다.
 */
export async function checkWorkTimeOverlap(
  db: Prisma.TransactionClient,
  dto: CreateContractDto,
): Promise<void> {
  const mine: Shift[] = (dto.workDays ?? []).map((d) => ({
    weekday: d.weekday,
    start: minutes(d.startTime),
    end: minutes(d.endTime),
  }));
  if (mine.length === 0) return;
  const others = await db.contract.findMany({
    where: {
      storeId: { not: dto.storeId },
      status: { in: OCCUPYING },
      staffMember: { phone: dto.phone },
    },
    select: {
      startDate: true,
      endDate: true,
      staffMember: { select: { retiredDate: true } },
      contractWorkDays: {
        select: { weekday: true, startTime: true, endTime: true },
      },
    },
  });
  const period = { start: dto.startDate ?? null, end: dto.endDate ?? null };
  const overlaps = shiftOverlaps(
    mine,
    others
      .filter((o) =>
        periodsOverlap(period, {
          start: o.startDate ? isoDate(o.startDate) : null,
          end: earlier(
            o.endDate ? isoDate(o.endDate) : null,
            o.staffMember.retiredDate
              ? isoDate(o.staffMember.retiredDate)
              : null,
          ),
        }),
      )
      .flatMap((o) =>
        o.contractWorkDays.map((d) => ({
          weekday: d.weekday,
          start: minutes(timeOf(d.startTime)),
          end: minutes(timeOf(d.endTime)),
        })),
      ),
  );
  if (overlaps.length === 0) return;
  throw new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'WORK_TIME_OVERLAP',
    message: '다른 점포 근로계약과 근무 시간이 겹칩니다',
  });
}
