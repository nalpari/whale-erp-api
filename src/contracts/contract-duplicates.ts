import { ConflictException, HttpStatus } from '@nestjs/common';
import { ContractStatus, Prisma, Weekday } from '@prisma/client';
import { lockContract, lockStaffMember, transition } from './contract-status';
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
  'CORRECTION_REQUESTED',
];
/** 근무 시간을 차지하는 다른 점포 계약 — 발송 대기부터 체결 완료까지. 임시저장은 아직 계약이 아니라 뺀다. */
const OCCUPYING: ContractStatus[] = [
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED',
  'SIGNED',
];

export type InProgressContract = {
  contractId: number;
  status: ContractStatus | null;
  staffMemberId: number;
  // 409 확인창에 누구 계약인지 보이려고 함께 읽는다(api #49 3차 리뷰)
  startDate: Date | null;
  endDate: Date | null;
  /** 재계약이면 직전 계약 — 잘못 올린 재계약을 바로잡을 때 그 직전 계약은 대체하지 않고 이어받는다(WHALEERP-156) */
  previousContractId: number | null;
  staffMember: { name: string };
};

const replacedMeanwhile = () =>
  new ConflictException(
    '다른 요청이 먼저 기존 근로계약을 고쳤습니다. 다시 저장해 주세요',
  );

/**
 * 대체할 수 있는 직원 행을 미리 id 순으로 한 번에 잠근다(write) — 이 점포 · 이 번호의 계약을 가진 직원 레코드와, 부르는
 * 쪽이 쓸 자기 직원 레코드(ownStaffMemberId). 직원 행을 하나씩 잡으면(자기 것 → 대체 대상을 계약 id 순) 직원 id 순으로
 * 잡는 근로계약 하루 배치와 엇갈려 교착(40P01)이 된다(api #150 리뷰). lockPeople 로 번호를 잡은 뒤, 다른 직원 행을 잡기
 * 전에 부른다 — 같은 번호의 레코드 · 계약은 그 번호를 잡아야 생기거나 바뀌므로 잠근 뒤 대체 대상이 늘지 않는다.
 * replaceContracts 의 직원 행 잠금은 이미 쥔 행이라 기다리지 않는다.
 */
export async function lockStaffForReplace(
  db: Prisma.TransactionClient,
  storeId: number,
  phone: string,
  ownStaffMemberId?: number,
): Promise<void> {
  await db.$executeRaw`
    SELECT 1 FROM staff_members
    WHERE staff_member_id = ${ownStaffMemberId ?? null}::int
      OR staff_member_id IN (
        SELECT c.staff_member_id FROM contracts c
        JOIN staff_members s ON s.staff_member_id = c.staff_member_id
        WHERE c.store_id = ${storeId} AND s.phone = ${phone}
      )
    ORDER BY staff_member_id
    FOR NO KEY UPDATE`;
}

/**
 * 이 점포에서 같은 번호의 직원 레코드에 걸린 진행 중 계약. 이어 쓰는 계약 자신은 뺀다.
 * withSigned 면 체결 완료도 넣는다 — 종이 계약의 「잘못 올린 계약 바로잡기」(correctSignedContracts)는 체결 완료도 곧바로
 * 대체한다(api #49 리뷰). 바로잡기가 아닌 종이 계약 등록은 체결 완료를 대체하지 않고 겹치면 막는다(hasOverlappingSigned,
 * WHALEERP-156 — 재계약의 앞 계약은 새 계약 시작일에 하루 배치가 닫는다).
 * 체결 완료는 이름 · 종료일 · 재직과 상관없이 같은 번호면 모두 묻는다. 이름으로 좁히면 오타를 고쳐 다시 등록할 때, 종료일로
 * 좁히면 끝난 계약서를 뒤늦게 두 번 등록할 때 두 벌이 생긴다(api #49 3차 리뷰). 누구 계약인지는 409 본문의 이름 · 기간으로
 * 관리자가 확인한다.
 */
export function inProgressAtStore(
  db: Prisma.TransactionClient,
  storeId: number,
  phone: string,
  exceptContractId?: number,
  withSigned = false,
): Promise<InProgressContract[]> {
  return db.contract.findMany({
    where: {
      storeId,
      status: { in: withSigned ? [...IN_PROGRESS, 'SIGNED'] : IN_PROGRESS },
      staffMember: { phone },
      ...(exceptContractId !== undefined && {
        contractId: { not: exceptContractId },
      }),
    },
    select: {
      contractId: true,
      status: true,
      staffMemberId: true,
      startDate: true,
      endDate: true,
      previousContractId: true,
      staffMember: { select: { name: true } },
    },
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
    message: current.some((c) => c.status === 'SIGNED')
      ? '이 점포에 같은 직원의 체결 완료되었거나 진행 중인 근로계약이 있습니다. 기존 계약을 대체할지 확인해 주세요'
      : '이 점포에 같은 직원의 진행 중인 근로계약이 있습니다. 기존 계약을 대체할지 확인해 주세요',
    contracts: listed(current),
  });
}

