import { IsString, Matches, MaxLength } from 'class-validator';
import { NO_NUL } from '../../common/no-nul';

/**
 * 고객지원 문의 등록 (#281). multipart 의 텍스트 칸으로 받는다 — 첨부파일은 같은 요청의 `files` 칸(선택, 5개까지)이다.
 */
export class CreateSupportInquiryDto {
  /** 문의 유형 — 공통코드 `INQUIRY_CATEGORY` 의 상세 코드. @example STAFF_LABOR */
  @IsString()
  @MaxLength(20)
  @Matches(NO_NUL, { message: '문의 유형에 쓸 수 없는 문자가 있습니다' })
  inquiryCategoryCode: string;

  /** 제목. 200자까지. */
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: '제목을 입력해 주세요' })
  @Matches(NO_NUL, { message: '제목에 쓸 수 없는 문자가 있습니다' })
  title: string;

  /** 문의 내용. 평문이고 20,000자까지. */
  @IsString()
  @MaxLength(20_000)
  @Matches(/\S/, { message: '문의 내용을 입력해 주세요' })
  @Matches(NO_NUL, { message: '문의 내용에 쓸 수 없는 문자가 있습니다' })
  body: string;
}
