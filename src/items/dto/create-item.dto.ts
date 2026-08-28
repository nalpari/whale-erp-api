import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// 앞뒤 공백을 떼고 나서 검증한다. 이렇게 하지 않으면 '   ' 가 @IsNotEmpty 를
// 통과해 DB 의 CHECK 제약까지 내려가고, 400 이어야 할 응답이 500 이 된다.
const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateItemDto {
  // id 는 받지 않는다. DB 가 GENERATED ALWAYS AS IDENTITY 라
  // 값을 보내면 Postgres 가 거부한다.
  @Trim()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: '$property 는 공백만으로 채울 수 없습니다' })
  @MaxLength(64)
  sku: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: '$property 는 공백만으로 채울 수 없습니다' })
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsIn(['EA', 'KG', 'M', 'BOX'])
  unit?: string;
}
