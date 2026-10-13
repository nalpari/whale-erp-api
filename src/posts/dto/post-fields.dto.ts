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
  ValidateBy,
} from 'class-validator';
import { parseDateOnly } from '../../staff-members/kst-date';

/** 1차 노출 대상. 부가서비스(ADDON)는 부가서비스가 들어오는 차수에 연다(WHALEERP-273, 2026-10-12 재영). */
export const FIRST_PHASE_AUDIENCES = [
  'GUEST',
  'MEMBER',
  'BP',
  'STORE',
] as const;

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

/** 공지사항 · FAQ 등록과 수정이 함께 받는 칸. 공지사항 칸은 FAQ 에서 버린다. */
export class PostFieldsDto {
  @IsString()
  @Matches(/\S/, { message: '제목을 입력해 주세요' })
  title: string;

  @IsString()
  @Matches(/\S/, { message: '본문을 입력해 주세요' })
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
   * 게시 시작일(YYYY-MM-DD). 공지사항만. 없으면 등록 일시부터 보이고, 게시일도 등록 일시로 본다.
   * @example 2026-10-14
   */
  @IsOptional()
  @IsDateOnly()
  publishStartDate?: string | null;

  /** 게시 종료일(YYYY-MM-DD). 공지사항만. 그날까지 보인다. 시작일보다 앞설 수 없다. */
  @IsOptional()
  @IsDateOnly()
  publishEndDate?: string | null;

  /** FAQ 카테고리 — 공통코드 FAQ_CATEGORY 의 상세코드. FAQ 면 필수. */
  @IsOptional()
  @IsString()
  faqCategoryCode?: string | null;

  /** 노출 대상. 1차는 비회원 · 회원 · BP · 점포. 「전체」는 네 개를 모두 보낸다. */
  // enumName 을 달지 않는다 — PostAudienceType 이름은 응답 · GET /enums 의 다섯 값(부가서비스 포함)이 쓴다.
  @ApiProperty({ enum: FIRST_PHASE_AUDIENCES, isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsIn(FIRST_PHASE_AUDIENCES, { each: true })
  audiences: PostAudienceType[];
}
