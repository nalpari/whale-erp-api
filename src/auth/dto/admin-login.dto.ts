import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdminLoginDto {
  /** 관리자 로그인ID. 대소문자를 구분한다. 형식은 검사하지 않는다 — 틀리면 없는 아이디와 같이 답한다. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  loginId: string;

  /** 기존 비밀번호 또는 메일로 받은 임시 · 초기 비밀번호. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  /** 브라우저를 구분하는 값. 같은 값으로 다시 로그인하면 그 브라우저의 이전 세션만 종료된다. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  deviceInformation?: string;
}
