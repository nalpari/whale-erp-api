import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { CodeValueDto } from '../../codes/dto/code-items.response.dto';

export class AdminLoginInfoBpDto {
  bpCodeId: number;
  /** BP+6자리. 플랫폼 BP 는 BP000000. */
  bpCode: string;
  tradeName: string;
  /** true 면 플랫폼 관리 사이트 계정(PM · PA). */
  isPlatform: boolean;
}

export class AdminLoginInfoAccountDto {
  adminAccountId: number;
  loginId: string;
  name: string | null;
  email: string | null;
  /** 권한 유형 — 공통코드 `ROLE_TYPE`(PM · PA · BM · BA · FM · FA). */
  roleTypeCode: string;
  bp: AdminLoginInfoBpDto;
  /** true 면 닫을 수 없는 강제 비밀번호 변경 팝업을 띄운다. */
  isPasswordChangeRequired: boolean;
  /** 임시 비밀번호로 들어왔으면 그 만료 시각. 이때 세션도 끝난다. 아니면 null. */
  temporaryPasswordExpiresAt: Date | null;
  /** true 면 강제 변경 팝업 아래에 약관 동의를 붙인다(플랫폼등록 계정의 첫 로그인). */
  isTermsAgreementRequired: boolean;
}

export class MenuPermissionDto {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
}

export class AdminMenuDto {
  /** MN+6자리. 업무 API 의 메뉴 권한 판정도 이 코드로 한다. */
  menuCode: string;
  name: string;
  url: string | null;
  /** 1~3 */
  depth: number;
  /** 이 메뉴에서 할 수 있는 것. 하위 메뉴로 가는 길로만 들어간 상위 메뉴는 모두 false. */
  permission: MenuPermissionDto;
  @ApiProperty({ type: () => [AdminMenuDto] })
  children: AdminMenuDto[];
}

export class AdminStoreDto {
  storeId: number;
  storeCode: string;
  name: string;
  /** 공통코드 `STORE_TYPE` */
  storeTypeCode: string;
  /** 공통코드 `STORE_STATUS` */
  storeStatusCode: string;
}

@ApiExtraModels(CodeValueDto)
export class AdminLoginInfoResponseDto {
  account: AdminLoginInfoAccountDto;
  /** 조회 권한이 있는 메뉴 트리(최대 3단계). 표시 순서대로. */
  menus: AdminMenuDto[];
  /** 관리 점포 — 점포 선택 목록. 플랫폼 계정은 빈 목록이다(BP 를 골라 일한다). */
  stores: AdminStoreDto[];
  /** 그룹 코드 → 이 계정 BP 의 공통코드 */
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: { $ref: getSchemaPath(CodeValueDto) },
    },
    example: { STORE_TYPE: [{ value: 'DIRECT', label: '직영점포', order: 1 }] },
  })
  codes: Record<string, CodeValueDto[]>;
}
