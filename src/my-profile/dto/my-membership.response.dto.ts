import { ApiProperty } from '@nestjs/swagger';
import { EmploymentType } from '@prisma/client';

export class MyStoreDto {
  storeId: number;
  storeName: string;
  /** 점포 유형 — 공통코드 `STORE_TYPE`(DIRECT 직영 · FRANCHISE 가맹) */
  storeTypeCode: string;
}

/** 소속 하나 = 재직 직원 레코드 하나(점포마다 따로). 근로계약서 · 급여명세서 · 신고 정보는 이 `staffMemberId` 로 연다 */
export class MyMembershipDto {
  staffMemberId: number;
  store: MyStoreDto;
  @ApiProperty({ enum: EmploymentType, enumName: 'EmploymentType' })
  employmentType: EmploymentType;
  jobTitle: string;
  /** 입사일(YYYY-MM-DD) */
  hiredDate: string | null;
  /**
   * 퇴직일(YYYY-MM-DD) — 이날까지 일한다. 오늘(한국 시각) · 뒤면 퇴직 예정, 앞이면 퇴직(`includeRetired=true` 로 받은
   * 퇴직한 소속)이다. 없으면 null. 목록의 묶음(지금 소속 · 퇴직)은 재직 상태로 가르므로, 퇴직 배치가 늦은 날에는 퇴직일이 지난
   * 레코드가 지금 소속 쪽에 섞일 수 있다
   */
  retiredDate: string | null;
}

export class MyMembershipListResponseDto {
  /**
   * 체결 완료 근로계약이 있고 가입 완료 · 퇴직 전인 직원 레코드. 입사일(없으면 뒤) · id 순. `includeRetired=true` 면 그 뒤에
   * 퇴직한 레코드가 퇴직일 최근 순으로 붙는다
   */
  items: MyMembershipDto[];
  total: number;
}

/** 신고 정보 (TAX-8). 주민등록번호 · 계좌번호 원문은 내려주지 않는다 */
export class MyTaxProfileDto {
  /** 가린 주민등록번호 — `980304-1******` */
  rrnMasked: string;
  /** 은행 코드 */
  bankCode: string;
  /** 가린 급여 계좌 — 끝 4자리만, `********6789` */
  payrollAccountNumberMasked: string;
  /** 수집 목적 */
  purpose: string;
  /** 수집 일시 */
  collectedAt: Date;
}

export class MyTaxProfileResponseDto {
  staffMemberId: number;
  /** 이 소속에 낸 신고 정보. 아직 내지 않았으면 null */
  taxProfile: MyTaxProfileDto | null;
}
