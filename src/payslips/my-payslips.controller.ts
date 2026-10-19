import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { parseRouteId } from '../common/route-id';
import {
  MyPayslipDetailResponseDto,
  MyPayslipListResponseDto,
} from './dto/my-payslip.response.dto';
import { MyPayslipsService } from './my-payslips.service';
import { PAYSLIP_NOT_FOUND_MESSAGE } from './payslip-menu';

/**
 * 직원 근무 앱의 내 급여명세서 (WHALEERP-330). 로그인한 직원에게 발송된 명세서만, 만든 날부터 3년 동안 —
 * 퇴직한 뒤에도(PAY-4). 관리자 토큰은 403.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '직원 근무 앱 토큰이 아님' })
@UserTypes('account')
@Controller('me/payslips')
export class MyPayslipsController {
  constructor(private readonly payslips: MyPayslipsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser): Promise<MyPayslipListResponseDto> {
    return this.payslips.list(user.id);
  }

  @Get(':id')
  @ApiNotFoundResponse({
    description:
      '없는 명세서 · 남의 명세서 · 발송 전 · 보존 기간(3년) 지남 · ID 형식 오류',
  })
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<MyPayslipDetailResponseDto> {
    const id = parseRouteId(rawId);
    const item = id && (await this.payslips.findOne(user.id, id));
    if (!item) throw new NotFoundException(PAYSLIP_NOT_FOUND_MESSAGE);
    return item;
  }
}
