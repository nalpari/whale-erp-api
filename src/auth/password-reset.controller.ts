import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from './auth.decorators';
import { RequestPasswordResetPinDto } from './dto/request-password-reset-pin.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyPasswordResetPinDto } from './dto/verify-password-reset-pin.dto';
import { PasswordResetService } from './password-reset.service';

// 로그인 전에 닿는 경로이고 핀 검증은 scrypt 를 쓴다. 로그인과 같은 요청 제한(IP · 이메일)을 건다.
@UseGuards(ThrottlerGuard)
@Controller('auth/account')
export class PasswordResetController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  /**
   * 비밀번호 재설정 핀을 이메일로 보낸다. 그 이메일에 맞는 계정이 없어도, 직전 발급 뒤 1분이
   * 안 지났거나 하루 10번을 채웠어도 똑같이 204 로 답한다 — 응답이 갈리면 가입 여부가 드러난다.
   * 새 핀을 받으면 이전 핀은 바로 무효가 되고, 핀은 낸 시각부터 10분 동안 유효하다.
   *
   * 핀을 보낼 수 없는 환경(운영에 발송기가 연결되지 않음)에서는 계정과 상관없이 503 이다.
   */
  @Public()
  @Post('password-reset-pins')
  @HttpCode(HttpStatus.NO_CONTENT)
  requestPin(@Body() dto: RequestPasswordResetPinDto): Promise<void> {
    return this.passwordReset.requestPin(dto.email);
  }

  /**
   * 핀이 맞는지만 확인한다. 맞으면 204 이고 앱은 새 비밀번호 화면으로 넘어간다. 틀림 · 만료 · 5회로
   * 닫힘 · 없음은 모두 같은 메시지의 401 이다. 핀은 5번까지 틀릴 수 있고 넘기면 새 핀을 받아야 한다.
   */
  @Public()
  @Post('password-reset-pins/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  verifyPin(@Body() dto: VerifyPasswordResetPinDto): Promise<void> {
    return this.passwordReset.verifyPin(dto.email, dto.pin);
  }

  /**
   * 새 비밀번호를 정한다. 확인에 쓴 핀을 다시 보내고 서버가 다시 검증한다. 맞으면 비밀번호를 바꾸고
   * 핀을 소진하며, 모든 기기의 접속을 끊고 로그인 잠금을 푼다. 규칙에 어긋나면 400 과 사유를 주고
   * 핀은 그대로 둔다.
   */
  @Public()
  @Post('password-reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.passwordReset.resetPassword(
      dto.email,
      dto.pin,
      dto.newPassword,
    );
  }
}