// 이름 · 기간은 확인창에서 누구 계약인지 보이려고 싣는다(번호를 넘겨받은 다른 사람의 계약일 수 있다)
const listed = (contracts: InProgressContract[]) =>
  contracts.map((c) => ({
    contractId: c.contractId,
    status: c.status,
    name: c.staffMember.name,
    startDate: c.startDate ? isoDate(c.startDate) : null,
    endDate: c.endDate ? isoDate(c.endDate) : null,
  }));

/**
 * 종이 계약 등록과 기간이 겹치는 체결 완료 계약이 이 점포 · 이 번호에 있는가(WHALEERP-156, 2026-10-26 김민식 · 재영 확인) —
 * 같은 계약서를 두 번 올리지 않게. 재계약의 직전 계약 · 이어 쓰는 계약 자신은 except 로 뺀다 — 직전 계약은 겹쳐도 새 계약
 * 시작일에 하루 배치가 닫는다. 시작일이 빈 옛 계약은 처음부터, 종료일이 빈 계약은 끝없이 이어지는 것으로 본다.
 */
/**
 * 바로잡기 · 겹침 409 가 대체할 계약 — 진행 중 계약은 모두, 체결 완료는 새 계약 기간과 겹치는 것만(api #157 리뷰). 겹치지 않는 체결
 * 완료(지금 효력인 직전 계약 등)를 함께 닫으면 관리자 종료라 「체결을 거친 계약」에서 빠져 남은 기간의 재직 · 급여가 사라진다.
 */
export function overlappingReplaceable(
  list: InProgressContract[],
  period: { start: string; end: string | null },
): InProgressContract[] {
  return list.filter(
    (c) =>
      c.status !== 'SIGNED' ||
      periodsOverlap(period, {
        start: c.startDate ? isoDate(c.startDate) : null,
        end: c.endDate ? isoDate(c.endDate) : null,
      }),
  );
}

/**
 * 잘못 올린 계약 바로잡기가 대체할 계약 — overlappingReplaceable 에서, 대체되는 재계약이 잇던 직전 계약은 뺀다(WHALEERP-156, api
 * #157 리뷰). 재계약은 직전 계약 기간 안에서 시작해 늘 그것과도 겹치는데, 함께 닫으면 직전 계약의 남은 기간 재직 · 급여가
 * 사라진다. 직전 계약은 다시 올린 계약이 이어받고(renewedPreviousOf), 그 시작일에 하루 배치가 닫는다.
 */
export function correctionTargets(
  list: InProgressContract[],
  period: { start: string; end: string | null },
  inherited: number[] = [],
): InProgressContract[] {
  const overlapping = overlappingReplaceable(list, period);
  // 이어진 줄의 앞 계약은 모두 남긴다 — C1 → C2 → C3 에서 C3 를 바로잡으면 C1 · C2 는 그대로다(api #157 재리뷰 4)
  const kept = new Set(
    signedRenewals(overlapping).map((c) => c.previousContractId),
  );
  // 이어받는 직전 계약(재계약의 직전 · 이어 쓰는 계약 자신)은 남길 계약을 정한 뒤에 뺀다 — 먼저 빼면 그것이 잇는 앞 계약이
  // 남길 계약에서 빠져 함께 닫히거나 겹침으로 잡힌다(api #157 재리뷰 5 · 셀프 code-review)
  return overlapping.filter(
    (c) => !kept.has(c.contractId) && !inherited.includes(c.contractId),
  );
}

/** 목록의 체결 완료 재계약(직전 계약이 있는 체결 완료) */
const signedRenewals = (list: InProgressContract[]) =>
  list.filter(
    (c) => c.status === 'SIGNED' && typeof c.previousContractId === 'number',
  );

/**
 * 바로잡기로 대체되는 체결 완료 재계약 — 이어진 줄의 끝만. 겹치는 목록에서 다른 재계약의 직전 계약인 재계약은 지금 효력인
 * 직전 계약이라 대체하지 않는다(C1 → C2 → C3 에서 C3 를 바로잡으면 C2 는 남고 C1 은 보지 않는다, api #157 재리뷰 3 · 4).
 */
export function replacedRenewals(
  list: InProgressContract[],
): InProgressContract[] {
  const renewals = signedRenewals(list);
  const previous = new Set(renewals.map((c) => c.previousContractId));
  return renewals.filter((c) => !previous.has(c.contractId));
}

/** 바로잡기로 대체되는 체결 완료 재계약들이 잇던 직전 계약 */
export function renewedPreviousIds(list: InProgressContract[]): number[] {
  return [
    ...new Set(
      replacedRenewals(list).map((c) => c.previousContractId as number),
    ),
  ];
}

