import { Transform } from 'class-transformer';
import { IsISO8601, IsString, Length, Matches } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** 사업자정보 인증. 국세청 진위확인에 넘기는 세 값이다 — 상호명은 진위확인이 돌려주지 않아 받지 않는다 */
export class SignupBusinessVerificationDto {
  /** 숫자만 10자리. 화면이 하이픈을 걸러 보낸다 */
  @Matches(/^[0-9]{10}$/, {
    message: '사업자등록번호는 숫자 10자리로 입력해 주세요.',
  })
  bizRegistrationNumber: string;

  /** 대표자명 1~50자 */
  @Transform(trim)
  @IsString()
  @Length(1, 50, { message: '대표자명은 1~50자로 입력해 주세요.' })
  bizCeoName: string;

  /** 개업일자 YYYY-MM-DD */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: '개업일자는 YYYY-MM-DD 로 입력해 주세요.',
  })
  @IsISO8601(
    { strict: true },
    { message: '개업일자는 YYYY-MM-DD 로 입력해 주세요.' },
  )
  bizOpenDate: string;
}
