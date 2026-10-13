import { ApiProperty } from '@nestjs/swagger';
import { NoticeType, PostAudienceType, PostStatus } from '@prisma/client';
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

/** 1차 노출 대상. 부가서비스(ADDON)는 부가서비스가 들어오는 차수에 연다(WHALEERP-273, 2026-10-12 재영). */
export const FIRST_PHASE_AUDIENCES = [
  'GUEST',
  'MEMBER',
  'BP',
  'STORE',
] as const satisfies readonly PostAudienceType[];
export type FirstPhaseAudience = (typeof FIRST_PHASE_AUDIENCES)[number];

/** PostgreSQL text 는 NUL(0x00)을 받지 않는다 — 그대로 보내면 500 이다. */
// eslint-disable-next-line no-control-regex -- NUL 을 찾는 것이 목적이다
const NO_NUL = /^[^\u0000]*$/;

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
  @IsOptional()
  @IsEnum(NoticeType)
  noticeType?: NoticeType | null;

  /** 상단 고정. 공지사항만, 기본 false. */
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  /**
   * 게시 시작일(YYYY-MM-DD). 공지사항만. 여기서는 저장만 한다 — 사용자 쪽 노출은 이 기간 안에만 되고,
   * 시작일이 없으면 등록 일시부터 보이며 게시일도 등록 일시로 본다(WHALEERP-273, 판정은 조회 API 몫).
   * @example 2026-10-14
   */
  @IsOptional()
  @IsDateOnly()
  publishStartDate?: string | null;

  /** 게시 종료일(YYYY-MM-DD). 공지사항만. 사용자 쪽에는 그날까지 보인다. 시작일보다 앞설 수 없다. */
  @IsOptional()
  @IsDateOnly()
  publishEndDate?: string | null;

  /** FAQ 카테고리 — 공통코드 FAQ_CATEGORY 의 플랫폼 원본 중 사용 중인 상세코드. FAQ 면 필수. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,19}$/, {
    message:
      'FAQ 카테고리는 상세코드(영문 대문자 · 숫자 · 밑줄, 20자)여야 합니다',
  })
  faqCategoryCode?: string | null;

  /** 노출 대상. 1차는 비회원 · 회원 · BP · 점포. 「전체」는 네 개를 모두 보낸다. */
  // enumName 을 달지 않는다 — PostAudienceType 이름은 응답 · GET /enums 의 다섯 값(부가서비스 포함)이 쓴다.
  @ApiProperty({ enum: FIRST_PHASE_AUDIENCES, isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsIn(FIRST_PHASE_AUDIENCES, { each: true })
  audiences: FirstPhaseAudience[];
}
