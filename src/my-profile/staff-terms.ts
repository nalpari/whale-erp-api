import type { Prisma, TermsAgreementChannel } from '@prisma/client';
import { kstToday } from '../staff-members/kst-date';

/**
 * 직원 앱 약관 셋(운영 정책 ACC-23, WHALEERP-774) — 필수 둘(서비스 이용약관 · 개인정보 수집·이용)과 선택 하나(마케팅 정보 수신).
 * 본문은 1팀 terms_versions 에 있고 공개 약관 API(`GET /public-terms-versions/:termsTypeCode`)로 화면이 읽는다.
 */
const STAFF_TERMS_TYPES = {
  termsService: 'STAFF_TERMS_SERVICE',
  privacy: 'STAFF_PRIVACY',
  marketing: 'MARKETING',
} as const;

type StaffTermsKey = keyof typeof STAFF_TERMS_TYPES;
export type StaffTerms = Record<
  StaffTermsKey,
  { termsVersionId: number; version: string }
>;

/**
 * 지금 시행 중인 직원 앱 약관 셋. 공개 약관 API · 관리자 가입 동의와 같은 규칙 — 시행일이 KST 오늘까지인 사용 중 버전 가운데
 * 늦게 시행한 것. 그래야 화면의 「보기」와 같은 버전에 동의가 남는다. 하나라도 없으면(운영자가 끄거나 지움) null 이다.
 */
export async function currentStaffTerms(db: {
  termsVersion: Pick<Prisma.TransactionClient['termsVersion'], 'findMany'>;
}): Promise<StaffTerms | null> {
  const rows = await db.termsVersion.findMany({
    where: {
      termsTypeCode: { in: Object.values(STAFF_TERMS_TYPES) },
      isActive: true,
      isDeleted: false,
      effectiveDate: { lte: kstToday() },
    },
    orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
    select: { termsTypeCode: true, termsVersionId: true, version: true },
  });
  const pick = (code: string) => {
    const row = rows.find((r) => r.termsTypeCode === code);
    return row && { termsVersionId: row.termsVersionId, version: row.version };
  };
  const termsService = pick(STAFF_TERMS_TYPES.termsService);
  const privacy = pick(STAFF_TERMS_TYPES.privacy);
  const marketing = pick(STAFF_TERMS_TYPES.marketing);
  if (!termsService || !privacy || !marketing) return null;
  return { termsService, privacy, marketing };
}

/** 약관 동의 이력 세 줄(account_terms_agreement_logs) — 필수 둘은 동의, 마케팅은 고른 대로 */
export function staffTermsAgreementRows(input: {
  accountId: number;
  terms: StaffTerms;
  marketingAgreed: boolean;
  channel: TermsAgreementChannel;
  agreedAt: Date;
  clientAddress?: string;
}): Prisma.AccountTermsAgreementLogCreateManyInput[] {
  const row = (termsVersionId: number, isAgreed: boolean) => ({
    accountId: input.accountId,
    termsVersionId,
    isAgreed,
    agreedAt: input.agreedAt,
    channel: input.channel,
    clientAddress: input.clientAddress ?? null,
  });
  return [
    row(input.terms.termsService.termsVersionId, true),
    row(input.terms.privacy.termsVersionId, true),
    row(input.terms.marketing.termsVersionId, input.marketingAgreed),
  ];
}
