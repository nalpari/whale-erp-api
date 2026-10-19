import { ApiProperty } from '@nestjs/swagger';
import { UseStatus } from '@prisma/client';

/** 서비스 탭 하나 — 공통코드 SERVICE 의 값(사용중지 포함)과 그 서비스의 메뉴 수. */
export class PlatformMenuServiceResponseDto {
  /** 서비스 코드. @example PLATFORM */
  serviceCode: string;
  /** 서비스 이름(공통코드 표시명). @example Whale ERP 플랫폼 관리 */
  name: string;
  /** 서비스 사용 상태. 사용중지 서비스도 고르고 편집할 수 있지만 사용자 화면에는 보이지 않는다. */
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
  /** 지우지 않은 메뉴 수. */
  menuCount: number;
  /** 그중 사용 상태가 사용인 메뉴 수(상위가 사용중지라 숨은 것도 센다). */
  activeMenuCount: number;
  inactiveMenuCount: number;
}

/** 서비스 탭 — 공통코드 순서대로, 페이지 없이. */
export class PlatformMenuServiceListResponseDto {
  items: PlatformMenuServiceResponseDto[];
  total: number;
}

export class PlatformMenuServiceRefResponseDto {
  serviceCode: string;
  name: string;
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
}

/** 트리의 메뉴 한 줄. 형제 안에서 순서대로. */
export class PlatformMenuNodeResponseDto {
  menuId: number;
  /** 메뉴 코드 — MN + 6자리. @example MN000215 */
  menuCode: string;
  /** 노출 메뉴명. */
  name: string;
  /** 메뉴 URL. 묶음 메뉴는 보통 null. */
  url: string | null;
  /** 메뉴 계층 1~3. */
  depth: number;
  /** 형제 안의 순서 — 1부터. */
  sortOrder: number;
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
  /** 하위가 있는 메뉴(묶음). */
  isGroup: boolean;
  /** 사용자 화면에 보이지 않는가 — 자신 · 조상 · 서비스 중 하나라도 사용중지. 자기 상태 값은 사용일 수 있다. */
  isHidden: boolean;
  @ApiProperty({ type: () => [PlatformMenuNodeResponseDto] })
  children: PlatformMenuNodeResponseDto[];
}

/** 서비스 하나의 메뉴 트리. items 는 최상위 메뉴, total 은 지우지 않은 메뉴 전체 수. */
export class PlatformMenuTreeResponseDto {
  service: PlatformMenuServiceRefResponseDto;
  items: PlatformMenuNodeResponseDto[];
  total: number;
}

/** 등록자 · 수정자. 시스템(마이그레이션)이 넣은 행이면 null. */
export class PlatformMenuActorResponseDto {
  name: string | null;
  loginId: string;
}

export class PlatformMenuParentResponseDto {
  menuId: number;
  menuCode: string;
  name: string;
}

/** 메뉴 상세. 노출 메뉴명 · URL · 사용 상태만 고칠 수 있고, 나머지는 읽기 전용이다(S-GXMZOU). */
export class PlatformMenuDetailResponseDto {
  menuId: number;
  menuCode: string;
  serviceCode: string;
  serviceName: string;
  /** 상위 메뉴. 최상위(1단계)면 null. */
  parent: PlatformMenuParentResponseDto | null;
  /** 최상위부터 이 메뉴까지의 노출 메뉴명. @example ["시스템관리", "플랫폼 메뉴 관리"] */
  path: string[];
  name: string;
  url: string | null;
  depth: number;
  sortOrder: number;
  @ApiProperty({ enum: UseStatus, enumName: 'UseStatus' })
  status: UseStatus;
  isGroup: boolean;
  /** 사용자 화면에 보이지 않는가 — 자신 · 조상 · 서비스 중 하나라도 사용중지. 사용중지 상위 아래의 메뉴면 「사용자에게는 보이지 않는다」를 알린다. */
  isHidden: boolean;
  createdAt: Date;
  createdBy: PlatformMenuActorResponseDto | null;
  /** 최종수정일시 — 저장할 때 그대로 돌려보낸다(동시 수정 확인). */
  updatedAt: Date;
  updatedBy: PlatformMenuActorResponseDto | null;
}

export class CreatePlatformMenuResponseDto {
  menuId: number;
  /** 저장할 때 채번한 메뉴 코드. @example MN000223 */
  menuCode: string;
}
