import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from './auth.decorators';
import { ResetPasswordWithLinkDto } from './dto/reset-password-with-link.dto';
import { VerifyPasswordResetLinkDto } from './dto/verify-password-reset-link.dto';
import { PasswordResetLinkService } from './password-reset-link.service';

// 로그인 전에 닿는 경로다. 로그인 · 핀과 같은 두 축(IP, 계정 축은 본문 token 의 해시)의 요청 제한을 건다.
@UseGuards(ThrottlerGuard)
@Controller('auth/account/password-reset-links')
export class PasswordResetLinkController {
  constructor(private readonly links: PasswordResetLinkService) {}

  /**
   * 관리자 초기화 재설정 링크가 쓸 수 있는지 확인한다(WHALEERP-172). 화면을 열 때 무효한 링크 안내를 먼저 보이려고
   * 쓴다. 소진하지 않는다.
   */
  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiUnauthorizedResponse({
    description:
      '쓸 수 없는 링크 — 없음 · 만료 · 사용 · 새 링크로 대체 · 탈퇴를 가리지 않는다',
  })
  verify(@Body() dto: VerifyPasswordResetLinkDto): Promise<void> {
    return this.links.verify(dto.token);
  }

  /**
   * 링크로 새 비밀번호를 정한다. 지금 비밀번호는 묻지 않는다. 성공하면 남은 링크 · 핀을 닫고 모든 기기의 접속을
   * 끊으며 로그인 잠금을 푼다.
   */
  @Public()
  @Post('reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBadRequestResponse({
    description:
      '비밀번호 규칙 위반 — 사유를 준다. 링크는 그대로라 다시 정할 수 있다',
  })
  @ApiUnauthorizedResponse({ description: '쓸 수 없는 링크(확인과 같은 문구)' })
  reset(@Body() dto: ResetPasswordWithLinkDto): Promise<void> {
    return this.links.reset(dto.token, dto.newPassword);
  }
}
