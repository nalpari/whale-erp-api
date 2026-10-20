import { Transform } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';
import { MAX_EMAIL_LENGTH, SENDABLE_EMAIL } from '../../mail/mail-address';

/** 이메일 변경 핀 요청 (WHALEERP-191) */
export class RequestEmailChangePinDto {
  /** 바꿀 새 이메일. 대소문자는 가리지 않고 소문자로 저장한다 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  // 핀은 이 주소로 메일로 간다 — 메일 발송이 막는 주소(따옴표 · 괄호 · 역슬래시 등)는 받지 않는다.
  @Matches(SENDABLE_EMAIL, {
    message: '메일을 보낼 수 없는 형식의 이메일입니다',
  })
  @MaxLength(MAX_EMAIL_LENGTH)
  newEmail: string;
}
