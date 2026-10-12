import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { UseStatus } from '@prisma/client';
import { CODE_PATTERN, INT4_MAX, toUpperCode, trimText } from '../code-format';

/** 상세 코드 한 행. 새 행과 기존 행이 같은 모양이다 — 관리 주체는 소속 그룹을 따르므로 받지 않는다. */
export class CodeItemInputDto {
  /** 상세 코드. 기존 행이면 대상을 가리킬 뿐 바뀌지 않는다. SERVICE 그룹이면 서비스 코드다. @example FULL */
  @Transform(toUpperCode)
  @Matches(CODE_PATTERN, {
    message:
      '상세 코드는 영문 대문자·숫자·밑줄만 쓰고 영문으로 시작하며 20자 이내입니다',
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

/** 상세 코드 목록 패널 저장 — 행마다가 아니라 패널마다 한 번이다. 삭제는 없다(사용 상태를 끈다). */
export class SaveCodeItemsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CodeItemInputDto)
  updates: CodeItemInputDto[];

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CodeItemInputDto)
  creates: CodeItemInputDto[];
}
