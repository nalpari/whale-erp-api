import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateItemDto {
  // id 는 받지 않는다. DB 가 GENERATED ALWAYS AS IDENTITY 라
  // 값을 보내면 Postgres 가 거부한다.
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sku: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsIn(['EA', 'KG', 'M', 'BOX'])
  unit?: string;
}
