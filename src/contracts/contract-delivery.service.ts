import { createHash, randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
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
import { lockContract } from './contract-status';

/** 가입 초대 알림톡 템플릿(근무지 · 링크). 카카오 템플릿 WHALE_INVITE_01 */
export const INVITATION_TEMPLATE = 'TALK_STAFF_INVITATION';
/** 초대 링크 · 서명 기한 — 보낸 날로부터 30일(WHALEERP-136, 물리 ERD sign_deadline_at) */
export const SEND_VALID_MS = 30 * 24 * 60 * 60 * 1000;
/** 직원 앱의 초대 링크 경로. 토큰은 경로 끝에 붙인다(2026-10-16 김민식) */
export const INVITE_PATH = '/invite/';

/** 링크에 싣는 토큰과 DB 에 두는 값. DB 에는 해시만 둔다 — 행이 새어도 링크를 만들 수 없게 */
export function newInvitationToken(): { token: string; stored: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, stored: hashInvitationToken(token) };
}
export const hashInvitationToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

type DraftAction = Prisma.ContractUpdateManyMutationInput['draftAction'];

/**
 * 근로계약을 받을 길. 가입하지 않았고 그 번호로 계정도 없으면 가입 초대 알림톡(INVITE)이고, 가입한 직원 · 계정이 있는
 * 번호면 앱 알림(APP)이다. 앱 알림은 아직 없어 상태 · 기한만 잡고 알림은 보내지 않는다 — 앱 알림이 생기면 붙인다
 * (2026-10-19 김민식).
 */
export const channelOf = (joined: boolean, draftAction: DraftAction) =>
  !joined && draftAction === 'SIGNUP_INVITE' ? 'INVITE' : 'APP';

/**
 * 보낸 뒤의 상태(2026-10-19 재영 정정). 가입 초대는 발송 대기(초대는 나갔고 가입을 기다림), 앱으로 받는 직원은 곧바로
 * 서명 대기다.
 */
export const deliveredStatusOf = (
  joined: boolean,
  draftAction: DraftAction,
): ContractStatus =>
  channelOf(joined, draftAction) === 'INVITE'
    ? 'PENDING_SEND'
    : 'PENDING_SIGNATURE';

/** 보내기 직전의 계약 · 직원 값. 알림톡이 확실히 나가지 않았을 때 이 값으로 되돌린다. */
export type DeliveryBefore = {
  /** 새로 만든 계약이면 null */
  status: ContractStatus | null;
  sentAt: Date | null;
  signDeadlineAt: Date | null;
  draftAction: DraftAction;
  staffMemberId: number;
  staffMember: { joinStatus: string; candidateAccountId: number | null };
};

export type DeliveryInput = {
  contractId: number;
  storeId: number;
  phone: string;
  joined: boolean;
  draftAction: DraftAction;
  before: DeliveryBefore;
  /** 이 저장이 상태를 바꿔 이력을 한 줄 썼는가(되돌릴 때 그 줄을 지운다) */
  statusChanged: boolean;
  /** 번호가 바뀌었는가 — 옛 번호로 나간 초대는 되살리지 않는다 */
  phoneChanged: boolean;
};

/** 커밋 뒤 보낼 가입 초대. 앱 알림(APP)은 보낼 것이 없어 null 이다. */
export type PendingInvite = DeliveryInput & {
  token: string;
  invitationId: number;
  historyId: number | null;
  expired: number[];
  storeName: string;
  now: Date;
};

/** 알림톡이 확실히 나가지 않은 실패인가 — 비즈뿌리오 오류가 아니면 요청 전 검사, 코드가 있으면 거절, 토큰 단계면 보내지 않음 */
function notSent(e: unknown): boolean {
  if (!(e instanceof BizppurioError)) return true;
  return e.code !== undefined || e.path === '/v1/token';
}

/**
 * 근로계약 보내기(WHALEERP-136, 2026-10-19 재영 정정 — 저장하면 곧바로 보낸다). 초안 저장 · 수정 요청 계약 고침 · 날인
 * 전 당사자 정보 수정 · 재발송이 모두 같은 길로 보낸다.
 *
 * - `prepare` 는 저장 트랜잭션 안에서 쓴다 — 서명 기한(30일) · 발송 일시를 잡고, 앞서 나간 초대는 모두 무효(EXPIRED)로
 *   한다(번호를 고치거나 다시 보내면 옛 링크는 쓸 수 없다). 가입 초대면 새 초대(링크 토큰은 해시로만)를 만들고 직원을
 *   초대 발송으로 둔다. 상태는 호출부가 `deliveredStatusOf` 로 정해 바꾼다.
 * - `dispatch` 는 커밋 뒤에 가입 초대 알림톡을 보낸다 — 알림톡은 롤백이 없어서다(공통 모듈 규칙). 확실히 나가지
 *   않았으면 보내기 직전으로 되돌려 502 SEND_FAILED, 메시지 요청 뒤 응답이 끊겼으면 되돌리지 않고 502 SEND_UNCONFIRMED.
 *
 * 알림톡 버튼(초대 링크 버튼)은 공통 모듈이 아직 보내지 않아 링크는 대체 문자로만 간다 — 대체 문자 발신번호가 없으면 쓰기
 * 전에 막는다.
 */
