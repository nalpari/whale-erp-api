import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';
import {
  PLATFORM_OWNER_CODES,
  trimText,
  type PlatformOwnerCode,
} from '../code-format';

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

  /**
   * 관리 주체. 여러 개는 `manageOwnerCodes=PLATFORM_FIXED&manageOwnerCodes=PLATFORM_PROVIDED` 또는 쉼표로.
   * 주지 않으면 둘 다(플랫폼고정 · 플랫폼제공).
   */
  @IsOptional()
  // 반복 · 쉼표 · 둘을 섞은 것을 한 배열로, 빈 조각은 버린다 — `?manageOwnerCodes=` 는 「안 줌」(둘 다)과 같다
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((v: unknown) => (typeof v === 'string' ? v.split(',') : [v]))
      .map((v: unknown) => (typeof v === 'string' ? v.trim() : v))
      .filter((v: unknown) => v !== ''),
  )
  @IsIn(PLATFORM_OWNER_CODES, { each: true })
  manageOwnerCodes?: PlatformOwnerCode[];
}
