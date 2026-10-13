import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsInt, Max, Min } from 'class-validator';

/** 선택 삭제. 쉼표로 구분한 알림 ID(목록의 id). 내 것이 아닌 ID 는 조용히 빠진다. */
export class NotificationDeleteQueryDto {
  /** 빈 칸 · 숫자가 아닌 값 · 1..2147483647 밖의 값이 있거나 200개를 넘으면 400 이다 */
  @ApiProperty({ type: String, example: '70,71' })
  @Transform(({ value }) =>
    String(value)
      .split(',')
      .map((v) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN)),
  )
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2_147_483_647, { each: true })
  ids: number[];
}
