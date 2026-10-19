import { ApiProperty } from '@nestjs/swagger';
import { NoticeType, PostAudienceType, PostStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
} from 'class-validator';
import { parseDateOnly } from '../../staff-members/kst-date';
import { NO_NUL } from '../../common/no-nul';

/** 1차 노출 대상. 부가서비스(ADDON)는 부가서비스가 들어오는 차수에 연다(WHALEERP-273, 2026-10-12 재영). */
export const FIRST_PHASE_AUDIENCES = [
  'GUEST',
  'MEMBER',
  'BP',
  'STORE',
] as const satisfies readonly PostAudienceType[];
export type FirstPhaseAudience = (typeof FIRST_PHASE_AUDIENCES)[number];

/*
 * 등록 · 수정은 첨부 때문에 multipart 로도 온다(WHALEERP-272). 그때는 텍스트 칸이 모두 문자열이라, JSON 과 같은 값이
 * 되도록 아래 변환을 건다 — JSON 으로 온 값은 그대로 지난다.
 */
/** 같은 이름 칸이 하나면 문자열, 여럿이면 배열로 온다. 빼면 빈 목록 — multipart 는 빈 배열을 보낼 수 없다. */
export const toList = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];
/** 'true' · 'false' 만 바꾼다. 다른 문자열은 그대로 두어 @IsBoolean 이 400 을 낸다. */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;
/** 비운 선택 칸. multipart 는 null 을 보낼 수 없어 빈 문자열로 온다. */
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  value === '' ? null : value;

function IsDateOnly(): PropertyDecorator {
  return ValidateBy({
    name: 'isDateOnly',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && parseDateOnly(value) !== null,
      defaultMessage: (args) =>
        `${args?.property} 는 YYYY-MM-DD 형식의 있는 날짜여야 합니다`,
    },
  });
}

/** 공지사항 · FAQ 등록과 수정이 함께 받는 칸. 공지사항 칸은 FAQ 에서 값을 버린다(형식 검사는 받는다). */
export class PostFieldsDto {
  /** 제목. 200자까지. */
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: '제목을 입력해 주세요' })
  @Matches(NO_NUL, { message: '제목에 쓸 수 없는 문자가 있습니다' })
  title: string;

  /**
   * 본문. 평문이다 — 서버는 정화하지 않고 그대로 저장 · 반환하며, 화면은 HTML 로 그리지 않고 이스케이프해 보인다
   * (2026-10-13 재영). 20,000자까지.
   */
  @IsString()
  @MaxLength(20_000)
  @Matches(/\S/, { message: '본문을 입력해 주세요' })
  @Matches(NO_NUL, { message: '본문에 쓸 수 없는 문자가 있습니다' })
  body: string;

  /** 게시 상태. 게시하려면 노출 대상이 하나 이상 있어야 한다. */
  @ApiProperty({ enum: PostStatus, enumName: 'PostStatus' })
  @IsEnum(PostStatus)
  status: PostStatus;

  /** 공지사항 유형. 공지사항이면 필수. */
  @ApiProperty({ enum: NoticeType, enumName: 'NoticeType', required: false })
  @Transform(emptyToNull)
  @IsOptional()
  @IsEnum(NoticeType)
  noticeType?: NoticeType | null;

  /** 상단 고정. 공지사항만, 기본 false. */
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  /**
   * 게시 시작일(YYYY-MM-DD). 공지사항만. 여기서는 저장만 한다 — 사용자 쪽 노출은 이 기간 안에만 되고,
   * 시작일이 없으면 등록 일시부터 보이며 게시일도 등록 일시로 본다(WHALEERP-273, 판정은 조회 API 몫).
   * @example 2026-10-14
   */
  @Transform(emptyToNull)
  @IsOptional()
  @IsDateOnly()
  publishStartDate?: string | null;

  /** 게시 종료일(YYYY-MM-DD). 공지사항만. 사용자 쪽에는 그날까지 보인다. 시작일보다 앞설 수 없다. */
  @Transform(emptyToNull)
  @IsOptional()
  @IsDateOnly()
  publishEndDate?: string | null;

  /** FAQ 카테고리 — 공통코드 FAQ_CATEGORY 의 플랫폼 원본 중 사용 중인 상세코드. FAQ 면 필수. */
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,19}$/, {
    message:
      'FAQ 카테고리는 상세코드(영문 대문자 · 숫자 · 밑줄, 20자)여야 합니다',
  })
  faqCategoryCode?: string | null;

  /** 노출 대상. 1차는 비회원 · 회원 · BP · 점포. 「전체」는 네 개를 모두 보낸다. 빼면 빈 목록이다. */
  // enumName 을 달지 않는다 — PostAudienceType 이름은 응답 · GET /enums 의 다섯 값(부가서비스 포함)이 쓴다.
  @ApiProperty({ enum: FIRST_PHASE_AUDIENCES, isArray: true, required: false })
  @Transform(toList)
  @IsArray()
  @ArrayUnique()
  @IsIn(FIRST_PHASE_AUDIENCES, { each: true })
  audiences: FirstPhaseAudience[] = [];
}
