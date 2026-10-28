import { ApiPropertyOptional } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

/**
 * 재발송(POST /contracts/:contractId/send) 본문. 비워 보내도 된다(옛 화면 · 직원 목록의 재발송).
 */
export class SendContractDto {
  /**
   * 화면이 본 계약 상태 — 지금 상태와 다르면 409 CONTRACT_STATUS_CONFLICT(그사이 거부 · 만료되었거나 다른 탭에서 먼저 보냄). 재발송은
   * 서명 대기 · 발송 대기 · 거부 · 만료를 모두 받아, 이 값이 없으면 열어 둔 서명 대기 화면에서 거부된 계약을 모르고 되살리거나
   * 두 탭이 같은 만료 계약을 두 번 보낸다(front #136 재리뷰)
   */
  @ApiPropertyOptional({ enum: ContractStatus, enumName: 'ContractStatus' })
  @IsOptional()
  @IsEnum(ContractStatus)
  expectedStatus?: ContractStatus;
}