@Injectable()
export class ContractDeliveryService {
  private readonly logger = new Logger(ContractDeliveryService.name);
  private readonly appUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alimtalk: AlimtalkService,
    config: ConfigService,
  ) {
    this.appUrl = readStaffAppUrl(
      config.get<string>('STAFF_APP_URL'),
      isProduction(),
    );
  }

  /**
   * 가입 초대를 보낼 수 있는가 — 직원 앱 주소 · 대체 문자 발신번호(503), 휴대폰 번호(409 SEND_PHONE_NOT_MOBILE), 켜진
   * 템플릿(503). 저장 트랜잭션 안에서 부른다 — 던지면 저장째 되돌아가 「보내지 않았는데 보낸 상태」가 남지 않는다.
   */
  private async assertCanInvite(
    tx: Prisma.TransactionClient,
    phone: string,
  ): Promise<void> {
    if (!this.appUrl)
      throw new ServiceUnavailableException(
        '직원 앱 주소(STAFF_APP_URL)가 없어 초대 링크를 보낼 수 없습니다',
      );
    // 링크는 알림톡 버튼 변수에만 있는데 버튼을 아직 보내지 않는다 — 대체 문자가 없으면 링크가 닿을 길이 없다(api #59 리뷰).
    if (!this.alimtalk.hasSmsFallback())
      throw new ServiceUnavailableException(
        '대체 문자 발신번호(BIZPPURIO_SMS_FROM)가 없어 초대 링크를 보낼 수 없습니다',
      );
    // 유선번호는 계약서에는 저장되지만 알림톡이 받지 않는다
    if (!isMobilePhone(phone))
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'SEND_PHONE_NOT_MOBILE',
        message:
          '휴대폰 번호가 아니라 가입 초대 알림톡을 보낼 수 없습니다. 휴대전화번호를 고쳐 주세요',
      });
    await findSendableTemplate(tx, INVITATION_TEMPLATE, 'ALIMTALK').catch(
      (e: unknown) => {
        this.logger.error(`가입 초대 템플릿을 쓸 수 없음: ${String(e)}`);
        throw new ServiceUnavailableException(
          '가입 초대 알림톡 템플릿이 없거나 꺼져 있어 보낼 수 없습니다',
        );
      },
    );
  }

  /**
   * 저장 트랜잭션 안에서 보낼 준비를 한다(계약 행을 잠근 뒤 · 상태를 바꾼 뒤에 부른다). 가입 초대면 커밋 뒤 보낼 것을
   * 돌려주고, 앱 알림이면 null 이다.
   */
  async prepare(
    tx: Prisma.TransactionClient,
    input: DeliveryInput,
    now: Date,
  ): Promise<PendingInvite | null> {
    const invite = channelOf(input.joined, input.draftAction) === 'INVITE';
    if (invite) await this.assertCanInvite(tx, input.phone);
    const { staffMemberId } = input.before;
    const deadline = new Date(now.getTime() + SEND_VALID_MS);

    // 앞서 나간 초대는 모두 무효 — 링크는 마지막 것 하나만 쓴다(번호를 고치면 옛 번호로 나간 초대도 무효, 2026-10-19 재영)
    const previous = await tx.invitation.findMany({
      where: { staffMemberId, status: 'SENT' },
      select: { invitationId: true },
    });
    if (previous.length)
      await tx.invitation.updateMany({
        where: { invitationId: { in: previous.map((p) => p.invitationId) } },
        data: { status: 'EXPIRED' },
      });
    await tx.contract.update({
      where: { contractId: input.contractId },
      data: {
        sentAt: now,
        signDeadlineAt: deadline,
        draftAction: input.draftAction,
      },
    });
    if (!invite) return null;

    const hadAny = await tx.invitation.count({ where: { staffMemberId } });
    const { token, stored } = newInvitationToken();
    const invitation = await tx.invitation.create({
      data: {
        staffMemberId,
        invitationType: hadAny ? 'REINVITE' : 'SIGNUP',
        invitationToken: stored,
        channel: 'ALIMTALK',
        sentAt: now,
        expiresAt: deadline,
        status: 'SENT',
      },
      select: { invitationId: true },
    });
    if (input.before.staffMember.joinStatus === 'DRAFT')
      await tx.staffMember.update({
        where: { staffMemberId },
        data: { joinStatus: 'INVITED', candidateAccountId: null },
      });
    // 되돌릴 때 이 저장이 쓴 상태 이력 한 줄을 지운다 — 일어나지 않은 발송이 이력에 남지 않게
    const historyId = input.statusChanged
      ? ((
          await tx.contractStatusHistory.findFirst({
            where: { contractId: input.contractId },
            orderBy: { contractStatusHistoryId: 'desc' },
            select: { contractStatusHistoryId: true },
          })
        )?.contractStatusHistoryId ?? null)
      : null;
    const store = await tx.store.findUnique({
      where: { storeId: input.storeId },
      select: { name: true },
    });
    return {
      ...input,
      token,
      invitationId: invitation.invitationId,
      historyId,
      expired: previous.map((p) => p.invitationId),
      storeName: store?.name ?? '',
      now,
    };
  }

  /**
   * 커밋 뒤 가입 초대 알림톡을 보낸다(없으면 아무것도 하지 않는다). 실패하면 502 — 본문에 계약 ID 와 되돌린 뒤의 상태를
   * 싣는다(저장은 이미 끝나 화면이 그 계약으로 가야 한다).
   */
  async dispatch(pending: PendingInvite | null, sentBy: number): Promise<void> {
    if (!pending) return;
    const { contractId } = pending;
    try {
      await this.alimtalk.send({
        templateCode: INVITATION_TEMPLATE,
        to: pending.phone,
        variables: {
          근무지: pending.storeName,
          링크: this.linkOf(pending.token),
        },
        maskedVariables: ['링크'],
        related: { type: 'contract', id: contractId },
        sentBy,
      });
    } catch (e) {
      if (notSent(e)) {
        if (!(e instanceof BizppurioError))
          this.logger.error(
            `알림톡을 보내기 전에 실패 contract=${contractId}`,
            e instanceof Error ? e.stack : String(e),
          );
        // 되돌리기가 실패하면 DB 는 「보낸 상태」라 접수 여부 모름과 같게 답한다(화면이 상세를 다시 읽게)
        const status = await this.undo(pending).catch((u: unknown) => {
          this.logger.error(
            `발송 실패 뒤 되돌리기 실패 contract=${contractId}`,
            u instanceof Error ? u.stack : String(u),
          );
          return null;
        });
        if (status === null)
          throw new BadGatewayException({
            statusCode: HttpStatus.BAD_GATEWAY,
            error: 'Bad Gateway',
            code: 'SEND_UNCONFIRMED',
            retryable: false,
            contractId,
            message:
              '가입 초대 알림톡을 보내지 못했는데 되돌리지 못했습니다. 상세를 다시 열어 상태를 확인한 뒤 재발송해 주세요',
          });
        throw new BadGatewayException({
          statusCode: HttpStatus.BAD_GATEWAY,
          error: 'Bad Gateway',
          code: 'SEND_FAILED',
          retryable: true,
          contractId,
          status,
          message: `${
            e instanceof BizppurioError && e.code !== undefined
              ? `가입 초대 알림톡을 보내지 못했습니다(비즈뿌리오 ${e.code}). 번호를 확인하고`
              : '가입 초대 알림톡을 보내지 못했습니다. 잠시 뒤'
          } 다시 보내 주세요${status === 'DRAFT' && pending.before.status !== 'DRAFT' ? ' — 근로계약서는 임시저장으로 두었습니다' : ''}`,
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
        contractId,
        message:
          '가입 초대 알림톡이 접수됐는지 알 수 없습니다. 직원에게 받았는지 확인한 뒤 다시 보내 주세요 — 다시 보내면 두 번 갈 수 있습니다',
      });
    }
  }

  /** 링크 — 직원 앱 주소의 origin 에 고정 경로와 토큰 */
  private linkOf(token: string): string {
    return `${new URL(this.appUrl as string).origin}${INVITE_PATH}${token}`;
  }

  /**
   * 나가지 않은 가입 초대를 되돌리고 되돌린 뒤의 상태를 돌려준다. 새 초대와 이 저장의 상태 이력을 지우고, 번호가 그대로면
   * 무효로 했던 앞 초대를 되살리고, 계약 · 직원을 보내기 직전으로 돌린다. 고친 내용(이름 · 번호 · 계약 칸)은 그대로다.
   * - 돌아갈 상태에 살아 있는 받을 길이 없으면(새 계약 · 임시저장에서 넘김 · 번호를 바꿈 · 앞 초대가 없음) 임시저장으로 둔다
   *   — 발송 대기 · 서명 대기는 「초대가 나갔다」는 뜻이라, 나간 것이 없으면 남기지 않는다(api #59 재리뷰 A).
   * - 그사이 다른 요청이 다시 보냈거나 계약을 바꿨으면(내 초대가 이미 「보냄」이 아니거나 발송 일시가 이 요청의 것이
   *   아님) 나가지 않은 내 초대만 지우고 나머지는 그 요청에 맡긴다.
   */
  private async undo(p: PendingInvite): Promise<ContractStatus | null> {
    return this.prisma.$transaction(async (tx) => {
      const { contractId, before } = p;
      await lockContract(tx, contractId);
      const mine = await tx.invitation.findUnique({
        where: { invitationId: p.invitationId },
        select: { status: true },
      });
      const c = await tx.contract.findUnique({
        where: { contractId },
        select: { status: true, sentAt: true },
      });
      if (mine)
        await tx.invitation.delete({ where: { invitationId: p.invitationId } });
      if (mine?.status !== 'SENT' || c?.sentAt?.getTime() !== p.now.getTime()) {
        this.logger.warn(
          `발송 되돌리기: 계약 ${contractId} 를 그사이 다른 요청이 바꿔 초대만 지웠다`,
        );
        return c?.status ?? null;
      }
      if (!p.phoneChanged && p.expired.length)
        await tx.invitation.updateMany({
          where: { invitationId: { in: p.expired }, status: 'EXPIRED' },
          data: { status: 'SENT' },
        });
      const live = await this.hasLiveInvitation(tx, before.staffMemberId);
      const restored = restoredStatusOf(p, live);
      await tx.contract.update({
        where: { contractId },
        data: {
          status: restored,
          sentAt: restored === 'DRAFT' ? null : before.sentAt,
          signDeadlineAt: restored === 'DRAFT' ? null : before.signDeadlineAt,
          draftAction: before.draftAction,
        },
      });
      if (p.historyId !== null) {
        // 새 계약은 처음 이력 한 줄(→ 발송 대기)이 이 저장의 것이라 임시저장으로 고쳐 둔다. 나머지는 지운다.
        if (before.status === null)
          await tx.contractStatusHistory.update({
            where: { contractStatusHistoryId: p.historyId },
            data: { toStatus: 'DRAFT' },
          });
        else
          await tx.contractStatusHistory.delete({
            where: { contractStatusHistoryId: p.historyId },
          });
      }
      // 보내기 전과 다른 상태로 돌아갔다(보낸 상태였는데 받을 길이 없어 임시저장) — 그 일을 이력에 남긴다
      if (before.status !== null && restored !== before.status)
        await tx.contractStatusHistory.create({
          data: {
            contractId,
            fromStatus: before.status,
            toStatus: restored,
            actor: 'SYSTEM',
          },
        });
      if (before.staffMember.joinStatus === 'DRAFT' || !live)
        await tx.staffMember.updateMany({
          where: { staffMemberId: before.staffMemberId, joinStatus: 'INVITED' },
          data: {
            joinStatus: 'DRAFT',
            candidateAccountId: before.staffMember.candidateAccountId,
          },
        });
      return restored;
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
 * 되돌린 뒤의 상태. 임시저장 · 새 계약이면 임시저장, 수정 요청이면 수정 요청(받을 길이 없어도 되는 상태)이다. 발송 대기 ·
 * 서명 대기였으면 번호가 그대로이고 받을 길(살아 있는 초대, 또는 앱으로 받는 직원)이 남아 있을 때만 그 상태로 돌아가고,
 * 아니면 임시저장이다.
 */
export function restoredStatusOf(
  p: Pick<PendingInvite, 'before' | 'phoneChanged' | 'joined'>,
  liveInvitation: boolean,
): ContractStatus {
  const { status, draftAction } = p.before;
  if (status === null || status === 'DRAFT') return 'DRAFT';
  if (status === 'CORRECTION_REQUESTED') return status;
  const reachable =
    liveInvitation ||
    (status === 'PENDING_SIGNATURE' &&
      channelOf(p.joined, draftAction) === 'APP');
  return !p.phoneChanged && reachable ? status : 'DRAFT';
}
