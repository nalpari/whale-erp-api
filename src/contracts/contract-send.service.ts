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
  deliveredStatusOf,
} from './contract-delivery.service';
import {
  RESENDABLE_STATUSES,
  lockContractWithStaff,
  statusConflict,
  transition,
} from './contract-status';
import {
  ContractsService,
  decideInvitation,
  lockPeople,
} from './contracts.service';

const CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다';

export type EndResult = { contractId: number; status: 'ENDED' };

export type SendResult = {
  contractId: number;
  status: ContractStatus;
  sentAt: string;
  signDeadlineAt: string;
};

/**
 * 계정은 있고 이 점포에 가입하지 않은 번호(소속 추가 확인 · 복귀 확인)는 다시 보낼 길이 없다 — 직원 앱이 후보 계정에
 * 계약을 보이지 않고(my-contract-scope) 소속 확인 화면도 아직 없어, 보내도 받을 수 없다. 소속 확인이 앱에 생기면 붙인다
 * (WHALEERP-611, 2026-10-23). 가입한 직원은 앱 알림으로 보낸다(아래 send).
 */
const channelNotReady = (draftAction: string | null) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'SEND_CHANNEL_NOT_READY',
    message:
      '계정이 있는 번호는 직원 앱에서 소속을 확인한 뒤 근로계약서를 받습니다. 소속 확인이 아직 직원 앱에 없어 다시 보낼 수 없습니다',
    draftAction,
  });

/**
 * 근로계약 재발송(WHALEERP-136). 보내기는 저장할 때 곧바로 한다(2026-10-19 재영 정정 — ContractDeliveryService). 따로
 * 부르는 것은 재발송 하나다 — 발송 대기 · 서명 대기에서 새 서명 기한(30일)으로 다시 보낸다. 앞서 나간 초대 코드는 무효다.
 * - 가입하지 않았고 그 번호로 계정도 없으면 새 초대 코드로 가입 초대 알림톡을 보낸다. 상태는 그대로다.
 * - 가입한 직원이면 첫 발송과 같은 앱 알림(근로계약서 발송 알림, #259)이다(WHALEERP-611) — 알림함 알림이고 앱 푸시는 #261
 *   전까지 나가지 않는다. 알림 템플릿을 쓸 수 없거나 탈퇴 계정이면 알림 없이 기한만 새로 잡고 200 이다(첫 발송과 같다).
 *   발송 대기였으면(가입하면 서명 대기로 넘어가 보통은 없다) 앱이 발송 대기 계약을 보이지 않아 서명 대기로 넘긴다 — 근로자
 *   정보 수정과 같은 규칙이다. 알림톡이 없어 502 · 503 은 나지 않는다.
 * - 계정은 있고 이 점포에 가입하지 않은 번호(소속 추가 확인 · 복귀 확인)는 409 SEND_CHANNEL_NOT_READY. 그 계정이 이 점포에
 *   재직 중이면 판별이 409 「이 점포에 이미 재직 중인 직원입니다」(코드 없음)다.
 * 목록의 「다시 보낼 수 있는가」(staff-member-list invitation.canResend)가 이 판정을 따른다 — 바꾸면 함께 고친다.
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
      // 직원 행 → 계약 행 — 보내기(prepare)가 직원 행(가입 상태)을 쓴다(api #104)
      await lockContractWithStaff(tx, contractId);
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
      if (!c.status || !RESENDABLE_STATUSES.includes(c.status))
        throw statusConflict(c.status ?? 'PENDING_SEND');
      // 가입한 직원은 판별할 것 없이 앱 알림이다(자기 레코드가 재직이라 판별은 「이미 재직 중」이 된다). 초대 유형은 보낸
      // 때의 값 그대로 둔다 — 수정 요청 계약 고침 · 근로자 정보 수정과 같다
      const joined = c.staffMember.joinStatus === 'JOINED';
      let draftAction = c.draftAction;
      if (!joined) {
        // 보낸 뒤 그 번호로 계정이 생겼을 수 있어 다시 판별한다
        const invite = await decideInvitation(
          tx,
          c.storeId,
          c.staffMember.phone,
        );
        if (invite.draftAction !== 'SIGNUP_INVITE')
          throw channelNotReady(invite.draftAction);
        draftAction = invite.draftAction;
      }
      const status = joined ? deliveredStatusOf(true, draftAction) : c.status;
      if (status !== c.status)
        await transition(tx, contractId, status, 'ADMIN', {
          from: [c.status],
        });

      const pending = await this.delivery.prepare(
        tx,
        {
          contractId,
          storeId: c.storeId,
          phone: c.staffMember.phone,
          joined,
          draftAction,
          before: {
            status: c.status,
            sentAt: c.sentAt,
            signDeadlineAt: c.signDeadlineAt,
            draftAction: c.draftAction,
            staffMemberId: c.staffMemberId,
            staffMember: c.staffMember,
          },
          statusChanged: status !== c.status,
          phoneChanged: false,
          replacedContracts: false,
        },
        now,
      );
      return { pending, status };
    });
    await this.delivery.dispatch(pending, adminAccountId);
    return {
      contractId,
      status,
      sentAt: now.toISOString(),
      signDeadlineAt: new Date(now.getTime() + SEND_VALID_MS).toISOString(),
    };
  }

  /**
   * 발송 대기 계약 종료(WHALEERP-327 · 155, 2026-10-21 재영 A안 · 운영 정책 CTR-19). 채용을 접을 때 관리자가 닫는다 — 상태를
   * 종료로 바꾸고 이력(관리자)을 남기며, 그 직원 레코드에 나간 초대(코드 · 링크)를 무효로 한다. 행은 지우지 않는다. 남은 가입 전
   * 직원 레코드는 퇴직 처리로 정리한다(CTR-25). 발송 대기가 아니면 409(지금 상태를 싣는다). 잠금 순서는 재발송과 같다.
   */
  async end(adminAccountId: number, contractId: number): Promise<EndResult> {
    const scoped = await this.contracts.scopedContractOf(
      adminAccountId,
      contractId,
    );
    await this.prisma.$transaction(async (tx) => {
      await lockPeople(tx, [scoped.phone]);
      await lockContractWithStaff(tx, contractId);
      const c = await tx.contract.findUnique({
        where: { contractId },
        select: {
          status: true,
          storeId: true,
          staffMemberId: true,
          staffMember: { select: { phone: true } },
        },
      });
      if (!c) throw new NotFoundException(CONTRACT_NOT_FOUND);
      if (c.storeId !== scoped.storeId || c.staffMember.phone !== scoped.phone)
        throw new ConflictException(
          '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
        );
      if (c.status !== 'PENDING_SEND')
        throw statusConflict(c.status ?? 'PENDING_SEND');
      await transition(tx, contractId, 'ENDED', 'ADMIN', {
        from: ['PENDING_SEND'],
      });
      // 나간 초대 코드 · 링크를 막는다 — 가입하면 이 계약을 이어 서명 대기로 넘기는 길이 남지 않게
      await tx.invitation.updateMany({
        where: { staffMemberId: c.staffMemberId, status: 'SENT' },
        data: { status: 'EXPIRED' },
      });
    });
    return { contractId, status: 'ENDED' };
  }
}
