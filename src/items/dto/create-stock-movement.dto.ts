import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

// quantity 컬럼은 INTEGER 다. 범위 밖 값을 그대로 내려보내면 Postgres 가
// 에러를 내 500 이 되므로 여기서 막는다. id 쪽 ItemsService.toId 와 같은 이유다.
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

export class CreateStockMovementDto {
  @IsInt()
  @NotEquals(0)
  @Min(INT_MIN)
  @Max(INT_MAX)
  quantity: number;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: '$property 는 공백만으로 채울 수 없습니다' })
  @MaxLength(200)
  reason: string;
}
