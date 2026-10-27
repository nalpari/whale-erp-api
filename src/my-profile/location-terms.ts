import type { Prisma } from '@prisma/client';
import { kstToday } from '../staff-members/kst-date';

/**
 * 지금 시행 중인 위치정보 약관(`LOCATION`)의 버전. 공개 약관 API · 회원가입 동의와 같은 규칙 — 시행일이 KST 오늘까지인 것
 * 중 늦은 것. 그래야 화면의 「약관 보기」와 같은 버전에 동의가 남는다. 운영자가 모두 끄거나 지웠으면 null 이다.
 * 위치정보 동의 · 내 정보 · 출퇴근 등록이 같이 쓴다(ATT-23 — 버전이 바뀌면 다음 출퇴근 등록 때 다시 동의를 받는다).
 */
export async function currentLocationTermsVersion(
  db: Pick<Prisma.TransactionClient, 'termsVersion'>,
): Promise<string | null> {
  const terms = await db.termsVersion.findFirst({
    where: {
      termsTypeCode: 'LOCATION',
      isActive: true,
      isDeleted: false,
      effectiveDate: { lte: kstToday() },
    },
    orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
    select: { version: true },
  });
  return terms?.version ?? null;
}
