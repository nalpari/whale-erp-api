import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class LoginDto {
  /** 대소문자는 구분하지 않는다. 저장·조회 모두 소문자로 정규화한다. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  /**
   * 기기를 구분하는 값. 같은 기기로 다시 로그인하면 그 기기의 이전 접속만
   * 종료된다. 없으면 기기 단위로 접속을 정리하지 못한다.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  deviceIdentifier?: string;
}
