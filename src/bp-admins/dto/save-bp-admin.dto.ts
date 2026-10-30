import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';
import {
  ADMIN_STATUSES,
  type AdminStatus,
} from '../../platform-admins/dto/list-platform-admins.dto';
import {
  INT4_MAX,
  LOGIN_ID_PATTERN,
  lowerEmail,
  NAME_PATTERN,
  PHONE_PATTERN,
  trimText,
} from '../../platform-admins/platform-admin-format';
import { BP_ADMIN_ROLES, type BpAdminRole } from '../bp-admin-rules';

/** 등록 · 수정이 같이 받는 칸. */
class BpAdminProfileDto {
  /** 이름. 한글 · 영문 2~20자. @example 한지수 */
  @Transform(trimText)
  @Matches(NAME_PATTERN, { message: '이름은 한글 또는 영문 2~20자입니다.' })
  name: string;

  /**
   * 연락처. 하이픈 없이 숫자 9~12자리 — 1팀 연락처 범위(02 지역번호 9자리 · 050X 평생번호 12자리)를
   * 그대로 받는다. 중복 검사는 하지 않는다. @example 01012345678
   */
  @Matches(PHONE_PATTERN, { message: '연락처는 숫자 9~12자리입니다.' })
  phone: string;

  /** 이메일. 소문자로 저장한다. 지우지 않은 사용 · 미사용 관리자 계정끼리 겹칠 수 없다. @example jisu@whale.test */
  @Transform(lowerEmail)
  @IsEmail({}, { message: '이메일 형식이 아닙니다.' })
  @MaxLength(100)
  email: string;

  /** 권한 그룹. BP 관리자는 그 BP 의 BA 그룹, 가맹 마스터는 고정 FM000001, 가맹 관리자는 연결 가맹 마스터의 FA 그룹. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  roleGroupId: number;

  /** 전체 점포. BP 관리자에게만, 전체 점포를 맡은 사람만 줄 수 있다. */
  @IsBoolean()
  isAllStores: boolean;

  /** 일부 점포일 때 맡길 점포 — 호출자의 관리 범위 안. 전체 점포면 무시한다. 1000개까지. */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds: number[];
}

/** BP 관리자 등록. 비밀번호 · 상태는 받지 않는다 — 늘 사용으로 만들고 초기 비밀번호를 메일로 보낸다. */
export class CreateBpAdminDto extends BpAdminProfileDto {
  /** 아이디. 영문 또는 영문 · 숫자 4~20자. 삭제 · 탈퇴한 계정까지 포함해 겹칠 수 없고 바꿀 수 없다. @example jisu01 */
  @Transform(trimText)
  @Matches(LOGIN_ID_PATTERN, {
    message: '아이디는 영문 또는 영문 · 숫자 조합으로 4~20자입니다.',
  })
  loginId: string;

  /** 계정 역할. 본사는 BA · FM, 가맹 마스터는 FA 만. 등록 뒤 바꾸지 않는다. */
  @ApiProperty({ enum: BP_ADMIN_ROLES, enumName: 'BpAdminRole' })
  @IsIn(BP_ADMIN_ROLES)
  roleTypeCode: BpAdminRole;
}

/** BP 관리자 수정. 아이디 · 역할 · 연결 가맹 마스터는 바꾸지 않는다. 본인 계정은 이름 · 연락처 · 이메일만. */
export class UpdateBpAdminDto extends BpAdminProfileDto {
  /** 계정 상태. 가맹 마스터를 미사용으로 바꾸면 연결된 사용 중 가맹 관리자도 미사용이 된다. */
  @ApiProperty({ enum: ADMIN_STATUSES, enumName: 'AdminAccountStatus' })
  @IsIn(ADMIN_STATUSES)
  accountStatus: AdminStatus;

  /** 상세에서 받은 최종수정일시 그대로. 그 사이 다른 사람이 고쳤으면 저장하지 않고 409. */
  @IsUpdatedAt()
  updatedAt: string;
}
