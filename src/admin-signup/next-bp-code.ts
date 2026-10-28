import type { Prisma } from '@prisma/client';

/**
 * 다음 BP 코드 — 회원가입과 플랫폼의 BP 등록(bp-masters)이 함께 쓴다. 트랜잭션 스코프 advisory lock 으로
 * 채번을 한 줄로 세운다 — 잠그지 않으면 동시 등록 둘이 같은 최댓값을 읽고 둘째가 bp_codes_bp_code_key
 * 위반으로 500 이 된다. 삭제·탈퇴한 BP 의 코드도 다시 쓰지 않으므로 행을 거르지 않는다. BP000000(플랫폼)이
 * 가장 작아 첫 고객 BP 는 BP000001 이다.
 */
export async function nextBpCode(
  tx: Prisma.TransactionClient,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bp_codes.bp_code'))`;
  const last = await tx.bpCode.findFirst({
    orderBy: { bpCode: 'desc' },
    select: { bpCode: true },
  });
  const next = Number(last?.bpCode.slice(2) ?? 0) + 1;
  if (next > 999_999) throw new Error('BP 코드를 더 채번할 수 없습니다');
  return `BP${String(next).padStart(6, '0')}`;
}
