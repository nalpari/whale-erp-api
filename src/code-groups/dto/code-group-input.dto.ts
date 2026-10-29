import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { UseStatus } from '@prisma/client';
import { CODE_PATTERN, INT4_MAX, toUpperCode, trimText } from '../code-format';

/**
 * 그룹 한 행. 수정은 이 모양 그대로, 등록은 관리 주체를 더한 `CreateCodeGroupDto` 로 받는다 — 관리 주체는
 * 등록 뒤 바꾸지 않으므로 수정 본문에 없다.
 */
export class CodeGroupInputDto {
  /** 그룹 코드. 등록 뒤 바뀌지 않는다 — 수정 본문에서는 대상을 가리킬 뿐이다. @example EMP_TYPE */
  @Transform(toUpperCode)
  @Matches(CODE_PATTERN, {
    message:
      '그룹 코드는 영문 대문자·숫자·밑줄만 쓰고 영문으로 시작하며 20자 이내입니다.',
  })
  groupCode: string;

  /** 그룹명. 앞뒤 공백을 지우고 1~50자. @example 고용 형태 */
  @Transform(trimText)
  @IsString()
  @Length(1, 50)
  groupName: string;

  /** 사용 상태. */
  @IsIn(Object.values(UseStatus))
  status: UseStatus;

  /** 표시 순서. 화면이 끌어 옮긴 뒤 1부터 다시 매긴 값. */
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  sortOrder: number;
}
