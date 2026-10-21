import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
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
import { SaveMyTaxProfileDto } from './dto/save-my-tax-profile.dto';
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

  /** 내 소속 근무지 — TO-DO 와 같은 재직 직원 기준. 체결 완료 근로계약이 있고 가입 완료 · 퇴직 전인 직원 레코드. 퇴직 예정은 퇴직일과 함께 */
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
      '내 소속이 아님 — 없는 id · 범위 밖 id, 남의 레코드, 퇴직했거나 체결 완료 근로계약이 없는 내 레코드. 모두 같은 본문',
  })
  @ApiServiceUnavailableResponse({
    description: '신고 정보가 있는데 서버에 암호화 키가 없음',
  })
  @ApiInternalServerErrorResponse({
    description:
      '저장된 신고 정보를 풀 수 없음(키가 다름 · 다른 행의 값 · 손상) — 서버 로그에 레코드 · 칸',
  })
  taxProfile(
    @Param('staffMemberId', StaffMemberIdPipe) staffMemberId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<MyTaxProfileResponseDto> {
    return this.memberships.taxProfile(user.id, staffMemberId);
  }

  /**
   * 신고 정보 작성 · 수정 (WHALEERP-334). 직원 본인만 — 관리자 토큰은 403. 처음에는 주민등록번호 · 은행 · 계좌번호를 모두,
   * 고칠 때는 주민등록번호만 또는 급여 계좌(은행 · 계좌번호 함께)만 보낸다. 주민등록번호를 새로 받으면 수집 일시가 바뀌고
   * 이전 값은 남기지 않는다. 급여 계좌는 다음 급여부터 쓴다. 응답은 조회와 같다(가린 값만).
   */
  @Put(':staffMemberId/tax-profile')
  @ApiOkResponse({ type: MyTaxProfileResponseDto })
  @ApiBadRequestResponse({
    description:
      '형식 오류 · 바꿀 값 없음(TAX_PROFILE_EMPTY) · 처음인데 셋 중 빠짐(TAX_PROFILE_INCOMPLETE) · 은행 · 계좌번호 한쪽만(TAX_PROFILE_ACCOUNT_INCOMPLETE) · 주민등록번호 앞자리와 가입 생년월일이 다름(RRN_BIRTH_MISMATCH — 관리자에게 정정 요청) · 없는 은행(BANK_CODE_UNKNOWN)',
  })
  @ApiNotFoundResponse({
    description: '내 소속이 아님 — 조회와 같은 본문',
  })
  @ApiServiceUnavailableResponse({
    description: '서버에 암호화 키가 없음',
  })
  @ApiInternalServerErrorResponse({
    description:
      '저장된 신고 정보를 풀 수 없음(키가 다름 · 다른 행의 값 · 손상) — 보낸 칸이든 아니든 아무것도 쓰지 않는다(덮어쓰지 않음). 서버 로그에 레코드 · 칸',
  })
  saveTaxProfile(
    @Param('staffMemberId', StaffMemberIdPipe) staffMemberId: number,
    @CurrentUser() user: AuthUser,
    @Body() dto: SaveMyTaxProfileDto,
  ): Promise<MyTaxProfileResponseDto> {
    return this.memberships.saveTaxProfile(user.id, staffMemberId, dto);
  }
}
