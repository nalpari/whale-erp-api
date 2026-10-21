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
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { STAFF_NOT_FOUND_MESSAGE } from '../staff-members/staff-menu';
import { CurrentUser } from './auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from './auth.types';
import { PasswordResetLinkResponseDto } from './dto/password-reset-link.response.dto';
import { MenuPermission } from './menu-permission.guard';
import { PasswordResetLinkService } from './password-reset-link.service';

const MAX_ID = 2_147_483_647;

/**
 * 직원 비밀번호 초기화(WHALEERP-172 · 177). 관리자 웹만 쓴다. 관리자는 비밀번호를 알 수도 정할 수도 없다 — 재설정
 * 링크가 직원 메일함으로 간다. 관리 범위 밖은 없는 직원과 같은 404 다. 본사 역할(BM · BA)에게 직영이 아닌 점포 직원도
 * 404 다 — 퇴직 처리와 달리 본사 제공 동의와 상관없다. 동의는 자료를 보는 데 대한 것이라 계정 조치로 넓히지 않는다
 * (2026-10-14 재영, 운영 정책 ATT-30).
 * 직원 정보 관리 수정 권한이 있어야 한다(WHALEERP-177) — 퇴직 처리와 같다. 권한은 가드가 먼저 보고(403), 범위는
 * 그 뒤 핸들러가 본다(404). 그래서 권한 없는 관리자는 어떤 ID 든 같은 403 을 받아 직원이 있는지 알 수 없다.
 * 링크 서비스 · 발송기가 AuthModule 에 있어 여기 둔다. 경로만 직원 자원 아래다.
 */
@ApiBearerAuth()
@MenuPermission('update')
@Controller('staff-members')
export class PasswordResetLinkAdminController {
  constructor(
    private readonly links: PasswordResetLinkService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 재설정 링크를 보낸다. 앞서 보낸 링크와 핀은 무효가 된다. 응답의 시각으로 「보낸 시각 · 기한」을 그린다. */
  @Post(':id/password-reset-links')
  @HttpCode(HttpStatus.CREATED)
  @ApiUnauthorizedResponse({
    description: '토큰이 없거나 유효하지 않음, 또는 접속이 끝난 직원 앱 토큰',
  })
  @ApiForbiddenResponse({
    description:
      '직원 정보 관리 수정 권한 없음 · 접속이 살아 있는 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
  })
  @ApiNotFoundResponse({ description: '없는 직원이거나 관리 범위 밖' })
  @ApiConflictResponse({ description: '가입 전 · 퇴직 · 탈퇴' })
  @ApiTooManyRequestsResponse({ description: '같은 계정에 1분 안에 다시 보냄' })
  @ApiServiceUnavailableResponse({
    description:
      '링크 주소(STAFF_APP_URL) · 메일 설정(MAIL_*)이 없거나 메일 서버에 보내지 못함 — 잠시 뒤 다시',
  })
  @ApiInternalServerErrorResponse({
    description:
      '보내기 전에 막힘(메일 템플릿 꺼짐 · 제목 없음 · DB 오류) — 「메일 설정 문제로 … 플랫폼 관리자에게 문의해 주세요」',
  })
  async issue(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<PasswordResetLinkResponseDto> {
    // 정수 범위 밖이면 DB 에 묻기 전에 404 다 — 그대로 보내면 PostgreSQL 이 오류를 내 404 가 500 이 된다.
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
    if (id < 1 || id > MAX_ID)
      throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    if (!(await this.scope.canManageStaffAccount(user.id, id)))
      throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    return this.links.issue(user.id, id);
  }
}
