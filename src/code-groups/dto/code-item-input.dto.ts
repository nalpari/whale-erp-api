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
 * 상세 코드 한 행. 등록과 수정이 같은 모양이다. 관리 주체는 받지 않는다 — 플랫폼 공통코드 관리에서는 소속 그룹을 따르고,
 * BP 공통코드 관리에서는 BP전용이다.
 */
export class CodeItemInputDto {
  /** 상세 코드. 등록 뒤 바뀌지 않는다 — 수정 본문에서는 대상을 가리킬 뿐이다. SERVICE 그룹이면 서비스 코드다. @example FULL */
  @Transform(toUpperCode)
  @Matches(CODE_PATTERN, {
    message:
      '상세 코드는 영문 대문자·숫자·밑줄만 쓰고 영문으로 시작하며 20자 이내입니다.',
  })
  itemCode: string;

  /** 코드명. 앞뒤 공백을 지우고 1~50자. SERVICE 그룹이면 서비스명이다. @example 정규직 */
  @Transform(trimText)
  @IsString()
  @Length(1, 50)
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
