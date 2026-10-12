import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators';
import { AdminSignupService } from './admin-signup.service';
import { AvailabilityResponseDto } from './dto/availability.response.dto';
import { EmailAvailabilityDto } from './dto/email-availability.dto';
import { LoginIdAvailabilityDto } from './dto/login-id-availability.dto';
import { SignupDto } from './dto/signup.dto';
import { SignupResponseDto } from './dto/signup.response.dto';

// 로그인 전 화면이라 모두 공개다. 가입은 scrypt 를 태우고 중복 확인은 아이디·이메일 가입 여부를
// 알려 주므로, 셋 다 AuthModule 의 요청 제한(IP · 계정 두 축)에 건다. 계정 축은 본문의 이메일,
// 없으면(아이디 중복 확인) 아이디로 센다(accountTracker, 2026-10-12 코드리뷰 — 전엔 아이디 중복
// 확인이 이메일이 없어 IP 축으로만 떨어졌다). 이메일을 POST 본문으로 받는 것도 같은 이유다 —
// 쿼리에 두면 접근 로그에 주소가 남는다.
@Public()
@UseGuards(ThrottlerGuard)
@Controller('auth/signup')
export class AdminSignupController {
  constructor(private readonly signups: AdminSignupService) {}

  /**
   * BP 회원가입. BP 와 BP 마스터 계정을 함께 만들고 가입 완료 메일을 보낸다(메일이 실패해도 가입은
   * 완료다). 아이디·이메일이 이미 쓰이면 409 다.
   */
  @Post()
  signup(@Body() dto: SignupDto, @Ip() ip: string): Promise<SignupResponseDto> {
    return this.signups.signup(dto, ip);
  }

  /** 아이디 중복 확인. 탈퇴·삭제한 계정의 아이디도 쓸 수 없다. */
  @Post('login-id-availability')
  @HttpCode(HttpStatus.OK)
  async loginIdAvailability(
    @Body() dto: LoginIdAvailabilityDto,
  ): Promise<AvailabilityResponseDto> {
    return { available: await this.signups.isLoginIdAvailable(dto.loginId) };
  }

  /** 이메일 중복 확인. 탈퇴·삭제한 계정의 이메일은 다시 쓸 수 있다. */
  @Post('email-availability')
  @HttpCode(HttpStatus.OK)
  async emailAvailability(
    @Body() dto: EmailAvailabilityDto,
  ): Promise<AvailabilityResponseDto> {
    return { available: await this.signups.isEmailAvailable(dto.email) };
  }
}
