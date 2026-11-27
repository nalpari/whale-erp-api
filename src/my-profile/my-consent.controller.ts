import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AccountUser } from '../auth/auth.types';
import { AgreeHqSharingConsentDto } from './dto/agree-hq-sharing-consent.dto';
import { AgreeLocationConsentDto } from './dto/agree-location-consent.dto';
import { AgreeTermsDto } from './dto/agree-terms.dto';
import { MyConsentService } from './my-consent.service';

/**
 * 직원 앱 내 정보의 위치정보 동의 · 본사 제공 동의 (WHALEERP-193)와 약관 동의 (ACC-23, WHALEERP-774). 토큰의 계정에 쓴다 — 위치정보 동의 · 본사 제공 동의만 보여
 * 준 약관 · 문구 버전을 본문에 싣고(필수), 나머지는 본문이 없다. 지금 상태와 맞지
 * 않으면(이미 철회 등) 409 이고, 화면은 `GET /me/profile` 을 다시 받는다
 */
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@ApiConflictResponse({ description: '지금 동의 상태에서 할 수 없는 동작' })
@UserTypes('account')
@Controller('me')
export class MyConsentController {
  constructor(private readonly consents: MyConsentService) {}

  /**
   * 위치정보 동의 — 미동의 · 철회 상태에서. 지금 시행 중인 위치정보 약관 버전에 동의한 것으로 남는다 (ATT-23). 본문의
   * `termsVersion`(화면이 보여 준 버전, 필수 · null 가능)이 그와 다르면 409 — 화면은 다시 받아 새 약관을 보인다. 빼면 400
   */
  @Post('location-consent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBody({ type: AgreeLocationConsentDto })
  @ApiNoContentResponse({ description: '동의함' })
  @ApiConflictResponse({
    description:
      '이미 같은 버전에 동의함 · 화면이 보여 준 약관 버전(termsVersion)이 시행 중인 것과 다름(그사이 바뀜, 보인 약관이 없었는데(null) 시행 중인 약관이 있음 — 화면은 다시 받는다)',
  })
  @ApiBadRequestResponse({
    description:
      'termsVersion 없음 · 빈 문자열 · 문자열 아님 · 64자 초과 · 모르는 칸',
  })
  @ApiInternalServerErrorResponse({
    description:
      '시행 중인 위치정보 약관이 없음(운영자가 모두 끄거나 지움) — 「지금은 위치정보 동의를 받을 수 없습니다 …」',
  })
  agreeLocation(
    @CurrentUser() user: AccountUser,
    @Body() dto: AgreeLocationConsentDto,
  ): Promise<void> {
    return this.consents.agreeLocation(user.id, dto.termsVersion);
  }

  /** 위치정보 잠시 멈춤 (ATT-26) */
  @Post('location-consent/pause')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: '멈춤' })
  pauseLocation(@CurrentUser() user: AccountUser): Promise<void> {
    return this.consents.pauseLocation(user.id);
  }

  /** 위치정보 다시 켜기 (ATT-26) — 새로 동의하지 않는다 */
  @Post('location-consent/resume')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: '다시 켬' })
  resumeLocation(@CurrentUser() user: AccountUser): Promise<void> {
    return this.consents.resumeLocation(user.id);
  }

  /** 위치정보 동의 철회 (ATT-23). 멈춘 동안에도 된다 */
  @Post('location-consent/withdraw')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: '철회함' })
  withdrawLocation(@CurrentUser() user: AccountUser): Promise<void> {
    return this.consents.withdrawLocation(user.id);
  }

  /**
   * 본사 제공 동의 — 처음이든 철회 뒤든, 내 정보의 `needsReconsent` 로 다시 동의할 때든 (ATT-30). 계정에 하나라 소속 가맹
   * 점포 모두에 같이 적용된다. 본문의 `consentVersion`(화면이 보여 준 문구 버전, 필수)이 지금 버전과 다르면 409 — 화면은 새로
   * 고쳐 새 문구를 보인다(ATT-30 v252). 빼면 400
   */
  @Post('hq-sharing-consent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBody({ type: AgreeHqSharingConsentDto })
  @ApiNoContentResponse({ description: '동의함' })
  @ApiConflictResponse({
    description:
      '이미 지금 버전에 동의함 · 화면이 보여 준 문구 버전(consentVersion)이 지금 것과 다름 — 「사업자 제공 동의 내용이 바뀌었습니다. …」(화면은 새로 고친다)',
  })
  @ApiBadRequestResponse({
    description:
      'consentVersion 없음 · 빈 문자열 · 문자열 아님 · 64자 초과 · 모르는 칸',
  })
  agreeHqSharing(
    @CurrentUser() user: AccountUser,
    @Body() dto: AgreeHqSharingConsentDto,
  ): Promise<void> {
    return this.consents.agreeHqSharing(user.id, dto.consentVersion);
  }

  /**
   * 약관 동의 — 약관 동의를 받기 전에 가입한 직원이 홈에서 한다(내 정보의 `needsTermsAgreement`, ACC-23). 필수 둘(서비스
   * 이용약관 · 개인정보 수집·이용)에 동의하고 마케팅 정보 수신은 고른 대로다. 이력(경로 FIRST_LOGIN · 접속 IP)을 남긴다. 본문의
   * 약관 버전 셋(동의 시트가 보인 것, 필수)이 시행 중인 것과 다르면 409(code TERMS_CHANGED) — 화면은 약관을 다시 받는다
   */
  @Post('terms-agreement')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBody({ type: AgreeTermsDto })
  @ApiNoContentResponse({ description: '동의함' })
  @ApiConflictResponse({
    description:
      '이미 동의함(TERMS_ALREADY_AGREED — 앱은 팝업을 내린다, 버전 비교보다 먼저) · 보인 약관 버전이 시행 중인 것과 다름(TERMS_CHANGED — 「그사이 약관이 바뀌었습니다. …」, 화면은 다시 받는다)',
  })
  @ApiBadRequestResponse({
    description:
      '약관 버전(termsServiceVersion · privacyVersion · marketingVersion) 없음 · 빈 문자열 · 64자 초과 · marketingAgreed 가 참 · 거짓이 아님 · 모르는 칸',
  })
  @ApiInternalServerErrorResponse({
    description:
      '필수 약관(STAFF_TERMS_SERVICE · STAFF_PRIVACY) 가운데 시행 중인 것이 없음(운영자가 끄거나 지움) — 「지금은 약관 동의를 받을 수 없습니다 …」',
  })
  agreeTerms(
    @CurrentUser() user: AccountUser,
    @Body() dto: AgreeTermsDto,
    @Ip() ip: string | undefined,
  ): Promise<void> {
    const { marketingAgreed, ...shown } = dto;
    return this.consents.agreeTerms(
      user.id,
      shown,
      marketingAgreed ?? false,
      ip,
    );
  }

  /** 본사 제공 동의 철회 (ATT-30) */
  @Post('hq-sharing-consent/withdraw')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: '철회함' })
  withdrawHqSharing(@CurrentUser() user: AccountUser): Promise<void> {
    return this.consents.withdrawHqSharing(user.id);
  }
}
