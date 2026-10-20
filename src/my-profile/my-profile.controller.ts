import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AccountUser } from '../auth/auth.types';
import { signedInUserTracker } from '../auth/throttle';
import { ChangeMyEmailDto } from './dto/change-my-email.dto';
import { ChangeMyPasswordDto } from './dto/change-my-password.dto';
import { MyProfileResponseDto } from './dto/my-profile.response.dto';
import { RequestEmailChangePinDto } from './dto/request-email-change-pin.dto';
import { UpdateMyAddressDto } from './dto/update-my-address.dto';
import { MyAddressService } from './my-address.service';
import { MyEmailChangeService } from './my-email-change.service';
import { MyPasswordService } from './my-password.service';
import { MyProfileService } from './my-profile.service';

/** 직원 근무 앱의 내 정보 (WHALEERP-188) · 주소 수정(189) · 이메일 변경(191) · 비밀번호 변경(192) */
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/profile')
export class MyProfileController {
  constructor(
    private readonly profile: MyProfileService,
    private readonly addresses: MyAddressService,
    private readonly passwords: MyPasswordService,
    private readonly emails: MyEmailChangeService,
  ) {}

  /** 내 정보 — 계정 칸, 본사 제공 동의(계정에 하나), 위치정보 동의. 소속 근무지는 `GET /me/memberships` */
  @Get()
  @ApiOkResponse({ type: MyProfileResponseDto })
  get(@CurrentUser() user: AccountUser): Promise<MyProfileResponseDto> {
    return this.profile.get(user.id);
  }

  /**
   * 주소 수정 (WHALEERP-189). 계정에 하나라 모든 소속에 같이 보인다. 이미 보낸 근로계약서에는 반영하지 않는다. 주소 세
   * 칸을 통째로 바꾸므로 상세 주소를 빼고 보내면 비워진다. 변경 전후 값을 계정 변경 이력에 남긴다. 같은 값이면 아무것도
   * 쓰지 않는다
   */
  @Put('address')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: '저장함' })
  @ApiBadRequestResponse({ description: '우편번호 · 주소 형식' })
  updateAddress(
    @CurrentUser() user: AccountUser,
    @Body() body: UpdateMyAddressDto,
  ): Promise<void> {
    return this.addresses.update(user.id, body);
  }

  /**
   * 비밀번호 변경 (WHALEERP-192). 지금 비밀번호가 틀리거나 새 비밀번호가 규칙에 어긋나면 400 과 사유이고 바꾸지
   * 않는다. 바꾸면 이 기기는 로그인을 잇고 다른 기기는 다시 로그인한다
   */
  // 계정마다 10분에 10번 — 훔친 토큰으로 지금 비밀번호를 맞혀 보는 것을 늦춘다. 틀려도 로그인 잠금 횟수는 세지 않는다.
  @Post('password-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    account: { limit: 10, ttl: 600_000, getTracker: signedInUserTracker },
  })
  @ApiNoContentResponse({ description: '바꿈' })
  @ApiBadRequestResponse({
    description: '지금 비밀번호가 맞지 않음 · 새 비밀번호 규칙 위반(사유)',
  })
  @ApiTooManyRequestsResponse({ description: '계정 · IP 요청 한도' })
  changePassword(
    @CurrentUser() user: AccountUser,
    @Body() body: ChangeMyPasswordDto,
  ): Promise<void> {
    return this.passwords.change(
      { id: user.id, sid: user.sid },
      body.currentPassword,
      body.newPassword,
    );
  }

  /**
   * 이메일 변경 핀 요청 (WHALEERP-191). 새 이메일로 15분짜리 핀을 보낸다. 이메일은 아직 바뀌지 않는다 — 지금 이메일로
   * 계속 로그인된다. 새 핀 메일이 나가면 앞의 핀은 무효다(보내지 못하면 앞의 핀을 그대로 쓴다)
   */
  // 계정마다 10분에 10번 — 메일을 남의 주소로 쏘는 것을 늦춘다. 1분 간격 · 하루 10회는 서비스가 따로 센다(429).
  @Post('email-change-pins')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    account: { limit: 10, ttl: 600_000, getTracker: signedInUserTracker },
  })
  @ApiNoContentResponse({ description: '보냄' })
  @ApiBadRequestResponse({ description: '이메일 형식 · 지금 이메일과 같음' })
  @ApiConflictResponse({ description: '다른 계정이 쓰는 이메일' })
  @ApiTooManyRequestsResponse({
    description: '1분 재발급 간격 · 하루 10회 · 요청 한도',
  })
  @ApiServiceUnavailableResponse({
    description:
      '메일 설정(MAIL_*)이 없거나 메일 서버에 보내지 못함 — 잠시 뒤 다시',
  })
  @ApiInternalServerErrorResponse({
    description:
      '보내기 전에 막힘(메일 템플릿 꺼짐 · 제목 없음 · DB 오류) — 「메일 설정 문제로 … 관리자에게 문의해 주세요」',
  })
  requestEmailChangePin(
    @CurrentUser() user: AccountUser,
    @Body() body: RequestEmailChangePinDto,
  ): Promise<void> {
    return this.emails.requestPin(user.id, body.newEmail);
  }

  /**
   * 이메일 변경 (WHALEERP-191). 받은 핀이 맞으면 계정 이메일을 핀을 낸 새 이메일로 바꾼다. 다음 로그인부터 새 이메일이고,
   * 지금 접속은 이어진다
   */
  // 핀 대입은 핀마다 5회로 닫히지만, 새 핀을 받아 가며 두드리는 것까지 계정마다 10분에 10번으로 늦춘다.
  @Post('email-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    account: { limit: 10, ttl: 600_000, getTracker: signedInUserTracker },
  })
  @ApiNoContentResponse({ description: '바꿈' })
  @ApiBadRequestResponse({
    description: '핀이 틀림 · 만료 · 5회로 닫힘 · 받은 핀 없음',
  })
  @ApiConflictResponse({ description: '그 사이 다른 계정이 그 이메일을 씀' })
  @ApiTooManyRequestsResponse({ description: '계정 · IP 요청 한도' })
  changeEmail(
    @CurrentUser() user: AccountUser,
    @Body() body: ChangeMyEmailDto,
  ): Promise<void> {
    return this.emails.confirm(user.id, body.pin);
  }
}
