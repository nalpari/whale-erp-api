import { ConflictException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  checkWorkTimeOverlap,
  hasOverlappingSigned,
  IN_PROGRESS,
  isoDate,
  timeOf,
} from './contract-duplicates';
import { kstToday } from '../staff-members/kst-date';
import { LIVE_RENEWAL, SIGNED_ONCE } from './signed-contract';

/** 거부 · 만료 재발송이 볼 계약 — 그 직원 · 직전 계약 */
export type ReopenTarget = {
  contractId: number;
  storeId: number;
  previousContractId: number | null;
  startDate: Date | null;
  endDate: Date | null;
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
 * - 계약 기간이 이미 끝났으면 막는다 — 되살려 체결해도 바로 종료된다(api #158 code-review). 새 근로계약서로 보낸다.
 * - 같은 점포 · 같은 번호에 이 계약 기간과 겹치거나 이 계약보다 늦게 시작한 체결 완료인 다른 계약(이 계약의 직전 계약은 빼고)이
 *   있으면 막는다 — 옛 조건의 계약이 새로 체결된 계약 곁이나 앞에서 다시 체결되지 않게(api #158 code-review). 이 계약보다 먼저
 *   끝난 체결 완료는 막지 않는다(api #158 리뷰). 시작일이 빈 옛 계약은 기간을 알 수 없어 다른 체결 완료가 하나라도 있으면 막는다
 *   (api #158 code-review — 건너뛰면 지금 체결 완료 곁에서 되살아난다).
 *   이어 일하면 재계약(새 계약)으로 보낸다.
 * lock 이면 점포를 FOR SHARE 로 잠가 읽는다 — 재발송 트랜잭션에서 폐점(점포 행을 잠근 뒤 진행 중 계약을 센다)과 엇갈려 폐점한
 * 점포에 계약이 되살아나지 않게(api #158 리뷰). 상세의 canResend 는 트랜잭션 밖이라 잠그지 않는다(api #158 code-review).
 * - 재계약이면 같은 직전 계약에 이어지는 다른 살아 있는 재계약이 있으면 막는다(한 계약에 살아 있는 재계약은 하나, WHALEERP-156).
 */
export async function reopenBlockOf(
  db: Prisma.TransactionClient,
  c: ReopenTarget,
  lock: boolean,
  now = new Date(),
): Promise<string | null> {
  const s = c.staffMember;
  const open = await db.$queryRaw<{ store_id: number }[]>`
    SELECT store_id FROM stores
    WHERE store_id = ${c.storeId} AND is_deleted = false AND store_status_code <> 'CLOSED'
    ${lock ? Prisma.sql`FOR SHARE` : Prisma.empty}`;
  if (open.length === 0)
    return '폐점했거나 지운 점포의 근로계약서는 다시 보낼 수 없습니다.';
  if (s.employmentStatus === 'RETIRED' || s.retiredDate !== null)
    return '퇴직했거나 퇴직일을 정한 직원에게는 근로계약서를 다시 보낼 수 없습니다. 다시 일하면 새 근로계약서를 작성해 주세요.';
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
    return '이 점포에 같은 직원의 진행 중인 근로계약이 있습니다. 그 근로계약을 확인해 주세요.';
  if (c.endDate !== null && c.endDate < kstToday(now))
    return '계약 기간이 끝난 근로계약서는 다시 보낼 수 없습니다. 새 근로계약서를 작성해 주세요.';
  // 끝을 열어 두면 「겹침」과 「이 계약보다 늦게 시작함」을 한 번에 본다 — 늦게 시작한 계약은 이 시작일 뒤에 끝난다. 기간이 끝나
  // 배치가 닫은 계약도 본다(SIGNED_ONCE). 이 계약이 잇는 줄의 앞 계약(직전 계약과 그 앞)은 치지 않는다 — 만들 때의 겹침 검사
  // (checkSignedOverlap)와 같다. 하루 배치가 차례로 닫는다(api #158 재리뷰 참고 1 · 2)
  if (
    await hasOverlappingSigned(
      db,
      c.storeId,
      s.phone,
      { start: c.startDate ? isoDate(c.startDate) : null, end: null },
      [c.contractId, ...(await chainOf(db, c.previousContractId))],
      SIGNED_ONCE,
    )
  )
    return '이 점포에 같은 직원의 체결 완료된 근로계약이 있습니다. 이어 일하면 새 계약(재계약)을 보내 주세요.';
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
    return '직전 계약에 이어지는 다른 재계약이 있습니다. 그 근로계약을 확인해 주세요.';
  return null;
}

/** 직전 계약부터 거슬러 올라간 재계약 줄의 앞 계약들 — 고리가 생겨도 멈추게 본 것은 다시 보지 않는다 */
async function chainOf(
  db: Prisma.TransactionClient,
  previousContractId: number | null,
): Promise<number[]> {
  const chain: number[] = [];
  let id = previousContractId;
  while (id !== null && !chain.includes(id)) {
    chain.push(id);
    const prev = await db.contract.findUnique({
      where: { contractId: id },
      select: { previousContractId: true },
    });
    id = prev?.previousContractId ?? null;
  }
  return chain;
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
  await checkWorkTimeOverlap(db, {
    storeId: c.storeId,
    phone,
    startDate: c.startDate ? isoDate(c.startDate) : undefined,
    endDate: c.endDate ? isoDate(c.endDate) : undefined,
    workDays: c.contractWorkDays.map((w) => ({
      weekday: w.weekday,
      startTime: timeOf(w.startTime),
      endTime: timeOf(w.endTime),
    })),
  });
}

/**
 * 거부 · 만료를 되살릴 수 없을 때의 409(code REOPEN_BLOCKED) — 화면이 「화면이 낡음」으로 새로 읽지 않고 그 까닭을 보이게 code 를
 * 붙인다(api #158 리뷰).
 */
export const reopenBlocked = (message: string) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'REOPEN_BLOCKED',
    message,
  });

/**
 * 상세의 canResend 용 — 다른 점포 근무 시간과 겹치지 않는가(재발송의 checkReopenWorkTime 과 같은 판정). 겹침(409
 * WORK_TIME_OVERLAP)만 false 로 바꾸고 다른 오류는 그대로 던진다(api #158 code-review).
 */
export async function reopenWorkTimeFree(
  db: Prisma.TransactionClient,
  contractId: number,
  phone: string,
): Promise<boolean> {
  try {
    await checkReopenWorkTime(db, contractId, phone);
    return true;
  } catch (e) {
    if (
      e instanceof ConflictException &&
      (e.getResponse() as { code?: string }).code === 'WORK_TIME_OVERLAP'
    )
      return false;
    throw e;
  }
}
