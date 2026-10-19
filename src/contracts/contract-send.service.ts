import { createHash, randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContractStatus, Prisma } from '@prisma/client';
import { AlimtalkService, isMobilePhone } from '../alimtalk/alimtalk.service';
import { BizppurioError } from '../alimtalk/bizppurio.client';
import { readStaffAppUrl } from '../auth/staff-app-url';
import { isProduction } from '../config/profile';
import { findSendableTemplate } from '../notification-templates/find-template';
import { PrismaService } from '../prisma/prisma.service';
import { lockContract, statusConflict, transition } from './contract-status';
import {
  ContractsService,
  decideInvitation,
  lockPeople,
} from './contracts.service';

/** 가입 초대 알림톡 템플릿(근무지 · 링크). 카카오 템플릿 WHALE_INVITE_01 */
export const INVITATION_TEMPLATE = 'TALK_STAFF_INVITATION';
/** 초대 링크 · 서명 기한 — 발송일로부터 30일(WHALEERP-136, 물리 ERD sign_deadline_at) */
export const SEND_VALID_MS = 30 * 24 * 60 * 60 * 1000;
/** 직원 앱의 초대 링크 경로. 토큰은 경로 끝에 붙인다(2026-10-16 김민식) */
export const INVITE_PATH = '/invite/';

const SENDABLE: readonly ContractStatus[] = [
  'PENDING_SEND',
  'PENDING_SIGNATURE',
];
const CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다';

/** 링크에 싣는 토큰과 DB 에 두는 값. DB 에는 해시만 둔다 — 행이 새어도 링크를 만들 수 없게 */
export function newInvitationToken(): { token: string; stored: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, stored: hashInvitationToken(token) };
}
export const hashInvitationToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export type SendResult = {
  contractId: number;
  status: ContractStatus;
  sentAt: string;
  signDeadlineAt: string;
};

/**
 * 근로계약 발송 · 재발송(WHALEERP-136, 2026-10-16). 이번에는 **가입 초대만**이다 — 계정이 없는 직원에게 가입 초대
 * 알림톡(초대 링크)을 보내고 계약을 서명 대기로 둔다. 기존 계정(소속 추가 확인 · 복귀 확인)은 앱 푸시로 보내야 하는데
 * 앱 푸시가 아직 없어 409 SEND_CHANNEL_NOT_READY 로 막는다.
 *
 * 쓰기(초대 행 · 상태 · 기한)를 먼저 커밋하고 그 뒤에 알림톡을 보낸다 — 알림톡은 롤백이 없어서다(공통 모듈 규칙).
 * 확실히 나가지 않았으면(비즈뿌리오 거절 · 토큰 단계 실패 · 요청 전 오류, `notSent`) 방금 쓴 것을 되돌려 「보내지 않은
 * 것」으로 두고 502 SEND_FAILED(다시 보낼 수 있음). 메시지 요청 뒤 응답이 끊겨 접수 여부를 모르면 되돌리지 않고 502
 * SEND_UNCONFIRMED — 다시 누르면 두 번 갈 수 있다.
 *
 * 알림톡 버튼(초대 링크 버튼)은 공통 모듈이 아직 보내지 않는다 — 카카오 승인 버튼 이름을 정한 뒤 붙인다.
 */
