import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsOptional,
  Matches,
} from 'class-validator';
import { CODE_PATTERN } from '../../code-groups/code-format';

/** 공통코드 조회 조건. */
export class CodeItemsQueryDto {
  /**
   * 쉼표로 구분한 그룹 코드. 없으면 공통코드 전체. 없거나 사용하지 않는 그룹은 빈 목록으로 온다.
   * 빈 칸 · 형식이 틀린 코드가 하나라도 있거나 50개를 넘으면 400 이다.
   */
  @ApiPropertyOptional({ type: String, example: 'STORE_TYPE,STORE_STATUS' })
  @IsOptional()
  // `a,b` 도 `?groups=a&groups=b` 도 같은 목록이 된다. 빈 칸은 남겨 형식 검사가 막는다.
  @Transform(({ value }: { value: unknown }) =>
    String(value)
      .split(',')
      .map((v) => v.trim()),
  )
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @Matches(CODE_PATTERN, {
    each: true,
    message:
      'groups 는 영문 대문자로 시작하는 그룹 코드를 쉼표로 구분해 보냅니다.',
  })
  groups?: string[];
}
