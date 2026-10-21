import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsSendableEmail } from '../../mail/is-sendable-email';
import { MAX_EMAIL_LENGTH } from '../../mail/mail-address';

/** 이메일 변경 핀 요청 (WHALEERP-191) */
export class RequestEmailChangePinDto {
  /** 바꿀 새 이메일. 대소문자는 가리지 않고 소문자로 저장한다 */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  // 핀은 이 주소로 메일로 간다. @IsEmail 은 따옴표 로컬 파트(`"a"@example.com`)를 받지만 메일 발송은 막으므로 같이
  // 건다. 정규식은 길이를 먼저 보는 IsSendableEmail 로 — @Matches 로 걸면 긴 입력이 이벤트 루프를 멈춘다.
  @IsSendableEmail({
    message: '메일을 보낼 수 없는 형식의 이메일입니다',
  })
  @MaxLength(MAX_EMAIL_LENGTH)
  newEmail: string;

  /**
   * 지금 비밀번호. 맞아야 새 이메일로 핀을 보낸다 — 토큰만 손에 넣은 사람(오염된 바깥 스크립트 등)이 자기 메일로 핀을
   * 받아 아이디를 바꾸지 못하게(WHALEERP-607, ACC-13). 상한은 비밀번호 변경과 같다
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;
}
