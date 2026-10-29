import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SendContractResponseDto } from './dto/send-contract.response.dto';
import {
  ContractDeliveryService,
  SEND_VALID_MS,
  channelOf,
  deliveredStatusOf,
} from './contract-delivery.service';
import { ContractFilesService } from './contract-files.service';
import {
  REOPENED_STATUSES,
  RESENDABLE_STATUSES,
  lockContractWithStaff,
  statusConflict,
  transition,
} from './contract-status';
import {
  checkReopenWorkTime,
  reopenBlocked,
  reopenBlockOf,
} from './contract-reopen';
import {
  ContractsService,
  decideInvitation,
  lockPeople,
} from './contracts.service';

const CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다';

export type EndResult = { contractId: number; status: 'ENDED' };

export type SendResult = SendContractResponseDto;

/**
 * 근로계약 재발송(WHALEERP-136). 보내기는 저장할 때 곧바로 한다(2026-10-19 재영 정정 — ContractDeliveryService). 따로
 * 부르는 것은 재발송 하나다 — 발송 대기 · 서명 대기에서 새 서명 기한(30일)으로 다시 보낸다. 앞서 나간 초대 코드는 무효다.
 * 거부 · 만료도 같은 조건으로 다시 보낸다(WHALEERP-153) — 앱 직원이면 서명 대기, 가입 초대면 발송 대기로 돌아간다. 되살릴 수
 * 없으면(퇴직 · 폐점 · 다른 진행 중 · 기간 끝남 · 겹치거나 더 늦은 체결 완료 · 다른 재계약) 409 REOPEN_BLOCKED, 다른 점포 근무 시간과 겹치면 409
 * WORK_TIME_OVERLAP.
 * - 가입하지 않았고 그 번호로 계정도 없으면 새 초대 코드로 가입 초대 알림톡을 보낸다. 발송 대기 · 서명 대기는 상태 그대로다.
 * - 가입한 직원이면 첫 발송과 같은 앱 알림(근로계약서 발송 알림, #259)이다(WHALEERP-611) — 알림함 알림이고 앱 푸시는 #261
 *   전까지 나가지 않는다. 알림 템플릿을 쓸 수 없거나 탈퇴 계정이면 알림 없이 기한만 새로 잡고 200 이다(첫 발송과 같다).
 *   발송 대기였으면(가입하면 서명 대기로 넘어가 보통은 없다) 앱이 발송 대기 계약을 보이지 않아 서명 대기로 넘긴다 — 근로자
 *   정보 수정과 같은 규칙이다. 알림톡이 없어 502 · 503 은 나지 않는다.
 * - 계정은 있고 이 점포에 가입하지 않은 번호(소속 추가 확인 · 복귀 확인)는 새 소속 추가 확인 요청(알림톡 · 메일)을 보내고 발송
 *   대기로 둔다(WHALEERP-130, 2026-10-26 재영 — 직원이 수락하면 서명 대기). 거부 · 만료도 발송 대기로 돌아간다. 날인 기한은
 *   수락한 때부터라 응답의 기한은 null 이다. 그 계정이 이 점포에 재직 중이면 판별이 409 「이 점포에 이미 재직 중인 직원입니다」
 *   (코드 없음)다.
 * 상세의 「다시 보낼 수 있는가」(canResend)와 직원 목록의 canResend(발송 대기 · 서명 대기만)가 이 판정을 따른다 — 바꾸면 함께 고친다.
 */
