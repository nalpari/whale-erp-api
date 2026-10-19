import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdminSignupSessionDto {
  /** AdminSignupService.signup 이 가입 끝에 낸 10분짜리 토큰(signup.response.dto.ts 의 signupToken). */
  @IsString()
  @IsNotEmpty()
  signupToken: string;

  /** 브라우저를 구분하는 값 — 로그인과 같다. 같은 값으로 다시 부르면 그 브라우저의 이전 세션만 종료된다. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  deviceInformation?: string;
}
