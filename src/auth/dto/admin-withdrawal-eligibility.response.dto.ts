import { ApiProperty } from '@nestjs/swagger';
import { StoreClosingCheckResponseDto } from '../../store-closings/dto/store-closing.response.dto';

/** 회원 탈퇴(마이페이지) 전 보여줄 조건 — BP 마스터만 받는다. */
export class WithdrawEligibilityResponseDto {
  /** BP 상호명. */
  @ApiProperty()
  bpName: string;

  /** 함께 미사용(개인정보 지움)될 하위 관리자 수(BP 관리자 · 가맹마스터 · 가맹관리자) — 요청한 BP 마스터 자신은 빼고 센다. */
  @ApiProperty()
  adminCount: number;

  /** 함께 강제 폐점될 점포 수 — 이미 폐점한 점포는 빼고 센다. */
  @ApiProperty()
  storeCount: number;

  /**
   * 함께 폐점할 점포(폐점 안 한 점포 전부)의 폐점 확인 — 점포 관리 폐점과 같은 값이다. 점포별 값은 stores[], 합계는 total.
   * isBlocked(퇴근 기록 없는 출근이 있음)면 탈퇴를 막는다 — 막는 조건은 이것 하나뿐이다.
   */
  closing: StoreClosingCheckResponseDto;
}
