import { ApiProperty } from '@nestjs/swagger';
import { UseStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { NO_NUL } from '../../common/no-nul';
import { IsUpdatedAt } from '../../common/updated-at';
import {
  emptyToNull,
  INT4_MAX,
  trimText,
} from '../../platform-admins/platform-admin-format';
import {
  MENU_NAME_MAX,
  MENU_URL_MAX,
  MENU_URL_PATTERN,
} from '../platform-menu-format';

/** 노출 메뉴명 · URL · 사용 상태 — 상세에서 고칠 수 있는 셋(S-GXMZOU). */
class PlatformMenuFieldsDto {
  /** 노출 메뉴명. 앞뒤 공백을 지우고 1~20자. 같은 상위 아래 같은 이름도 받는다. @example 플랫폼 메뉴 관리 */
  @Transform(trimText)
  @IsString()
  @MinLength(1, { message: '노출 메뉴명을 입력해 주세요' })
  @MaxLength(MENU_NAME_MAX, { message: '노출 메뉴명은 20자까지입니다' })
  @Matches(NO_NUL, { message: '노출 메뉴명에 쓸 수 없는 문자가 있습니다' })
  name: string;

  /**
   * 메뉴 URL. 선택 — 하위를 묶기만 하는 메뉴는 비운다(비우면 null). `/소문자-숫자` 구간, 200자까지. 새로 넣는 URL 은
   * 1뎁스 한 구간만 받는다(`/staff/content` 가 아니라 `/staff-content` — 등록과, 수정에서 바꿀 때 400). 그대로 둔 기존 URL 은
   * 여러 구간이어도 받는다. 사용 중 메뉴끼리 같거나 한쪽이 다른 쪽 아래 경로면 409. @example /staff-content
   */
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(MENU_URL_MAX, { message: '메뉴 URL 은 200자까지입니다' })
  @Matches(MENU_URL_PATTERN, {
    message:
      "메뉴 URL 은 '/' 로 시작하는 소문자 · 숫자 · '-' 경로여야 합니다(예: /staff-content)",
  })
  url?: string | null;
}

const SERVICE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,19}$/;

/** 메뉴 트리 조회 — 서비스 하나. */
export class PlatformMenuTreeQueryDto {
  /** 서비스 코드 — 공통코드 SERVICE 값(사용중지 서비스도 된다). @example PLATFORM */
  @IsString()
  @Matches(SERVICE_CODE_PATTERN, { message: '서비스 코드 형식이 아닙니다' })
  serviceCode: string;
}

/** 메뉴 등록. 고른 상위의 맨 끝에 붙고, 메뉴 코드는 저장할 때 채번한다. */
export class CreatePlatformMenuDto extends PlatformMenuFieldsDto {
  /** 서비스 코드 — 공통코드 SERVICE 값(사용중지 서비스도 된다). @example PLATFORM */
  @IsString()
  @Matches(SERVICE_CODE_PATTERN, { message: '서비스 코드 형식이 아닙니다' })
  serviceCode: string;

  /** 상위 메뉴. 생략하거나 null 이면 최상위(1단계). 같은 서비스의 2단계까지의 메뉴여야 한다. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  parentMenuId?: number | null;

  /** 사용 상태. 생략하면 사용(ACTIVE). */
  @IsOptional()
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus', required: false })
  @IsEnum(UseStatus)
  status?: UseStatus;
}

/** 상세 저장 — 통째로 바꾼다. URL 을 빼면 비운다(null). 서비스 · 상위 · 코드 · 순서는 바꾸지 않는다. */
export class UpdatePlatformMenuDto extends PlatformMenuFieldsDto {
  /** 사용 상태. 미사용이면 사용자 화면과 신규 권한 부여에서 빠지고, 이미 준 권한은 남는다. */
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  @IsEnum(UseStatus)
  status: UseStatus;

  /** 상세에서 받은 최종수정일시 그대로. 그 사이 다른 사람이 고쳤으면 저장하지 않고 409. */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 위치 옮기기 — 같은 서비스 안에서만, 하위가 함께 간다. 옮길 때마다 바로 저장된다. */
export class MovePlatformMenuDto {
  /** 새 상위 메뉴. null 이면 최상위. */
  @ApiProperty({ type: Number, nullable: true })
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  parentMenuId: number | null;

  /** 새 상위 아래의 자리 — 0 이 맨 앞, 형제 수 이상이면 맨 끝. */
  @IsInt()
  @Min(0)
  @Max(10_000)
  index: number;
}
