import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MyProfileResponseDto } from './dto/my-profile.response.dto';
import { MyProfileService } from './my-profile.service';

/** 직원 근무 앱의 내 정보 (WHALEERP-188). 고치는 api(주소 · 이메일 · 비밀번호)는 따로다 */
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/profile')
export class MyProfileController {
  constructor(private readonly profile: MyProfileService) {}

  /** 내 정보 — 계정 칸, 본사 제공 동의(계정에 하나), 위치정보 동의. 소속 근무지는 `GET /me/memberships` */
  @Get()
  @ApiOkResponse({ type: MyProfileResponseDto })
  get(@CurrentUser() user: AuthUser): Promise<MyProfileResponseDto> {
    return this.profile.get(user.id);
  }
}
