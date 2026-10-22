import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';
import { lowerEmail } from '../../platform-admins/platform-admin-format';

/**
 * GET .../me/email-availability 의 쿼리. 없거나 중복된 email, 형식이 아닌 값은 여기서 400으로
 * 막는다 — DTO 없이 `@Query('email') email: string` 으로 받으면 ValidationPipe 를 타지 않아
 * 없는 값에 500이 났다(코드 리뷰로 찾음, 2026-10-21). 저장(PATCH)과 같은 lowerEmail · 100자
 * 규칙을 쓴다.
 */
export class AdminProfileEmailAvailabilityQueryDto {
  @Transform(lowerEmail)
  @IsEmail({}, { message: '이메일 형식이 아닙니다' })
  @MaxLength(100)
  email: string;
}
