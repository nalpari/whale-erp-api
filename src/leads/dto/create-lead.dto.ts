import { ApiProperty } from '@nestjs/swagger';
import { LeadInterest } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { trimText } from '../../code-groups/code-format';

/** 업종 공통코드(`INDUSTRY`)의 기타. 이것을 고르면 직접 입력을 받는다. */
export const INDUSTRY_OTHER = 'ETC';

/** 도입문의 접수 (홈 · S-SDMDKC). 로그인 없이 받는다. */
export class CreateLeadDto {
  /** 문의자 이름. 앞뒤 공백을 지우고 1~50자. @example 김도윤 */
  @Transform(trimText)
  @IsString()
  @Length(1, 50)
  contactName: string;

  /** 업종 — 공통코드 `INDUSTRY` 의 상세 코드. @example CAFE */
  @IsString()
  @MaxLength(20)
  industryCode: string;

  /** 업종 직접 입력. 업종이 기타(`ETC`)일 때만 필수이고, 아니면 저장하지 않는다. @example 꽃집 */
  @ValidateIf((o: CreateLeadDto) => o.industryCode === INDUSTRY_OTHER)
  @Transform(trimText)
  @IsString()
  @Length(1, 50)
  industryDetail?: string;

  /**
   * 전화번호. 점포 번호도 된다. 하이픈 · 공백은 지우고 숫자만 저장한다 — 0으로 시작하는 9~11자리,
   * 또는 대표번호(15xx · 16xx · 18xx, 8자리).
   * 10분 중복 접수는 전화번호나 이메일 중 하나라도 같으면 막는다. @example 02-1234-5678
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  )
  @Matches(/^(0[0-9]{8,10}|1[568][0-9]{6})$/, {
    message: '전화번호 형식이 올바르지 않습니다',
  })
  phone: string;

  /** 이메일. 소문자로 저장한다. 10분 중복 접수 판정에 전화번호와 함께 쓴다. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** 관심 서비스. 하나 이상, 겹치지 않게. */
  @ApiProperty({ enum: LeadInterest, enumName: 'LeadInterest', isArray: true })
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(Object.values(LeadInterest), { each: true })
  interests: LeadInterest[];

  /** 도입 예정 시기 — 공통코드 `PLAN_PERIOD` 의 상세 코드. 선택이며, 고르지 않으면 칸을 뺀다(빈 문자열은 400). @example WITHIN_1M */
  @IsOptional()
  @IsString()
  @Length(1, 20)
  planPeriodCode?: string;

  /** 문의 내용. 앞뒤 공백을 지우고 1~2000자. */
  @Transform(trimText)
  @IsString()
  @Length(1, 2000)
  body: string;

  /** 개인정보 수집·이용 동의. 필수라 `true` 만 받는다. */
  @Equals(true, { message: '개인정보 수집·이용에 동의해야 접수할 수 있습니다' })
  privacyAgreed: boolean;

  /** 마케팅 정보 수신 동의. 선택. */
  @IsOptional()
  @IsBoolean()
  marketingAgreed?: boolean;
}
