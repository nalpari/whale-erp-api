import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 이메일 변경 (WHALEERP-191). 새 이메일은 핀을 낼 때 저장한 값이라 다시 받지 않는다 */
export class ChangeMyEmailDto {
  /** 새 이메일로 받은 6자리 핀. 대소문자 · 앞뒤 공백은 가리지 않는다 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  pin: string;
}
