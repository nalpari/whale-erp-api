import { Injectable, UnauthorizedException } from '@nestjs/common';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnly } from './date-only';
import type { MyProfileResponseDto } from './dto/my-profile.response.dto';
import { locationConsentOf } from './location-consent-state';

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
      },
    });
    if (!account || account.status === 'WITHDRAWN')
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);

    return {
      accountId: account.accountId,
      email: account.email,
      realName: account.realName,
      birthDate: dateOnly(account.birthDate)!,
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
      locationConsent: locationConsentOf(account.locationConsents),
    };
  }
}
