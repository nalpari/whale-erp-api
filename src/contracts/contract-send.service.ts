import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ContractDeliveryService,
  SEND_VALID_MS,
} from './contract-delivery.service';
import { lockContract, statusConflict } from './contract-status';
import {
  ContractsService,
  decideInvitation,
  lockPeople,
} from './contracts.service';

const RESENDABLE: readonly ContractStatus[] = [
  'PENDING_SEND',
  'PENDING_SIGNATURE',
];
const CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다';

export type SendResult = {
  contractId: number;
  status: ContractStatus;
  sentAt: string;
  signDeadlineAt: string;
};

/** 앱으로 받는 직원(가입 · 계정 있음)에게는 다시 보낼 길이 아직 없다 — 앱 알림이 생기면 붙인다(2026-10-19 김민식) */
const channelNotReady = (draftAction: string | null) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'SEND_CHANNEL_NOT_READY',
    message:
      '가입한 직원 · 계정이 있는 번호는 앱 알림으로 받습니다. 앱 알림이 준비되면 다시 보낼 수 있습니다',
    draftAction,
  });

/**
 * 근로계약 재발송(WHALEERP-136). 보내기는 저장할 때 곧바로 한다(2026-10-19 재영 정정 — ContractDeliveryService). 따로
 * 부르는 것은 재발송 하나다 — 발송 대기(초대를 받지 못함) · 서명 대기에서 새 링크 · 새 서명 기한(30일)으로 가입 초대를
 * 다시 보낸다. 상태는 그대로이고 앞서 나간 링크는 무효다. 앱으로 받는 직원은 409 SEND_CHANNEL_NOT_READY.
 */
@Injectable()
export class ContractSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly delivery: ContractDeliveryService,
  ) {}

  async send(
    adminAccountId: number,
    contractId: number,
    now = new Date(),
  ): Promise<SendResult> {
    const scoped = await this.contracts.scopedContractOf(
      adminAccountId,
      contractId,
    );
    const { pending, status } = await this.prisma.$transaction(async (tx) => {
      await lockPeople(tx, [scoped.phone]);
      await lockContract(tx, contractId);
      const c = await tx.contract.findUnique({
        where: { contractId },
        select: {
          status: true,
          storeId: true,
          sentAt: true,
          signDeadlineAt: true,
          draftAction: true,
          staffMemberId: true,
          staffMember: {
            select: { phone: true, joinStatus: true, candidateAccountId: true },
          },
        },
      });
      if (!c) throw new NotFoundException(CONTRACT_NOT_FOUND);
      if (c.storeId !== scoped.storeId || c.staffMember.phone !== scoped.phone)
        throw new ConflictException(
          '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
        );
      if (!c.status || !RESENDABLE.includes(c.status))
        throw statusConflict(c.status ?? 'PENDING_SEND');
      // 가입한 직원은 판별할 것 없이 앱 알림이다(자기 레코드가 재직이라 판별은 「이미 재직 중」이 된다)
      if (c.staffMember.joinStatus === 'JOINED')
        throw channelNotReady(c.draftAction);
      // 보낸 뒤 그 번호로 계정이 생겼을 수 있어 다시 판별한다
      const invite = await decideInvitation(tx, c.storeId, c.staffMember.phone);
      if (invite.draftAction !== 'SIGNUP_INVITE')
        throw channelNotReady(invite.draftAction);

      const pending = await this.delivery.prepare(
        tx,
        {
          contractId,
          storeId: c.storeId,
          phone: c.staffMember.phone,
          joined: false,
          draftAction: invite.draftAction,
          before: {
            status: c.status,
            sentAt: c.sentAt,
            signDeadlineAt: c.signDeadlineAt,
            draftAction: c.draftAction,
            staffMemberId: c.staffMemberId,
            staffMember: c.staffMember,
          },
          statusChanged: false,
          phoneChanged: false,
          replacedContracts: false,
        },
        now,
      );
      return { pending, status: c.status };
    });
    await this.delivery.dispatch(pending, adminAccountId);
    return {
      contractId,
      status,
      sentAt: now.toISOString(),
      signDeadlineAt: new Date(now.getTime() + SEND_VALID_MS).toISOString(),
    };
  }
}
