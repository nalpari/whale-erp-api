import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';
import { trimText } from '../code-format';

/**
 * 공통코드 그룹 목록 쪽 이동과 검색. 목록 응답 규칙의 page(1부터) · pageSize(기본 20, 최대 200). 조건은 모두 AND,
 * 주지 않으면 전체. BP 공통코드 관리도 같은 조건을 쓴다(ListBpCodeGroupsDto).
 */
export class ListCodeGroupsDto extends PageDto {
  /** 그룹 코드에 들어 있으면 나온다(대소문자 무시). @example EMP */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(20)
  groupCode?: string;

  /** 그룹명에 들어 있으면 나온다. @example 고용 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(50)
  groupName?: string;
}