@Injectable()
export class ContractSendService {
  private readonly logger = new Logger(ContractSendService.name);
  private readonly appUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly alimtalk: AlimtalkService,
    config: ConfigService,
  ) {
    this.appUrl = readStaffAppUrl(
      config.get<string>('STAFF_APP_URL'),
      isProduction(),
    );
  }

  async send(
    adminAccountId: number,
    contractId: number,
    now = new Date(),
  ): Promise<SendResult> {
    const scoped = await this.contracts.scopedContractOf(
      adminAccountId,
      contractId,
    );
    if (!this.appUrl)
      throw new ServiceUnavailableException(
        '직원 앱 주소(STAFF_APP_URL)가 없어 초대 링크를 보낼 수 없습니다',
      );
    // 링크는 알림톡 버튼 변수에만 있는데 버튼을 아직 보내지 않는다 — 대체 문자가 없으면 링크가 닿을 길이 없다(api #59 리뷰).
    // 버튼 발송이 생기면 푼다.
    if (!this.alimtalk.hasSmsFallback())
      throw new ServiceUnavailableException(
        '대체 문자 발신번호(BIZPPURIO_SMS_FROM)가 없어 초대 링크를 보낼 수 없습니다',
      );
    // 유선번호는 계약서에는 저장되지만 알림톡이 받지 않는다 — 쓰기 전에 막아야 「보내지 않았는데 보낸 상태」가 남지 않는다
    if (!isMobilePhone(scoped.phone))
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'SEND_PHONE_NOT_MOBILE',
        message:
          '휴대폰 번호가 아니라 알림톡을 보낼 수 없습니다. 근로자 정보 수정에서 번호를 고쳐 주세요',
      });
    // 템플릿이 없거나 꺼져 있으면 쓰기 전에 막는다 — 커밋한 뒤에 알면 되돌려야 한다
    await findSendableTemplate(
      this.prisma,
      INVITATION_TEMPLATE,
      'ALIMTALK',
    ).catch((e: unknown) => {
      this.logger.error(`가입 초대 템플릿을 쓸 수 없음: ${String(e)}`);
      throw new ServiceUnavailableException(
        '가입 초대 알림톡 템플릿이 없거나 꺼져 있어 보낼 수 없습니다',
      );
    });

    const { token, stored } = newInvitationToken();
    const deadline = new Date(now.getTime() + SEND_VALID_MS);
    const written = await this.prisma.$transaction(async (tx) => {
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
      if (!c.status || !SENDABLE.includes(c.status))
        throw statusConflict(c.status ?? 'PENDING_SEND');

      // 저장한 뒤 그 번호로 계정이 생겼을 수 있어 보낼 때 다시 판별한다
      const invite = await decideInvitation(tx, c.storeId, c.staffMember.phone);
      if (invite.draftAction !== 'SIGNUP_INVITE')
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: 'SEND_CHANNEL_NOT_READY',
          message:
            '이미 가입한 직원이라 앱 알림(소속 추가 · 복귀 확인)으로 보냅니다. 앱 알림이 준비되면 보낼 수 있습니다',
          draftAction: invite.draftAction,
        });

      // 이 레코드의 아직 살아 있는 초대는 새 초대로 바꾼다 — 링크는 마지막 것 하나만 쓴다
      const previous = await tx.invitation.findMany({
        where: { staffMemberId: c.staffMemberId, status: 'SENT' },
        select: { invitationId: true },
      });
      const hadAny = await tx.invitation.count({
        where: { staffMemberId: c.staffMemberId },
      });
      if (previous.length)
        await tx.invitation.updateMany({
          where: { invitationId: { in: previous.map((p) => p.invitationId) } },
          data: { status: 'EXPIRED' },
        });
      const invitation = await tx.invitation.create({
        data: {
          staffMemberId: c.staffMemberId,
          invitationType: hadAny ? 'REINVITE' : 'SIGNUP',
          invitationToken: stored,
          channel: 'ALIMTALK',
          sentAt: now,
          expiresAt: deadline,
          status: 'SENT',
        },
        select: { invitationId: true },
      });

      const data = {
        sentAt: now,
        signDeadlineAt: deadline,
        draftAction: invite.draftAction,
      };
      let historyId: number | null = null;
      if (c.status === 'PENDING_SEND') {
        await transition(tx, contractId, 'PENDING_SIGNATURE', 'ADMIN', {
          from: ['PENDING_SEND'],
          data,
        });
        // 되돌릴 때 이 이력을 지운다 — 일어나지 않은 발송이 이력에 남지 않게
        historyId =
          (
            await tx.contractStatusHistory.findFirst({
              where: { contractId, toStatus: 'PENDING_SIGNATURE' },
              orderBy: { contractStatusHistoryId: 'desc' },
              select: { contractStatusHistoryId: true },
            })
          )?.contractStatusHistoryId ?? null;
      } else {
        // 재발송 — 서명 대기 그대로, 새 링크 · 새 기한
        const { count } = await tx.contract.updateMany({
          where: { contractId, status: 'PENDING_SIGNATURE' },
          data,
        });
        if (count === 0) throw statusConflict(c.status);
      }
      if (c.staffMember.joinStatus === 'DRAFT')
        await tx.staffMember.update({
          where: { staffMemberId: c.staffMemberId },
          data: { joinStatus: 'INVITED', candidateAccountId: null },
        });

      return {
        before: c,
        invitationId: invitation.invitationId,
        historyId,
        expired: previous.map((p) => p.invitationId),
        phone: c.staffMember.phone,
        storeName:
          (
            await tx.store.findUnique({
              where: { storeId: c.storeId },
              select: { name: true },
            })
          )?.name ?? '',
      };
    });

    try {
      await this.alimtalk.send({
        templateCode: INVITATION_TEMPLATE,
        to: written.phone,
        variables: { 근무지: written.storeName, 링크: this.linkOf(token) },
        maskedVariables: ['링크'],
        related: { type: 'contract', id: contractId },
        sentBy: adminAccountId,
      });
    } catch (e) {
      if (notSent(e)) {
        // 확실히 나가지 않았다 — 되돌려 다시 보낼 수 있게 한다. 되돌리기가 실패하면 DB 는 「보낸 상태」라 접수 여부
        // 모름과 같게 답한다(화면이 상세를 다시 읽게)
        if (!(e instanceof BizppurioError))
          this.logger.error(
            `알림톡을 보내기 전에 실패 contract=${contractId}`,
            e instanceof Error ? e.stack : String(e),
          );
        const undone = await this.undo(contractId, written, now).then(
          () => true,
          (u: unknown) => {
            this.logger.error(
              `발송 실패 뒤 되돌리기 실패 contract=${contractId}`,
              u instanceof Error ? u.stack : String(u),
            );
            return false;
          },
        );
        if (!undone)
          throw new BadGatewayException({
            statusCode: HttpStatus.BAD_GATEWAY,
            error: 'Bad Gateway',
            code: 'SEND_UNCONFIRMED',
            retryable: false,
            message:
              '알림톡을 보내지 못했는데 되돌리지 못했습니다. 상세를 다시 열어 상태를 확인한 뒤 재발송해 주세요',
          });
        throw new BadGatewayException({
          statusCode: HttpStatus.BAD_GATEWAY,
          error: 'Bad Gateway',
          code: 'SEND_FAILED',
          retryable: true,
          message:
            e instanceof BizppurioError && e.code !== undefined
              ? `알림톡을 보내지 못했습니다(비즈뿌리오 ${e.code}). 번호를 확인하고 다시 보내 주세요`
              : '알림톡을 보내지 못했습니다. 잠시 뒤 다시 보내 주세요',
        });
      }
      this.logger.error(
        `알림톡 접수 여부를 알 수 없음 contract=${contractId}`,
        e instanceof Error ? e.stack : String(e),
      );
      throw new BadGatewayException({
        statusCode: HttpStatus.BAD_GATEWAY,
        error: 'Bad Gateway',
        code: 'SEND_UNCONFIRMED',
        retryable: false,
        message:
          '알림톡이 접수됐는지 알 수 없습니다. 직원에게 받았는지 확인한 뒤 다시 보내 주세요 — 다시 보내면 두 번 갈 수 있습니다',
      });
    }

    return {
      contractId,
      status: 'PENDING_SIGNATURE',
      sentAt: now.toISOString(),
      signDeadlineAt: deadline.toISOString(),
    };
  }

  /** 링크 — 직원 앱 주소의 origin 에 고정 경로와 토큰 */
  private linkOf(token: string): string {
    return `${new URL(this.appUrl as string).origin}${INVITE_PATH}${token}`;
  }

  /**
   * 나가지 않은 발송을 되돌린다 — 새 초대와 그 발송 이력을 지우고, 바꿔 둔 앞 초대를 다시 살리고, 계약을 보내기 전
   * 상태 · 기한으로 돌린다. 그사이 다른 요청이 보냈거나(재발송 · 번호를 고친 뒤 발송) 계약을 바꿨으면 — 내 초대가 이미
   * 「보냄」이 아니거나 계약의 발송 일시가 이 요청의 것이 아니면 — 나가지 않은 내 초대만 지우고 나머지는 그 요청에
   * 맡긴다(api #59 리뷰). 다만 그사이 근로자 정보 수정이 발송 대기로 돌렸으면(발송 일시는 아직 이 요청의 것) 발송 일시와
   * 직원의 초대 발송 상태도 되돌린다 — 이력은 두 요청이 실제로 바꾼 것이라 둔다(api #59 재리뷰 B).
   * 어느 쪽이든 살아 있는 초대(보냄)가 없는 서명 대기 · 초대 발송은 남기지 않는다(api #59 재리뷰 A — 동시 발송 둘이 모두
   * 거절되면 앞 요청의 서명 대기로 돌아가는데, 그 발송도 나가지 않았다).
   */
  private async undo(
    contractId: number,
    w: {
      before: {
        status: ContractStatus | null;
        sentAt: Date | null;
        signDeadlineAt: Date | null;
        draftAction: Prisma.ContractUpdateManyMutationInput['draftAction'];
        staffMemberId: number;
        staffMember: { joinStatus: string; candidateAccountId: number | null };
      };
      invitationId: number;
      historyId: number | null;
      expired: number[];
    },
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockContract(tx, contractId);
      const mine = await tx.invitation.findUnique({
        where: { invitationId: w.invitationId },
        select: { status: true },
      });
      const c = await tx.contract.findUnique({
        where: { contractId },
        select: { status: true, sentAt: true },
      });
      if (mine)
        await tx.invitation.delete({ where: { invitationId: w.invitationId } });
      const mineSentAt = c?.sentAt?.getTime() === now.getTime();
      if (
        mine?.status !== 'SENT' ||
        c?.status !== 'PENDING_SIGNATURE' ||
        !mineSentAt
      ) {
        if (c?.status === 'PENDING_SEND' && mineSentAt) {
          await tx.contract.updateMany({
            where: { contractId, status: 'PENDING_SEND', sentAt: now },
            data: { sentAt: w.before.sentAt },
          });
          await this.restoreJoinStatus(tx, w.before);
        }
        this.logger.warn(
          `발송 되돌리기: 계약 ${contractId} 를 그사이 다른 요청이 바꿔 초대만 지웠다`,
        );
        return;
      }
      if (w.expired.length)
        await tx.invitation.updateMany({
          where: { invitationId: { in: w.expired }, status: 'EXPIRED' },
          data: { status: 'SENT' },
        });
      const fields = {
        sentAt: w.before.sentAt,
        signDeadlineAt: w.before.signDeadlineAt,
        draftAction: w.before.draftAction,
      };
      if (w.before.status === 'PENDING_SEND') {
        await tx.contract.updateMany({
          where: { contractId, status: 'PENDING_SIGNATURE' },
          data: { ...fields, status: 'PENDING_SEND' },
        });
        if (w.historyId !== null)
          await tx.contractStatusHistory.deleteMany({
            where: { contractStatusHistoryId: w.historyId },
          });
      } else if (await this.hasLiveInvitation(tx, w.before.staffMemberId))
        await tx.contract.updateMany({
          where: { contractId, status: 'PENDING_SIGNATURE' },
          data: fields,
        });
      // 앞 발송의 초대가 없다 — 그 발송도 나가지 않아 그 요청이 지웠다. 서명 대기로 남기지 않고 발송 대기로
      else
        await transition(tx, contractId, 'PENDING_SEND', 'SYSTEM', {
          from: ['PENDING_SIGNATURE'],
          data: { sentAt: null, signDeadlineAt: null },
        });
      await this.restoreJoinStatus(tx, w.before);
    });
  }

  /** 보내기 전이 초안이었거나 살아 있는 초대가 하나도 없으면 직원을 초대 발송 → 초안으로 돌린다 */
  private async restoreJoinStatus(
    tx: Prisma.TransactionClient,
    before: {
      staffMemberId: number;
      staffMember: { joinStatus: string; candidateAccountId: number | null };
    },
  ): Promise<void> {
    if (
      before.staffMember.joinStatus !== 'DRAFT' &&
      (await this.hasLiveInvitation(tx, before.staffMemberId))
    )
      return;
    await tx.staffMember.updateMany({
      where: { staffMemberId: before.staffMemberId, joinStatus: 'INVITED' },
      data: {
        joinStatus: 'DRAFT',
        candidateAccountId: before.staffMember.candidateAccountId,
      },
    });
  }

  private async hasLiveInvitation(
    tx: Prisma.TransactionClient,
    staffMemberId: number,
  ): Promise<boolean> {
    return (
      (await tx.invitation.count({
        where: { staffMemberId, status: 'SENT' },
      })) > 0
    );
  }
}

/**
 * 알림톡이 확실히 나가지 않은 실패인가. 비즈뿌리오 오류가 아니면 요청 전(번호 · 템플릿 · 변수 검사)에 났고, 코드가
 * 있으면 비즈뿌리오가 거절했고, 토큰 단계에서 났으면 메시지는 보내지 않았다. 메시지 요청이 나간 뒤 끊긴 것만 모른다.
 */
function notSent(e: unknown): boolean {
  if (!(e instanceof BizppurioError)) return true;
  return e.code !== undefined || e.path === '/v1/token';
}
