import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';
import { trimText } from '../../platform-admins/platform-admin-format';

/** BP 선택 목록 검색. 쪽은 목록 응답 규칙(PageDto)을 따른다. */
export class ListBpCodesDto extends PageDto {
  /** 상호 · BP코드 중 하나에 들어 있으면 나온다(대소문자 무시). 앞뒤 공백은 자른다. @example 고래 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(50)
  keyword?: string;
}
