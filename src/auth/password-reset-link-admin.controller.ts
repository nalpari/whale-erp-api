import {
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser, UserTypes } from './auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from './auth.types';
import { PasswordResetLinkResponseDto } from './dto/password-reset-link.response.dto';
import { PasswordResetLinkService } from './password-reset-link.service';

const NOT_FOUND_MESSAGE = '직원을 찾을 수 없습니다';
const MAX_ID = 2_147_483_647;

/**
 * 직원 비밀번호 초기화(WHALEERP-172 · 177). 관리자 웹만 쓴다. 관리자는 비밀번호를 알 수도 정할 수도 없다 — 재설정
 * 링크가 직원 메일함으로 간다. 관리 범위 밖 · 본사에게 가린 직원은 없는 직원과 같은 404 다(퇴직 처리와 같다).
 * 링크 서비스 · 발송기가 AuthModule 에 있어 여기 둔다. 경로만 직원 자원 아래다.
 */
@ApiBearerAuth()
@UserTypes('admin')
@Controller('staff-members')
export class PasswordResetLinkAdminController {
  constructor(
    private readonly links: PasswordResetLinkService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 재설정 링크를 보낸다. 앞서 보낸 링크와 핀은 무효가 된다. 응답의 시각으로 「보낸 시각 · 기한」을 그린다. */
  @Post(':id/password-reset-links')
  @HttpCode(HttpStatus.CREATED)
  @ApiNotFoundResponse({ description: '없는 직원이거나 관리 범위 밖' })
  @ApiConflictResponse({ description: '가입 전 · 퇴직 · 탈퇴' })
  @ApiTooManyRequestsResponse({ description: '같은 계정에 1분 안에 다시 보냄' })
  @ApiServiceUnavailableResponse({
    description: '링크 주소 · 발송기가 없거나 발송 실패',
  })
  async issue(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<PasswordResetLinkResponseDto> {
    // 정수 범위 밖이면 DB 에 묻기 전에 404 다 — 그대로 보내면 PostgreSQL 이 오류를 내 404 가 500 이 된다.
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
    if (id < 1 || id > MAX_ID) throw new NotFoundException(NOT_FOUND_MESSAGE);
    if (!(await this.scope.canManageStaffMember(user.id, id)))
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    return this.links.issue(user.id, id);
  }
}
