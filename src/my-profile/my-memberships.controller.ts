import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  MyMembershipListResponseDto,
  MyTaxProfileResponseDto,
} from './dto/my-membership.response.dto';
import { MyMembershipsService } from './my-memberships.service';
import { StaffMemberIdPipe } from './staff-member-id.pipe';

/**
 * 직원 근무 앱 마이페이지의 소속 근무지 (WHALEERP-188). 소속을 누르면 근로계약서 · 급여명세서 · 신고 정보 버튼이 있고
 * 각각 그 화면으로 간다(2026-10-20). 소속 하나는 직원 레코드 하나라 그 화면들은 `staffMemberId` 로 연다
 */
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/memberships')
export class MyMembershipsController {
  constructor(private readonly memberships: MyMembershipsService) {}

  /** 내 소속 근무지 — 체결 완료 근로계약이 있고 가입 완료 · 퇴직 전인 직원 레코드. 퇴직 예정은 퇴직일과 함께 */
  @Get()
  @ApiOkResponse({ type: MyMembershipListResponseDto })
  list(@CurrentUser() user: AuthUser): Promise<MyMembershipListResponseDto> {
    return this.memberships.list(user.id);
  }

  /** 그 소속의 신고 정보 (TAX-8). 주민등록번호 · 계좌번호는 가린 값만 준다 */
  @Get(':staffMemberId/tax-profile')
  @ApiOkResponse({ type: MyTaxProfileResponseDto })
  @ApiNotFoundResponse({
    description:
      '내 소속이 아님 — 남의 레코드, 퇴직했거나 체결 완료 근로계약이 없는 내 레코드',
  })
  @ApiServiceUnavailableResponse({
    description: '신고 정보가 있는데 암호화 키가 설정되지 않음',
  })
  taxProfile(
    @Param('staffMemberId', StaffMemberIdPipe) staffMemberId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<MyTaxProfileResponseDto> {
    return this.memberships.taxProfile(user.id, staffMemberId);
  }
}
