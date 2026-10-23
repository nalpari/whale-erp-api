import { Prisma } from '@prisma/client';

/** 재입사로 이은 레코드 하나와 시작 레코드에서 몇 걸음인지 */
export type LinkedRecord = { staffMemberId: number; depth: number };

/**
 * 재입사 연결(staff_members.previous_staff_member_id, WHALEERP-615)을 따라 이어진 같은 점포 레코드를 한 쿼리로 읽는다.
 * 'previous' 는 이 레코드가 이은 앞 레코드들, 'later' 는 이 레코드를 (건너서라도) 이은 뒤 레코드들 — 같은 레코드를 이은
 * 것이 둘 이상이면 모두다. 가까운 것부터(걸음 수, 같으면 ID 순). 지난 레코드는 다시 지나지 않아 사슬이 돌아도 멈춘다.
 */
export async function linkedRecords(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  staffMemberId: number,
  storeId: number,
  direction: 'previous' | 'later',
): Promise<LinkedRecord[]> {
  const rows =
    direction === 'previous'
      ? await db.$queryRaw<LinkedRecord[]>`
          WITH RECURSIVE chain(id, depth, path) AS (
            SELECT p.staff_member_id, 1, ARRAY[s.staff_member_id, p.staff_member_id]
              FROM staff_members s
              JOIN staff_members p ON p.staff_member_id = s.previous_staff_member_id
             WHERE s.staff_member_id = ${staffMemberId} AND p.store_id = ${storeId}
            UNION ALL
            SELECT p.staff_member_id, c.depth + 1, c.path || p.staff_member_id
              FROM chain c
              JOIN staff_members s ON s.staff_member_id = c.id
              JOIN staff_members p ON p.staff_member_id = s.previous_staff_member_id
             WHERE p.store_id = ${storeId} AND NOT p.staff_member_id = ANY(c.path)
          )
          SELECT id AS "staffMemberId", MIN(depth)::int AS depth FROM chain GROUP BY id ORDER BY 2, 1`
      : await db.$queryRaw<LinkedRecord[]>`
          WITH RECURSIVE chain(id, depth, path) AS (
            SELECT s.staff_member_id, 1, ARRAY[${staffMemberId}::int, s.staff_member_id]
              FROM staff_members s
             WHERE s.previous_staff_member_id = ${staffMemberId} AND s.store_id = ${storeId}
            UNION ALL
            SELECT s.staff_member_id, c.depth + 1, c.path || s.staff_member_id
              FROM chain c
              JOIN staff_members s ON s.previous_staff_member_id = c.id
             WHERE s.store_id = ${storeId} AND NOT s.staff_member_id = ANY(c.path)
          )
          SELECT id AS "staffMemberId", MIN(depth)::int AS depth FROM chain GROUP BY id ORDER BY 2, 1`;
  // 시작 레코드는 빼고 — 사슬이 돌아 시작 레코드로 돌아온 줄
  return rows.filter((r) => r.staffMemberId !== staffMemberId);
}
