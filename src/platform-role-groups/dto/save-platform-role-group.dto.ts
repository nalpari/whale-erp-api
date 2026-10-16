import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';
import { NO_NUL } from '../../common/no-nul';
import {
  emptyToNull,
  INT4_MAX,
  trimText,
} from '../../platform-admins/platform-admin-format';
import {
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
} from '../platform-role-group-format';

/** 권한 등록. 유형은 받지 않는다 — 플랫폼 관리자(PA) 추가 권한만 만든다. 고정 권한(PM000001 · BM000001 · FM000001)은 마이그레이션이 넣는다. */
export class CreatePlatformRoleGroupDto {
  /** 권한명. 앞뒤 공백을 지우고 1~20자. 플랫폼 권한(PM · PA · BM · FM) 안에서 겹칠 수 없다. @example 고객지원 담당 */
  @Transform(trimText)
  @IsString()
  @MinLength(1, { message: '권한명을 입력해 주세요' })
  @MaxLength(ROLE_NAME_MAX, { message: '권한명은 20자까지입니다' })
  @Matches(NO_NUL, { message: '권한명에 쓸 수 없는 문자가 있습니다' })
  name: string;

  /** 설명. 선택, 앞뒤 공백을 지우고 100자까지. 비우면 null. @example 커뮤니티관리·BP 조회 */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(ROLE_DESCRIPTION_MAX, { message: '설명은 100자까지입니다' })
  @Matches(NO_NUL, { message: '설명에 쓸 수 없는 문자가 있습니다' })
  description?: string | null;
}

/** 권한명 · 설명 수정. 유형 · 코드는 바꾸지 않는다. */
export class UpdatePlatformRoleGroupDto extends CreatePlatformRoleGroupDto {
  /** 상세에서 받은 최종수정일시 그대로. 그 사이 다른 사람이 고쳤으면 저장하지 않고 409. */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 메뉴 한 줄의 네 칸. 묶음 메뉴(하위가 있는 메뉴)의 값은 서버가 하위에서 다시 정하므로 무시된다. */
export class RoleGroupMenuCellsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  menuId: number;

  @IsBoolean()
  read: boolean;

  @IsBoolean()
  create: boolean;

  @IsBoolean()
  update: boolean;

  @IsBoolean()
  delete: boolean;
}

/**
 * 회수 미리보기. 저장과 같은 메뉴 목록을 받는다 — 바뀐 칸만이 아니라 메뉴별 네 칸을 보내고, 서버가 현재 값과
 * 견줘 바뀐 칸을 구한다. 보내지 않은 메뉴는 그대로 둔다. 숨겨진 메뉴(사용중지 메뉴 · 사용중지 상위 아래 ·
 * 사용중지 서비스 · 지운 메뉴)는 보내면 400 이다.
 */
export class PreviewRoleGroupMenusDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => RoleGroupMenuCellsDto)
  menus: RoleGroupMenuCellsDto[];
}

/** 메뉴 권한 저장. 미리보기와 같은 목록 + 최종수정일시. */
export class SaveRoleGroupMenusDto extends PreviewRoleGroupMenusDto {
  /** 메뉴 트리 · 상세에서 받은 최종수정일시 그대로. 그 사이 다른 사람이 고쳤으면 저장하지 않고 409. */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 권한 삭제. 연결 사용자가 있으면 대체 권한이 있어야 한다. */
export class DeletePlatformRoleGroupDto {
  /** 대체 권한 — 같은 유형(PA)의 지우지 않은 다른 추가 권한. 고정 권한은 고를 수 없다. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  replacementRoleGroupId?: number;

  @IsUpdatedAt()
  updatedAt: string;
}
