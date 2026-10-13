import { ApiProperty } from '@nestjs/swagger';
import { NotificationTemplateChannel } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/** 채널 탭 하나의 목록 */
export class ListTemplatesDto {
  @ApiProperty({
    enum: NotificationTemplateChannel,
    enumName: 'NotificationTemplateChannel',
  })
  @IsEnum(NotificationTemplateChannel)
  channel: NotificationTemplateChannel;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  /** 기본 20 · 최대 200 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
