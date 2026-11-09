import { ApiProperty } from '@nestjs/swagger';

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

  /** 진행 중인 근로계약(작성 중 · 서명 요청 전 · 서명 대기 · 수정 요청 · 서명 완료)이 있으면 true — 있으면 탈퇴를 막는다. */
  @ApiProperty()
  hasInProgressContract: boolean;
}
