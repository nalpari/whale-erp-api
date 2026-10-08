import { ApiProperty } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';

export class ContractToEndDto {
  contractId: number;
  /** 발송 대기 또는 서명 대기 */
  @ApiProperty({ enum: ContractStatus, enumName: 'ContractStatus' })
  status: ContractStatus;
}

/** 퇴직이 확정될 때(퇴직일 다음 날) 정리될 것들. 확인창에 보여 준다. */
export class RetirementPreviewResponseDto {
  /** 퇴직일 다음 날부터의 근무스케줄 수 — 지운다 */
  schedulesToRemove: number;
  /** 개인으로 배정된 미완료 TO-DO 수 — 배정을 푼다 */
  todosToUnassign: number;
  /** 발송 대기 · 서명 대기 계약 — 종료로 닫는다 */
  contractsToEnd: ContractToEndDto[];
}
