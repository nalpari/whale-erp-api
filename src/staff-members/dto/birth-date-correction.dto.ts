import { IsString } from 'class-validator';

/**
 * 생년월일 정정 요청 (WHALEERP-602). 문자열 날짜의 모양 · 달력 · 오늘(KST) 뒤 날짜(내일부터) 검사는 서비스가 BIRTH_DATE_INVALID 로
 * 답한다. birthDate 가 없거나 문자열이 아니거나 모르는 필드가 섞이면 ValidationPipe 400(code 없음)이다.
 */
export class BirthDateCorrectionDto {
  /**
   * 정정할 생년월일(YYYY-MM-DD, 한국 날짜). 오늘(KST) 뒤 날짜(내일부터)이거나 한국 오늘 기준 만 19세 미만이면 받지 않는다.
   * @example 1990-05-17
   */
  @IsString({ message: '생년월일은 YYYY-MM-DD 형식의 있는 날짜여야 합니다.' })
  birthDate: string;
}
