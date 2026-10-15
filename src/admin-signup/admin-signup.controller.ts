import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators';
import { AdminSignupService } from './admin-signup.service';
import { BusinessVerificationService } from './business-verification.service';
import { AvailabilityResponseDto } from './dto/availability.response.dto';
import { BusinessVerificationDto } from './dto/business-verification.dto';
import { BusinessVerificationResponseDto } from './dto/business-verification.response.dto';
import { EmailAvailabilityDto } from './dto/email-availability.dto';
import { LoginIdAvailabilityDto } from './dto/login-id-availability.dto';
import { SignupDto } from './dto/signup.dto';
import { SignupResponseDto } from './dto/signup.response.dto';

// 로그인 전 화면이라 모두 공개다. 가입은 scrypt 를 태우고 중복 확인은 아이디·이메일 가입 여부를
// 알려 주므로, 셋 다 AuthModule 의 요청 제한(IP · 계정 두 축)에 건다. 계정 축은 본문의 이메일,
// 없으면(아이디 중복 확인) 아이디로 센다(accountTracker, 2026-10-12 코드리뷰 — 전엔 아이디 중복
// 확인이 이메일이 없어 IP 축으로만 떨어졌다). 이메일을 POST 본문으로 받는 것도 같은 이유다 —
// 쿼리에 두면 접근 로그에 주소가 남는다.
//
// 가입만은 같은 IP 시간당 5건이다 — 도입문의(LeadsController)와 같은 정책을 따른다(2026-10-15 결정,
// 명세에 횟수 제한이 없어 가장 가까운 공개 양식을 따랐다). 가입 한 번에 메일이 「1 + 플랫폼 마스터 수」만큼 나가,
// 기본 한도(분당 60건)로는 IP 하나가 공용 메일 계정의 하루 발송 한도를 채울 수 있다. 중복 확인은 칸을 벗어날
// 때마다 불리므로 기본 한도를 그대로 쓴다. IP 는 관리자 웹 Next 서버가 넘기는 X-Forwarded-For 를 TRUST_PROXY 가
// 믿을 때만 사용자 것이다 — 아니면 모든 가입자가 한 칸을 나눠 써 전체가 시간당 5건에서 막힌다.

/** 한도를 넘었을 때 안내 문구만 바꾼다 — 도입문의(LeadsThrottlerGuard)와 같은 문구. 로그인 경로의 문구는 그대로다. */
@Injectable()
export class SignupThrottlerGuard extends ThrottlerGuard {
  protected getErrorMessage(): Promise<string> {
    return Promise.resolve('잠시 후 다시 시도해 주세요');
  }
}

@Public()
@UseGuards(SignupThrottlerGuard)
@Controller('auth/signup')
export class AdminSignupController {
  constructor(
    private readonly signups: AdminSignupService,
    private readonly verifications: BusinessVerificationService,
  ) {}

  /**
   * BP 회원가입. BP 와 BP 마스터 계정을 함께 만들고, 메일 설정이 있으면 가입 완료 메일을 보낸다(메일이
   * 없거나 실패해도 가입은 완료다). 아이디·이메일이 이미 쓰이면 409 다.
   */
  @Post()
  @Throttle({ ip: { limit: 5, ttl: 3_600_000 } })
  @ApiTooManyRequestsResponse({ description: '같은 IP 의 시간당 한도(5건)' })
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

  /**
   * 사업자정보 인증(국세청 진위확인). 번호 중복을 먼저 본다(409). 불일치는 422, 국세청 장애는 503 이고,
   * 일치하면 10분짜리 토큰을 준다. 요청 제한은 기본 한도다 — 인증하기를 눌렀을 때만 불린다.
   */
  @Post('business-verifications')
  @HttpCode(HttpStatus.OK)
  async businessVerification(
    @Body() dto: BusinessVerificationDto,
  ): Promise<BusinessVerificationResponseDto> {
    return { verificationToken: await this.verifications.verify(dto) };
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
