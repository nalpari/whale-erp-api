import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { WithdrawEligibilityResponseDto } from './dto/admin-withdrawal-eligibility.response.dto';

const NOT_FOUND = '관리자 계정을 찾을 수 없습니다';
const NOT_BP_MASTER = 'BP 마스터만 탈퇴할 수 있습니다';
const BP_MASTER = 'BM';
const WITHDRAWN = 'WITHDRAWN';
const CLOSED = 'CLOSED';

/** 탈퇴 전이라도 근로계약서가 끝까지 가지 않은 상태 — 있으면 BP 탈퇴를 막는다. */
const IN_PROGRESS_CONTRACT_STATUSES: ContractStatus[] = [
  'DRAFT',
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'SIGNED',
];

/**
 * 회원 탈퇴(MY PAGE S-JHQQNR). BP 마스터 본인만 받는다 — 탈퇴하면 같은 BP 의 하위 관리자(BP 관리자 ·
 * 가맹마스터 · 가맹관리자)도 함께 탈퇴하고 점포는 모두 강제 폐점된다(1팀 규칙, admin_accounts.statusChangedAt
 * 주석 참고). getEligibility 는 그 전에 보여줄 영향 범위만 센다 — 실제 탈퇴(execute)는 Task 2 다.
 *
 * contracts(3팀)는 1팀 stores 와 Prisma 관계로 잇지 않는다(schema.prisma 머리말 — storeId 는 정수 칸만 있다).
 * 그래서 이 BP 의 점포 id 를 먼저 받아 그 id 로 진행 중 계약을 센다(admin-scope.service.ts 의
 * storeId: { in: ... } 패턴과 같다).
 */
@Injectable()
export class AdminWithdrawalService {
  constructor(private readonly prisma: PrismaService) {}

  async getEligibility(
    adminAccountId: number,
  ): Promise<WithdrawEligibilityResponseDto> {
    const account = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false },
      select: { roleTypeCode: true, bpCodeId: true },
    });
    if (!account) throw new NotFoundException(NOT_FOUND);
    if (account.roleTypeCode !== BP_MASTER)
      throw new ForbiddenException(NOT_BP_MASTER);

    const { bpCodeId } = account;
    const [bpCode, adminCount, storeCount, stores] = await Promise.all([
      this.prisma.bpCode.findUniqueOrThrow({
        where: { bpCodeId },
        select: { tradeName: true },
      }),
      this.prisma.adminAccount.count({
        where: {
          bpCodeId,
          adminAccountId: { not: adminAccountId },
          isDeleted: false,
          accountStatusCode: { not: WITHDRAWN },
        },
      }),
      this.prisma.store.count({
        where: { bpCodeId, isDeleted: false, storeStatusCode: { not: CLOSED } },
      }),
      this.prisma.store.findMany({
        where: { bpCodeId },
        select: { storeId: true },
      }),
    ]);

    const contractCount = await this.prisma.contract.count({
      where: {
        storeId: { in: stores.map((store) => store.storeId) },
        status: { in: IN_PROGRESS_CONTRACT_STATUSES },
      },
    });

    return {
      bpName: bpCode.tradeName,
      adminCount,
      storeCount,
      hasInProgressContract: contractCount > 0,
    };
  }
}
