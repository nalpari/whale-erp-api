import type { PrismaService } from '../prisma/prisma.service';

/**
 * 관리자 ID → 이름. 화면에 「누가」를 이름으로 보일 때 쓴다. 3팀 표는 `admin_accounts` 와 Prisma 관계가 없어(팀
 * 경계) `include` 대신 이것으로 읽는다. 지운 계정도 이름은 돌려준다 — 기록이 가리키는 사람은 그대로다. 없는 ID 는
 * Map 에 없고, 이름 칸이 NULL 이면 null 이다.
 */
export async function adminNames(
  prisma: Pick<PrismaService, 'adminAccount'>,
  ids: (number | null)[],
): Promise<Map<number | null, string | null>> {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
  if (wanted.length === 0) return new Map();
  const admins = await prisma.adminAccount.findMany({
    where: { adminAccountId: { in: wanted } },
    select: { adminAccountId: true, name: true },
  });
  return new Map(admins.map((a) => [a.adminAccountId, a.name]));
}
