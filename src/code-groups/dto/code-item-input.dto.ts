import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { UseStatus } from '@prisma/client';
import {
  CODE_FORMAT_MESSAGE,
  CODE_PATTERN,
  INT4_MAX,
  toUpperCode,
  trimText,
} from '../code-format';

/**
 * 상세 코드 한 행. 등록은 이 모양 그대로, 수정은 updatedAt 을 더한 `UpdateCodeItemDto` 로 받는다. 관리 주체는 받지 않는다 — 플랫폼 공통코드 관리에서는 소속 그룹을 따르고,
 * BP 공통코드 관리에서는 BP전용이다.
 */
export class CodeItemInputDto {
  /** 상세 코드. 등록 뒤 바뀌지 않는다 — 수정 본문에서는 대상을 가리킬 뿐이다. SERVICE 그룹이면 서비스 코드다. @example FULL */
  @Transform(toUpperCode)
  @Matches(CODE_PATTERN, { message: CODE_FORMAT_MESSAGE })
  itemCode: string;

  /** 코드명. 앞뒤 공백을 지우고 1~50자. SERVICE 그룹이면 서비스명이다. @example 정규직 */
  @Transform(trimText)
  @IsString()
  @MinLength(1, { message: '코드명을 입력해 주세요.' })
  @MaxLength(50, { message: '코드명은 50자까지입니다.' })
  label: string;

  /** 사용 상태. */
  @IsIn(Object.values(UseStatus))
  status: UseStatus;

  /** 표시 순서. 화면이 끌어 옮긴 뒤 1부터 다시 매긴 값. */
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  sortOrder: number;
}
