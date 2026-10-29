import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
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
  /**
   * true 면 BP 마스터 계정이 있는 BP 만 — BP 선택 팝업이 BP 마스터 계정 목록과 같은 범위 · 건수를 보이려고 준다(2026-10-29 사용자 지정).
   * 없거나 false 면 거르지 않는다 — BP 탭 · 상태 확인은 BP 마스터 계정이 없는 BP 도 찾아야 한다. 'true' · 'false' 밖의 값은 400.
   */
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  withMaster?: boolean;
}
