import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class ContractExpiryService {
  /**
   * 서명 기한이 지난 서명 대기 계약을 만료로 바꾸고 상태 이력을 남긴다.
   * 조건부 UPDATE 라 여러 번 실행해도 같은 계약을 두 번 처리하지 않는다.
   * 같은 순간 직원이 서명해도, 기본 격리 수준(READ COMMITTED)의 UPDATE 는 행
   * 잠금을 기다린 뒤 조건을 다시 보므로 체결 완료된 계약을 만료시키지 않는다.
   * 반대 순서(만료 뒤 서명)는 서명 쪽 UPDATE 도 상태 조건을 걸어야 막힌다.
   */
  async expireOverdue(
    tx: Prisma.TransactionClient,
    now = new Date(),
  ): Promise<number> {
    const expired = await tx.contract.updateManyAndReturn({
      where: { status: 'PENDING_SIGNATURE', signDeadlineAt: { lte: now } },
      data: { status: 'EXPIRED' },
      select: { contractId: true },
    });
    if (expired.length === 0) return 0;

    await tx.contractStatusHistory.createMany({
      data: expired.map(({ contractId }) => ({
        contractId,
        fromStatus: 'PENDING_SIGNATURE' as const,
        toStatus: 'EXPIRED' as const,
        actor: 'SYSTEM' as const,
      })),
    });
    return expired.length;
  }
}
