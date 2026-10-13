import { ApiProperty } from '@nestjs/swagger';
import { PostContentType } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { PostFieldsDto } from './post-fields.dto';

export class CreatePostDto extends PostFieldsDto {
  /** 공지사항 · FAQ. 등록 뒤 바꾸지 않는다. */
  @ApiProperty({ enum: PostContentType, enumName: 'PostContentType' })
  @IsEnum(PostContentType)
  contentType: PostContentType;
}
