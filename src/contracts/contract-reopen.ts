import { Prisma } from '@prisma/client';
import { CreateContractDto } from './dto/create-contract.dto';
import { checkWorkTimeOverlap, IN_PROGRESS } from './contract-duplicates';
import { LIVE_RENEWAL } from './signed-contract';

/** 거부 · 만료 재발송이 볼 계약 — 그 직원 · 직전 계약 */
export type ReopenTarget = {
  contractId: number;
  storeId: number;
  previousContractId: number | null;
  staffMember: {
    phone: string;
    employmentStatus: string;
    retiredDate: Date | null;
  };
};

/**
 * 거부 · 만료 계약을 다시 살릴 수 없는 까닭(WHALEERP-153) — 없으면 null. 재발송(contract-send)이 409 로, 상세의 canResend 가 버튼을
 * 숨기는 데 함께 쓴다.
 * - 폐점했거나 지운 점포의 계약은 살리지 않는다 — 거부 · 만료 계약만 남은 점포는 폐점할 수 있다(api #158 리뷰).
 * - 퇴직했거나 퇴직일을 정한(퇴직 예정) 직원에게는 보내지 않는다(CTR-25 — 다시 일하면 새 근로계약서). 재계약 임시저장을 보낼 때와
 *   같은 기준이다(api #158 리뷰 — 퇴직일이 지났을 때만 막으면 퇴직 예정 레코드에 연장 계약이 체결된다).
 * - 같은 점포 · 같은 번호에 다른 진행 중 계약이 있으면 둘이 함께 살아나지 않게 막는다.
 * - 같은 점포 · 같은 번호에 체결 완료인 다른 계약(이 계약의 직전 계약은 빼고)이 있으면 막는다 — 옛 조건의 계약이 새로 체결된 계약
 *   곁에서 다시 체결되지 않게(api #158 code-review). 이어 일하면 재계약(새 계약)으로 보낸다.
 * - 재계약이면 같은 직전 계약에 이어지는 다른 살아 있는 재계약이 있으면 막는다(한 계약에 살아 있는 재계약은 하나, WHALEERP-156).
 */
export async function reopenBlockOf(
  db: Prisma.TransactionClient,
  c: ReopenTarget,
): Promise<string | null> {
  const s = c.staffMember;
  const store = await db.store.findFirst({
    where: {
      storeId: c.storeId,
      isDeleted: false,
      storeStatusCode: { not: 'CLOSED' },
    },
    select: { storeId: true },
  });
  if (!store)
    return '폐점했거나 지운 점포의 근로계약서는 다시 보낼 수 없습니다';
  if (s.employmentStatus === 'RETIRED' || s.retiredDate !== null)
    return '퇴직했거나 퇴직일을 정한 직원에게는 근로계약서를 다시 보낼 수 없습니다. 다시 일하면 새 근로계약서를 작성해 주세요';
  const sameStaff = {
    contractId: { not: c.contractId },
    storeId: c.storeId,
    staffMember: { phone: s.phone },
  };
  if (
    await db.contract.findFirst({
      where: { ...sameStaff, status: { in: IN_PROGRESS } },
      select: { contractId: true },
    })
  )
    return '이 점포에 같은 직원의 진행 중인 근로계약이 있습니다. 그 근로계약을 확인해 주세요';
  if (
    await db.contract.findFirst({
      where: {
        ...sameStaff,
        status: 'SIGNED',
        ...(c.previousContractId !== null && {
          NOT: { contractId: c.previousContractId },
        }),
      },
      select: { contractId: true },
    })
  )
    return '이 점포에 같은 직원의 체결 완료된 근로계약이 있습니다. 이어 일하면 새 계약(재계약)을 보내 주세요';
  if (
    c.previousContractId !== null &&
    (await db.contract.findFirst({
      where: {
        contractId: { not: c.contractId },
        previousContractId: c.previousContractId,
        ...LIVE_RENEWAL,
      },
      select: { contractId: true },
    }))
  )
    return '직전 계약에 이어지는 다른 재계약이 있습니다. 그 근로계약을 확인해 주세요';
  return null;
}

/**
 * 거부 · 만료 계약을 살리기 전에 다른 점포와의 근무 시간 겹침을 본다(api #158 리뷰) — 거부 · 만료 계약은 겹침 검사가 보는 상태가
 * 아니어서, 그사이 다른 점포에 같은 시간 계약이 생겼을 수 있다. 저장 · 이어 쓰기와 같은 checkWorkTimeOverlap(409 WORK_TIME_OVERLAP)
 * 이다. 계약에 남은 근무 요일 · 기간으로 본다.
 */
export async function checkReopenWorkTime(
  db: Prisma.TransactionClient,
  contractId: number,
  phone: string,
): Promise<void> {
  const c = await db.contract.findUniqueOrThrow({
    where: { contractId },
    select: {
      storeId: true,
      startDate: true,
      endDate: true,
      contractWorkDays: {
        select: { weekday: true, startTime: true, endTime: true },
      },
    },
  });
  const day = (d: Date | null) =>
    d ? d.toISOString().slice(0, 10) : undefined;
  const hm = (d: Date) => d.toISOString().slice(11, 16);
  await checkWorkTimeOverlap(db, {
    storeId: c.storeId,
    phone,
    startDate: day(c.startDate),
    endDate: day(c.endDate),
    workDays: c.contractWorkDays.map((w) => ({
      weekday: w.weekday,
      startTime: hm(w.startTime),
      endTime: hm(w.endTime),
    })),
  } as CreateContractDto);
}
