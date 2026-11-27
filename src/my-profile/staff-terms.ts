import { ConflictException, HttpStatus } from '@nestjs/common';
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

type TermsVersion = { termsVersionId: number; version: string };
/** 시행 중인 약관 셋. 마케팅은 선택 약관이라 없을 수 있다(운영자가 끄거나 지움) — 그때는 그 줄만 남기지 않는다 */
export type StaffTerms = {
  termsService: TermsVersion;
  privacy: TermsVersion;
  marketing: TermsVersion | null;
};

/**
 * 지금 시행 중인 직원 앱 약관 셋. 공개 약관 API · 관리자 가입 동의와 같은 규칙 — 시행일이 KST 오늘까지인 사용 중 버전 가운데
 * 늦게 시행한 것. 그래야 화면의 「보기」와 같은 버전에 동의가 남는다. 필수 둘 가운데 하나라도 없으면(운영자가 끄거나 지움) null 이다.
 * 선택 약관(마케팅)이 없는 것은 막지 않는다 — 1팀 공통 약관 하나를 꺼서 직원 가입이 멈추지 않게(api 리뷰).
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
  if (!termsService || !privacy) return null;
  return { termsService, privacy, marketing: marketing ?? null };
}

/** 동의 화면(가입 · 홈 약관 동의 팝업)이 보인 직원 앱 약관 버전 셋 */
export type ShownStaffTermsVersions = {
  termsServiceVersion: string;
  privacyVersion: string;
  /** 보인 마케팅 약관이 없었으면(시행 중인 것이 없음) null */
  marketingVersion: string | null;
};

/** 화면이 보인 직원 앱 약관 버전이 시행 중인 것과 다름(ACC-23) — 직원 앱이 이 사유를 그대로 보인다 */
export const TERMS_CHANGED =
  '그사이 약관이 바뀌었습니다. 바뀐 약관을 확인하고 다시 동의해 주세요.';

/**
 * 화면이 보인 약관 버전 셋이 시행 중인 것과 같아야 한다 — 다르면 409(code TERMS_CHANGED)로 거절해, 보인 약관과 남는 동의 버전이
 * 어긋나지 않게 한다(위치정보 · 본사 제공 동의와 같은 방식). 가입과 홈 약관 동의가 같이 쓴다.
 */
export function assertShownStaffTerms(
  terms: StaffTerms,
  shown: ShownStaffTermsVersions,
): void {
  if (
    shown.termsServiceVersion !== terms.termsService.version ||
    shown.privacyVersion !== terms.privacy.version ||
    shown.marketingVersion !== (terms.marketing?.version ?? null)
  )
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      code: 'TERMS_CHANGED',
      message: TERMS_CHANGED,
    });
}

/** 약관 동의 이력(account_terms_agreement_logs) — 필수 둘은 동의, 마케팅은 고른 대로(시행 중인 마케팅 약관이 없으면 두 줄) */
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
    ...(input.terms.marketing
      ? [row(input.terms.marketing.termsVersionId, input.marketingAgreed)]
      : []),
  ];
}
