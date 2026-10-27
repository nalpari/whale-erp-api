import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import { BirthDateCorrectionDto } from './dto/birth-date-correction.dto';
import { StaffBirthDateService } from './staff-birth-date.service';
import { STAFF_NOT_FOUND_MESSAGE } from './staff-menu';

/**
 * 직원 생년월일 정정 (WHALEERP-602). 관리자 웹만 쓴다. 관리 범위 밖 · 본사 제공 동의로 가려진 직원은 없는 직원과
 * 같은 404 다 — 403 을 주면 다른 BP 에 그 ID 의 직원이 있다는 것이 드러난다. 권한은 가드가 먼저 보고(403),
 * 범위는 그 뒤 핸들러가 본다(404).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '직원 정보 관리 수정 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@MenuPermission('update')
@Controller('staff-members')
export class StaffBirthDateController {
  constructor(
    private readonly birthDates: StaffBirthDateService,
    private readonly scope: AdminScopeService,
  ) {}

  @Put(':id/birth-date')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '직원 생년월일 정정',
    description:
      '가입 때 잘못 넣은 생년월일을 관리자가 확인해 정정한다(WHALEERP-602). 직원 레코드의 계정 생년월일을 바꾸므로 ' +
      '같은 사람의 다른 BP 소속에도 같이 바뀐다. 계약서에 적힌 생년월일은 바꾸지 않고, 날인 대기 중인 계약이 있어도 ' +
      '막지 않는다. 날인 대기 계약은 날인 때 계약서 생년월일과 계정 생년월일을 다시 대조하므로 정정으로 대조가 풀릴 수도 있고(보통) 새로 어긋날 수도 있다(계정 하나라 다른 BP 의 계약도 같다). 정정은 계정 변경 이력(BIRTH_DATE · ADMIN_CORRECTION)에 남는다. 오류 응답은 `code` 로 가른다.',
  })
  @ApiNoContentResponse({ description: '정정함' })
  @ApiNotFoundResponse({
    description: '없는 직원이거나 관리 범위 밖 · 본사 제공 동의로 가려진 직원',
  })
  @ApiBadRequestResponse({
    description:
      'BIRTH_DATE_INVALID(문자열 날짜의 형식 오류 · 없는 날짜 · 오늘(KST) 뒤 날짜(내일부터); birthDate 없음 · 문자열 아님 · 모르는 필드는 code 없는 ValidationPipe 400) / BIRTH_DATE_UNDER_AGE(한국 오늘 기준 만 19세 미만)',
  })
  @ApiConflictResponse({
    description:
      'BIRTH_DATE_NOT_JOINED(계정 없음(가입 전) · 계정이 JOINED 아님(탈퇴 · 연결 보류)) / BIRTH_DATE_RETIRED(퇴직한 레코드 · 퇴직일이 지났는데 배치 전인 레코드. 퇴직 예정은 허용) / BIRTH_DATE_UNCHANGED(지금 값과 같음)',
  })
  async correct(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
    @Body() body: BirthDateCorrectionDto,
  ): Promise<void> {
    const id = await this.staffInScope(user, rawId);
    await this.birthDates.correct(user.id, id, body.birthDate);
  }

  /** 정수 범위 밖이면 DB 에 묻기 전에 404 다 — 그대로 보내면 PostgreSQL 이 오류를 내 404 가 500 이 된다. */
  private async staffInScope(user: AuthUser, rawId: string): Promise<number> {
    const id = parseRouteId(rawId);
    if (id === null || !(await this.scope.canManageStaffMember(user.id, id)))
      throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    return id;
  }
}
