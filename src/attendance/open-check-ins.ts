import type { Prisma } from '@prisma/client';
import { HQ_SHARING_SELECT } from '../admin-scope/hq-sharing';
import { addDays, kstToday } from '../staff-members/kst-date';
import { editableStart } from './attendance-rules';

/**
 * 점포들의 열린 출근 — 짝 퇴근이 없는 출근, 출근 시각순. 퇴직 처리(`assertNoOpenCheckIn`)와 같게 보정할 수 있는 3개월 안의 것만 —
 * 그보다 오래된 것은 아무도 닫을 수 없다. 퇴직한 직원 레코드의 것도 넣는다(그 점포에 남은 기록이다) — `employedOnly` 면 재직
 * 레코드의 것만(폐점 확인이 `retireStore` 와 같은 범위로 볼 때). 관리자 열린 출근 조회
 * (WHALEERP-644, 점포 하나)와 폐점 확인(647 · 650, 점포 여럿 — IN 으로 한 번에)이 같이 쓴다. 본사 역할에게 가릴지는 부르는 쪽이 정하므로 동의 칸을 함께 읽는다.
 */
export function openCheckInsOf(
  db: Pick<Prisma.TransactionClient, 'attendanceRecord'>,
  storeIds: number[],
  { employedOnly = false }: { employedOnly?: boolean } = {},
) {
  return db.attendanceRecord.findMany({
    where: {
      storeId: { in: storeIds },
      ...(employedOnly && { staffMember: { employmentStatus: 'EMPLOYED' } }),
      kind: 'CHECK_IN',
      attendanceRecordsAsCheckIn: { none: {} },
      recordedAt: { gte: editableStart() },
    },
    orderBy: [{ recordedAt: 'asc' }, { attendanceRecordId: 'asc' }],
    select: {
      storeId: true,
      attendanceRecordId: true,
      recordedAt: true,
      staffMember: {
        select: { staffMemberId: true, name: true, ...HQ_SHARING_SELECT },
      },
    },
  });
}

/** 출근한 다음 날이 지나 직원 앱으로는 퇴근할 수 없다 — 관리자 보정으로 닫는다(직원 앱 퇴근과 같은 기한) */
export const checkOutExpired = (recordedAt: Date, now: Date) =>
  kstToday(recordedAt) < addDays(kstToday(now), -1);
