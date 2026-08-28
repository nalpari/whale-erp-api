import {
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  NotEquals,
} from 'class-validator';

export class CreateStockMovementDto {
  @IsInt()
  @NotEquals(0)
  quantity: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;
}
