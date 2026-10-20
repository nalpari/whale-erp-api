import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 화면이 넣은 하이픈 · 공백을 지운다 */
const digitsOnly = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/[\s-]/g, '') : value;

/**
 * 신고 정보 작성 · 수정(WHALEERP-334). 처음 작성할 때는 셋을 모두, 고칠 때는 주민등록번호만 또는 급여 계좌(은행 · 계좌번호를
 * 함께)만 보내도 된다 — 보내지 않은 항목은 그대로 둔다(서비스가 본다). 원문은 응답 · 로그 어디에도 다시 나가지 않는다.
 */
export class SaveMyTaxProfileDto {
  /** 주민등록번호 13자리(외국인등록번호 포함). 앞 7자리가 가입한 생년월일과 맞아야 한다 */
  @IsOptional()
  @Transform(digitsOnly)
  @Matches(/^\d{13}$/, { message: '주민등록번호는 숫자 13자리입니다' })
  rrn?: string;

  /** 은행 — 공통코드 BANK 의 코드 */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  bankCode?: string;

  /** 급여 계좌번호 — 숫자 10~16자리(하이픈은 지운다). 예금주는 본인이어야 한다 */
  @IsOptional()
  @Transform(digitsOnly)
  @Matches(/^\d{10,16}$/, { message: '계좌번호는 숫자 10~16자리입니다' })
  payrollAccountNumber?: string;
}
