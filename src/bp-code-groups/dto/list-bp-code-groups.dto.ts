import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { trimText } from '../../code-groups/code-format';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';

/**
 * BP 공통코드 그룹 목록 검색. 조건은 모두 AND, 주지 않으면 전체. 대상 BP 는 쿼리가 아니라 X-Bp-Code-Id 헤더로 받는다
 * (가드가 정한다).
 */
export class ListBpCodeGroupsDto extends PageDto {
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