@Injectable()
export class ContractSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly delivery: ContractDeliveryService,
    private readonly files: ContractFilesService,
  ) {}

  async send(
    adminAccountId: number,
    contractId: number,
    now = new Date(),
    expected: { status?: ContractStatus; sentAt?: string } = {},
  ): Promise<SendResult> {
    const scoped = await this.contracts.scopedContractOf(
      adminAccountId,
      contractId,
    );
    const { pending, status, joined, sent } = await this.prisma.$transaction(
      async (tx) => {
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
            previousContractId: true,
            startDate: true,
            endDate: true,
            staffMember: {
              select: {
                phone: true,
                joinStatus: true,
                candidateAccountId: true,
                employmentStatus: true,
                retiredDate: true,
              },
            },
          },
        });
        if (!c) throw new NotFoundException(CONTRACT_NOT_FOUND);
        if (
          c.storeId !== scoped.storeId ||
          c.staffMember.phone !== scoped.phone
        )
          throw new ConflictException(
            '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
          );
        if (!c.status || !RESENDABLE_STATUSES.includes(c.status))
          throw statusConflict(c.status ?? 'PENDING_SEND');
        // 화면이 본 상태 · 발송 시각과 다르면 낡은 화면이다(front #136 재리뷰) — 그사이 거부 · 만료된 계약을 모르고 되살리지 않게
        // (상태), 상태가 그대로인 발송 대기 · 서명 대기를 두 탭에서 두 번 보내지 않게(발송 시각 — 재발송마다 바뀐다). 재발송은 네
        // 상태를 모두 받아 위 검사만으로는 잡히지 않는다
        if (expected.status !== undefined && expected.status !== c.status)
          throw statusConflict(c.status);
        // 보낸 적 없는 계약(sentAt null)이면 「먼저 다시 보냈다」가 아니라 화면이 낡은 것이다(셀프 code-review)
        if (expected.sentAt !== undefined && c.sentAt === null)
          throw statusConflict(c.status);
        if (
          expected.sentAt !== undefined &&
          c.sentAt !== null &&
          c.sentAt.getTime() !== new Date(expected.sentAt).getTime()
        )
          throw resentMeanwhile(c.status);
        const reopened = REOPENED_STATUSES.includes(c.status);
        if (reopened) {
          const blocked = await reopenBlockOf(
            tx,
            { ...c, contractId },
            true,
            now,
          );
          if (blocked) throw reopenBlocked(blocked);
          await checkReopenWorkTime(tx, contractId, c.staffMember.phone);
        }
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
          draftAction = invite.draftAction;
          // 소속 추가 확인 요청은 그 계정에 걸린다 — 보낸 뒤 번호의 계정이 바뀌었을 수 있어 판별한 계정으로 다시 둔다(가입 초대는
          // 보낼 때 후보 계정을 비운다)
          if (invite.candidateAccountId !== c.staffMember.candidateAccountId)
            await tx.staffMember.update({
              where: { staffMemberId: c.staffMemberId },
              data: { candidateAccountId: invite.candidateAccountId },
            });
        }
        // 가입한 직원은 앱(서명 대기), 소속 추가 확인 요청은 발송 대기(옛 계약이 서명 대기로 남았어도 수락 전이라 되돌린다), 가입 초대는
        // 상태 그대로다. 거부 · 만료는 보낸 뒤의 상태로 돌아간다 — 앱으로 받으면 서명 대기, 그 밖에는 발송 대기(WHALEERP-153)
        const status =
          joined || reopened || channelOf(false, draftAction) === 'AFFILIATION'
            ? deliveredStatusOf(joined, draftAction)
            : c.status;
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
        return { pending, status, joined, sent: draftAction };
      },
    );
    // 커밋 뒤 보내기 전에 다른 요청(발송 대기 종료 · 재발송)이 초대를 무효로 했으면 보내지 않았다 — 화면이 다시 읽게 409
    const dispatched = await this.delivery.dispatch(pending, adminAccountId);
    if (!dispatched)
      throw new ConflictException(
        '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
      );
    // 나갔으면(답한 것 포함) 그 발송의 보낸 원본을 만든다(WHALEERP-131) — 기다리지 않는다
    this.files.afterSent(contractId);
    // 그사이 직원이 소속 추가 확인 요청에 답했으면 계약은 그 답으로 서명 대기(기한은 수락부터) · 거부다 — 지금 값을 싣는다(api #164 리뷰)
    if (dispatched === 'ANSWERED') {
      const c = await this.prisma.contract.findUnique({
        where: { contractId },
        select: { status: true, sentAt: true, signDeadlineAt: true },
      });
      if (!c?.status) throw new NotFoundException(CONTRACT_NOT_FOUND);
      return {
        contractId,
        status: c.status,
        sentAt: (c.sentAt ?? now).toISOString(),
        signDeadlineAt: c.signDeadlineAt?.toISOString() ?? null,
      };
    }
    return {
      contractId,
      status,
      sentAt: now.toISOString(),
      signDeadlineAt:
        !joined && channelOf(false, sent) === 'AFFILIATION'
          ? null
          : new Date(now.getTime() + SEND_VALID_MS).toISOString(),
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
      // 발송 대기가 아니면 transition 이 지금 상태를 실어 409 다
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

/**
 * 상태는 같은데 화면이 본 뒤 다른 요청이 먼저 다시 보냈다(expectedSentAt 이 다름) — 「이미 ○○ 상태」 문장은 화면과 같아 까닭을
 * 알 수 없어 따로 알린다. code 는 상태 충돌과 같아 화면이 다시 읽는다(api #158 셀프 code-review).
 */
const resentMeanwhile = (status: ContractStatus) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'CONTRACT_STATUS_CONFLICT',
    message:
      '다른 요청이 먼저 근로계약서를 다시 보냈습니다. 화면을 새로 고쳐 마지막 발송 시각을 확인해 주세요',
    status,
  });
