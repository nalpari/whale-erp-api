import { Injectable, UnauthorizedException } from '@nestjs/common';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnly } from '../common/date-only';
import type { MyProfileResponseDto } from './dto/my-profile.response.dto';
import {
  locationConsentOf,
  needsLocationReconsent,
} from './location-consent-state';
import { currentLocationTermsVersion } from './location-terms';

@Injectable()
export class MyProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 직원 앱 내 정보 (WHALEERP-188) — 계정 칸과 계정에 붙은 동의 둘. 소속과 신고 정보는 `GET /me/memberships` 쪽이다.
   * 탈퇴 계정은 /auth/account/me 처럼 401 이다.
   */
  async get(accountId: number): Promise<MyProfileResponseDto> {
    const account = await this.prisma.account.findUnique({
      where: { accountId },
      select: {
        accountId: true,
        email: true,
        realName: true,
        birthDate: true,
        phone: true,
        zipCode: true,
        address: true,
        addressDetail: true,
        status: true,
        isHqSharingConsented: true,
        hqSharingConsentVersion: true,
        hqSharingAgreedAt: true,
        hqSharingWithdrawnAt: true,
        locationConsents: {
          select: {
            locationConsentId: true,
            consentVersion: true,
            agreedAt: true,
            pausedAt: true,
            withdrawnAt: true,
          },
        },
        createdAt: true,
        // 비밀번호를 마지막으로 정한 때 — 재설정 · 관리자 링크 · 내 정보 변경 모두 이 이력을 남긴다.
        accountChangeHistories: {
          where: { field: 'PASSWORD' },
          orderBy: [{ changedAt: 'desc' }, { accountChangeHistoryId: 'desc' }],
          take: 1,
          select: { changedAt: true },
        },
      },
    });
    if (!account || account.status === 'WITHDRAWN')
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    const locationConsent = locationConsentOf(account.locationConsents);
    const termsVersion = await currentLocationTermsVersion(this.prisma);

    return {
      accountId: account.accountId,
      email: account.email,
      realName: account.realName,
      birthDate: dateOnly(account.birthDate),
      phone: account.phone,
      zipCode: account.zipCode,
      address: account.address,
      addressDetail: account.addressDetail,
      status: account.status,
      hqSharingConsent: {
        isConsented: account.isHqSharingConsented,
        consentVersion: account.hqSharingConsentVersion,
        agreedAt: account.hqSharingAgreedAt,
        withdrawnAt: account.hqSharingWithdrawnAt,
      },
      locationConsent: {
        ...locationConsent,
        needsReconsent: needsLocationReconsent(locationConsent, termsVersion),
      },
      // 바꾼 적이 없으면 가입 때 정한 비밀번호다.
      passwordChangedAt:
        account.accountChangeHistories[0]?.changedAt ?? account.createdAt,
    };
  }
}
