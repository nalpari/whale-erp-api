import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { UseStatus } from '@prisma/client';
import {
  CODE_FORMAT_MESSAGE,
  CODE_PATTERN,
  toUpperCode,
  trimText,
} from '../code-format';

/**
 * 그룹 한 행의 공통 칸. 등록은 관리 주체를 더한 `CreateCodeGroupDto`, 수정은 표시 순서 · updatedAt 을 더한
 * `UpdateCodeGroupDto` 로 받는다 — 관리 주체는 등록 뒤 바꾸지 않고, 새 그룹의 표시 순서는 api 가 매긴다.
 */
export class CodeGroupInputDto {
  /** 그룹 코드. 등록 뒤 바뀌지 않는다 — 수정 본문에서는 대상을 가리킬 뿐이다. @example EMP_TYPE */
  @Transform(toUpperCode)
  @Matches(CODE_PATTERN, { message: CODE_FORMAT_MESSAGE })
  groupCode: string;

  /** 그룹명. 앞뒤 공백을 지우고 1~50자. @example 고용 형태 */
  @Transform(trimText)
  @IsString()
  @MinLength(1, { message: '그룹명을 입력해 주세요.' })
  @MaxLength(50, { message: '그룹명은 50자까지입니다.' })
  groupName: string;

  /** 사용 상태. */
  @IsIn(Object.values(UseStatus))
  status: UseStatus;
}
