import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// 목록은 반드시 상한이 있어야 한다. 품목 마스터가 수만 건이 되면
// 무제한 조회는 응답과 메모리를 함께 무너뜨린다.
export class ListItemsQueryDto {
  /** 한 번에 가져올 개수. 기본 50, 최대 200. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  /** 건너뛸 개수. 기본 0. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}