export async function hasOverlappingSigned(
  db: Prisma.TransactionClient,
  storeId: number,
  phone: string,
  period: { start: string; end: string | null },
  except: number[],
): Promise<boolean> {
  const found = await db.contract.findFirst({
    where: {
      storeId,
      status: 'SIGNED',
      staffMember: { phone },
      contractId: { notIn: except },
      AND: [
        {
          OR: [{ endDate: null }, { endDate: { gte: utcDate(period.start) } }],
        },
        ...(period.end
          ? [
              {
                OR: [
                  { startDate: null },
                  { startDate: { lte: utcDate(period.end) } },
                ],
              },
            ]
          : []),
      ],
    },
    select: { contractId: true },
  });
  return found !== null;
}

/**
 * 종이 계약이 체결 완료 계약과 겹칠 때의 409(code SIGNED_CONTRACT_OVERLAP). 잘못 올린 계약을 바로잡으려면
 * correctSignedContracts 와 함께 contracts 의 id 를 모두 replaceContractIds 로 다시 보낸다 — 바로잡기가 대체할 계약(같은 점포 ·
 * 같은 번호의 체결 완료 · 진행 중 계약)을 싣는다. 재계약이면 바로잡기를 쓸 수 없어 code RENEWAL_SIGNED_OVERLAP 으로 막기만 한다
 * (직전 계약이 아닌 체결 완료와 겹쳤다 — contracts 는 확인용으로 같이 싣는다).
 */
export function signedOverlap(
  replaceable: InProgressContract[],
  renewal = false,
): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: renewal ? 'RENEWAL_SIGNED_OVERLAP' : 'SIGNED_CONTRACT_OVERLAP',
    message: renewal
      ? '이 점포에 같은 직원의 직전 계약이 아닌 체결 완료 근로계약과 계약 기간이 겹쳐 재계약을 등록할 수 없습니다. 그 계약을 먼저 확인해 주세요'
      : '이 점포에 같은 직원의 계약 기간이 겹치는 체결 완료 근로계약이 있습니다. 잘못 올린 계약이면 「잘못 올린 계약 바로잡기」로 다시 등록해 주세요',
    contracts: listed(replaceable),
  });
}

/**
 * 대체 — 임시저장은 행을 지우고(보낸 적이 없다, 2026-10-12 결정), 발송 대기 · 서명 대기는 종료로 닫고 이력을 남긴다.
 * 계약마다 행을 잠그고 상태 · 점포 · 번호를 다시 읽는다. 읽은 뒤 다른 요청이 바꿨으면(이어 쓰기로 번호를 바꿈 ·
 * 삭제 · 상태 변경) 아무것도 지우지 않고 409 로 트랜잭션째 되돌린다. 직원 레코드는 남긴다 — 새 계약이 다시 쓴다. 그 레코드의
 * 나가 있던 초대는 무효로 한다.
 */
export async function replaceContracts(
  db: Prisma.TransactionClient,
  contracts: InProgressContract[],
  at: { storeId: number; phone: string },
): Promise<void> {
  for (const c of contracts) {
    // 직원 행 → 계약 행 — 대체는 그 계약의 가입 전 직원 레코드를 지울 수 있다(dropOrphanRecords, api #104)
    await lockStaffMember(db, c.staffMemberId, 'write');
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
    // 발송 대기 · 서명 대기(종이 계약 바로잡기면 체결 완료도)는 종료로 닫는다 — 상태 전환(contract-status)이 다시 읽은
    // 상태에서만 바꾸고 이력을 남긴다.
    await transition(db, c.contractId, 'ENDED', 'ADMIN', {
      from: now.status ? [now.status] : [],
    });
  }
  // 대체된 계약의 직원 레코드에 나가 있던 초대는 무효로 한다 — 종료된 계약으로 이어지는 링크를 남기지 않는다. 퇴직(예정) ·
  // 다른 이름 레코드는 새 계약이 다시 쓰지 않아 보내기(prepare)가 그 초대를 닫지 못한다(api #65 재리뷰).
  const records = [...new Set(contracts.map((c) => c.staffMemberId))];
  if (records.length)
    await db.invitation.updateMany({
      where: { staffMemberId: { in: records }, status: 'SENT' },
      data: { status: 'EXPIRED' },
    });
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
  const orphan = {
    staffMemberId: { in: ids },
    joinStatus: { not: 'JOINED' },
    contracts: { none: {} },
  } satisfies Prisma.StaffMemberWhereInput;
  // 지울 레코드를 이전 재직 레코드로 가리키는 재입사 레코드가 있으면 끊는다(WHALEERP-615, 외래키 RESTRICT). 이을 대상은
  // 퇴직 레코드라 계약이 남아 여기서 지워지지 않지만, 그런 연결이 생겨도 삭제가 외래키 오류(500)가 되지 않게.
  await db.staffMember.updateMany({
    where: { previousStaffMember: orphan },
    data: { previousStaffMemberId: null },
  });
  await db.staffMember.deleteMany({ where: orphan });
}

type Period = { start: string | null; end: string | null };
type Shift = { weekday: Weekday; start: number; end: number };

const minutes = (hm: string) =>
  Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const utcDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
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
