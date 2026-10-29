import type { PrismaService } from '../prisma/prisma.service';

/**
 * 은행 코드 → 이름(BANK 공통코드, 예 KB국민은행). 공통코드에 없으면 은행 코드 그대로. 플랫폼 원본(PLATFORM_BP_CODE)이 먼저
 * 오도록 bpCode 오름차순으로 정렬한다 — 플랫폼 원본 BP(BP000000)가 가장 작은 BP 코드라는 가정에 기댄다. 사용 중지 · 삭제된
 * 은행이어도 이름은 보여 준다. 직원 상세 급여 계좌(WHALEERP-183)와 근로계약 상세 신고 정보(WHALEERP-155)가 쓴다.
 */
export async function bankNameOf(
  prisma: Pick<PrismaService, 'codeItem'>,
  bankCode: string,
): Promise<string> {
  const bank = await prisma.codeItem.findFirst({
    where: { groupCode: 'BANK', itemCode: bankCode },
    orderBy: { bpCode: 'asc' },
    select: { label: true },
  });
  return bank?.label ?? bankCode;
}
