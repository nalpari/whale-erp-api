import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';

export class EmailFindDto {
  /** 본인인증 실명. 앞뒤 공백은 무시하고, 한글 자모가 풀려 와도(NFD) 같은 이름으로 본다. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  /** 휴대전화번호. 하이픈 · 공백은 지우고 숫자 10~11자리만 받는다. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  )
  @IsString()
  @Matches(/^[0-9]{10,11}$/, {
    message: '휴대전화번호는 숫자 10~11자리입니다',
  })
  phone: string;

  /** 생년월일. YYYY-MM-DD 이고 있는 날짜여야 한다. */
  @IsDateOnly('생년월일은 YYYY-MM-DD 형식의 있는 날짜여야 합니다')
  birthDate: string;
}
