import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  ValidateNested,
} from 'class-validator';
import {
  MAX_GROUP_ROWS,
  PLATFORM_OWNER_CODES,
  type PlatformOwnerCode,
} from '../code-format';
import { CodeGroupInputDto } from './code-group-input.dto';

/** 새 그룹. BP 적용 여부는 받지 않는다 — 늘 미적용으로 만든다. */
export class CreateCodeGroupDto extends CodeGroupInputDto {
  /** 관리 주체. 플랫폼고정 · 플랫폼제공만. 등록 뒤 바꾸지 않는다. */
  @IsIn(PLATFORM_OWNER_CODES)
  manageOwnerCode: PlatformOwnerCode;
}

/** 그룹 등록 — 새 그룹 여러 개를 한 번에 만든다. */
export class CreateCodeGroupsDto {
  /** 만들 그룹. 1~200행. 한 요청 안에서 그룹 코드가 겹치면 409. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_ROWS)
  @ValidateNested({ each: true })
  @Type(() => CreateCodeGroupDto)
  items: CreateCodeGroupDto[];
}
