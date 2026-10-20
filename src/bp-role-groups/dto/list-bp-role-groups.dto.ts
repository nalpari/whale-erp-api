import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';
import { INT4_MAX } from '../../platform-admins/platform-admin-format';

/** 대상 BP. BP 사용자는 생략하면 자기 BP(다른 BP 면 403), 플랫폼 사용자는 필수(없으면 400). */
export class BpRoleGroupScopeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  bpCodeId?: number;
}

export class ListBpRoleGroupsDto extends PageDto {
  /** 대상 BP. BP 사용자는 생략하면 자기 BP(다른 BP 면 403), 플랫폼 사용자는 필수(없으면 400). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  bpCodeId?: number;
}
