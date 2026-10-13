import { ApiPropertyOptional } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListContractsQueryDto {
  /** 1부터 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 20;

  /** 여러 개면 `?status=SIGNED&status=REJECTED`. 없으면 전체 */
  @ApiPropertyOptional({
    enum: ContractStatus,
    enumName: 'ContractStatus',
    isArray: true,
  })
  @IsOptional()
  // 하나만 오면 쿼리 파서가 배열이 아니라 문자열로 준다.
  @Transform(({ value }: { value: unknown }): unknown[] =>
    Array.isArray(value) ? (value as unknown[]) : [value],
  )
  @IsEnum(ContractStatus, { each: true })
  status?: ContractStatus[];

  /** 점포 이름 일부 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  storeName?: string;

  /** 직원 이름 일부 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  staffMemberName?: string;
}
