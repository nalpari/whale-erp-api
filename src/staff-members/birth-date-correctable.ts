import type { EmploymentStatus } from '@prisma/client';
import { employedOn } from '../contracts/contract-status';

/**
 * 생년월일을 정정할 수 있는 직원 레코드인가 (WHALEERP-602). 정정 서비스(StaffBirthDateService)의 판정과 직원 상세의
 * `birthDateCorrectable` 이 이 함수 하나를 함께 쓴다 — 둘이 어긋나면 화면의 [정정] 버튼이 눌러도 409 인 채로 남는다.
 * 계정이 있고 `JOINED` 이며(탈퇴 · 연결 보류 아님), 퇴직하지 않았을 때다. 퇴직일이 지났는데 배치가 아직 RETIRED 로
 * 바꾸지 않은 레코드는 퇴직으로 보아 false 다(계약과 같은 `employedOn`). 관리자 권한은 보지 않는다.
 */
export function isBirthDateCorrectable(
  staff: {
    employmentStatus: EmploymentStatus;
    retiredDate: Date | null;
    account: { status: string } | null;
  },
  now: Date,
): boolean {
  return staff.account?.status === 'JOINED' && employedOn(staff, now);
}
