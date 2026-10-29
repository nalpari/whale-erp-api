import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InvitationType, Prisma } from '@prisma/client';
import {
  HQ_SHARING_CONSENT_VERSION,
  hqSharingAgreedOf,
} from '../admin-scope/hq-sharing';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import { SEND_VALID_MS } from '../contracts/contract-delivery.service';
import {
  PENDING_TERMS_SELECT,
  pendingTermsOf,
  transitionMany,
} from '../contracts/contract-status';
import { lockPeople } from '../contracts/contracts.service';
import {
  OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { storeManagers } from '../notifications/recipients';
import { noticeStaff } from '../notifications/staff-notice';
import { employmentTypeLabel } from '../enums/employment-type-label';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AffiliationRequestDto,
  AcceptAffiliationRequestDto,
  AcceptAffiliationResponseDto,
  RejectAffiliationRequestDto,
} from './dto/affiliation-request.dto';
import { asksHqSharingConsentAt } from './hq-sharing-consent';
import { sameName } from './same-name';

type Db = Prisma.TransactionClient | PrismaService;

/** 소속 추가 확인 요청 — 소속 추가 확인 · 복귀 확인 초대(2026-10-26 재영 — 용어는 둘 다 「소속 추가 확인 요청」) */
const REQUEST_TYPES: InvitationType[] = [
  'AFFILIATION_CONFIRM',
  'RETURN_CONFIRM',
];
const REQUEST_ENDED =
  '끝난 소속 추가 확인 요청입니다. 점포 관리자에게 다시 보내 달라고 요청해 주세요.';

const notFound = () =>
  new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code: 'AFFILIATION_REQUEST_NOT_FOUND',
    message: '소속 추가 확인 요청을 찾을 수 없습니다.',
  });
const ended = () =>
  new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code: 'AFFILIATION_REQUEST_ENDED',
    message: REQUEST_ENDED,
  });
const answered = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'AFFILIATION_REQUEST_ANSWERED',
    message: '이미 답한 소속 추가 확인 요청입니다.',
  });

/**
 * 소속 추가 확인 요청에 직원이 답한다(WHALEERP-130 · 144, 2026-10-26 재영). 계정은 있고 그 점포 레코드에 아직 잇지 않은 번호로
 * 근로계약서를 저장하면 계약은 발송 대기로 두고 요청(소속 추가 확인 · 복귀 확인 초대)이 그 계정(후보 계정)에 걸린다
 * (ContractDeliveryService). 직원 앱이 로그인 뒤 요청을 보이고 직원이 수락 · 거절한다.
 * - 수락: 직원 레코드에 계정을 잇고(가입 완료) 그 레코드의 발송 대기 계약을 서명 대기로 넘긴다. 날인 기한 30일은 이때부터
 *   센다 — 요청을 보낼 때는 기한을 두지 않았다. 날인 요청 직원 알림(PUSH_CONTRACT_SENT)을 만든다. 가맹 점포이고 본사 제공
 *   동의를 하지 않은 계정이면 여기서 함께 묻는다(근무지 더하기와 같다).
 * - 거절: 사유는 선택(JOIN-5). 요청을 거절로 두고 사유를 남긴다. 직원 레코드는 지우지 않는다(운영 정책 JOI-08) — 후보 계정도
 *   그대로 둔다(관리자가 다시 보내면 판별이 다시 쓴다). 함께 온 발송 대기 계약은 거부로 닫고 같은 사유를 남긴다. 초안을 쓴
 *   관리자에게 「소속 추가 확인 거절」 운영 알림을 보낸다(커밋 뒤).
 * - 답하지 않으면 30일 뒤 요청만 만료되고(하루 배치) 계약은 발송 대기로 남는다 — 관리자가 다시 보내면 새 요청이다.
 * 잠금 순서는 근무지 더하기와 같다 — 번호 → 직원 행 → 초대 · 계약.
 */
@Injectable()
export class AffiliationRequestsService {
  private readonly logger = new Logger(AffiliationRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: OpsNotificationService,
  ) {}

  /**
   * 내 살아 있는 요청 — 보냄 · 기한 안 · 아직 잇지 않은 레코드. 최근 보낸 것부터. 번호가 같아도 근로계약서 이름이 계정 이름과
   * 다르면 이 계정에 온 요청으로 보지 않는다(sameName, WHALEERP-140) — 번호를 넘겨받은 다른 사람 앞 요청일 수 있다
   */
  async list(
    accountId: number,
    now = new Date(),
  ): Promise<AffiliationRequestDto[]> {
    const account = await this.accountOf(this.prisma, accountId);
    const rows = await this.prisma.invitation.findMany({
      where: {
        status: 'SENT',
        expiresAt: { gt: now },
        invitationType: { in: REQUEST_TYPES },
        staffMember: {
          candidateAccountId: accountId,
          accountId: null,
          phone: account.phone,
        },
      },
      orderBy: [{ sentAt: 'desc' }, { invitationId: 'desc' }],
      select: {
        invitationId: true,
        invitationType: true,
        sentAt: true,
        expiresAt: true,
        // 함께 온 계약의 고용 형태 · 직무(없으면 레코드) — pendingTermsOf
        staffMember: {
          select: { storeId: true, name: true, ...PENDING_TERMS_SELECT },
        },
      },
    });
    const mine: typeof rows = [];
    const hidden: number[] = [];
    for (const r of rows)
      if (sameName(r.staffMember.name, account.realName)) mine.push(r);
      else hidden.push(r.invitationId);
    // 관리자 쪽은 소속 추가 확인 대기로만 남아 원인이 보이지 않는다 — 걸러진 요청 id 만 남긴다(이름은 남기지 않음). 앱이 열 때마다
    // 읽는 목록이라 debug 로 두고, 직원이 답하려다 막힌 때(lockRequest)만 warn 으로 남긴다
    if (hidden.length)
      this.logger.debug(
        `계정 ${accountId} — 근로계약서 이름이 달라 보이지 않는 소속 추가 확인 요청: ${hidden.join(', ')}`,
      );
    const stores = await this.prisma.store.findMany({
      where: {
        storeId: { in: [...new Set(mine.map((r) => r.staffMember.storeId))] },
      },
      select: {
        storeId: true,
        name: true,
        storeTypeCode: true,
        bpCode: { select: { tradeName: true } },
      },
    });
    const byId = new Map(stores.map((s) => [s.storeId, s]));
    return mine.map((r) => {
      const store = byId.get(r.staffMember.storeId);
      const { employmentType, jobTitle } = pendingTermsOf(
        r.staffMember,
        r.staffMember.contracts[0],
      );
      return {
        invitationId: r.invitationId,
        invitationType:
          r.invitationType as AffiliationRequestDto['invitationType'],
        storeName: store?.name ?? '',
        bpName: store?.bpCode.tradeName ?? '',
        employmentType,
        employmentTypeLabel: employmentTypeLabel(employmentType),
        jobTitle,
        sentAt: r.sentAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        asksHqSharingConsent:
          asksHqSharingConsentAt(store?.storeTypeCode) &&
          !hqSharingAgreedOf(account),
      };
    });
  }

  /** 수락 — 레코드에 계정을 잇고 발송 대기 계약을 서명 대기로(날인 기한은 지금부터 30일) */
  async accept(
    accountId: number,
    invitationId: number,
    dto: AcceptAffiliationRequestDto,
    now = new Date(),
  ): Promise<AcceptAffiliationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const { account, request } = await this.lockRequest(
        tx,
        accountId,
        invitationId,
        now,
      );
      const { staffMemberId, storeId } = request.staffMember;
      // 그사이 이 점포에 재직 중인 레코드가 이 계정에 이어졌으면 둘이 되지 않게 막는다(판별의 409 와 같다)
      const employed = await tx.staffMember.findFirst({
        where: {
          storeId,
          accountId,
          joinStatus: 'JOINED',
          employmentStatus: 'EMPLOYED',
        },
        select: { staffMemberId: true },
      });
      if (employed)
        throw new ConflictException('이 점포에 이미 재직 중입니다.');
      const accepted = await tx.invitation.updateMany({
        where: { invitationId, status: 'SENT' },
        data: { status: 'ACCEPTED', respondedAt: now },
      });
      if (accepted.count === 0) throw answered();
      const store = await tx.store.findUnique({
        where: { storeId },
        select: { name: true, storeTypeCode: true },
      });
      if (
        asksHqSharingConsentAt(store?.storeTypeCode) &&
        !hqSharingAgreedOf(account) &&
        dto.hqSharingConsented === true
      )
        // 철회했던 계정이 다시 동의하면 철회 시각을 지운다 — 근무지 더하기와 같다(accounts_hq_sharing_consent_fields)
        await tx.account.update({
          where: { accountId },
          data: {
            isHqSharingConsented: true,
            hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
            hqSharingAgreedAt: now,
            hqSharingWithdrawnAt: null,
          },
        });
      const linked = await tx.staffMember.updateMany({
        where: { staffMemberId, accountId: null },
        data: { accountId, joinStatus: 'JOINED', candidateAccountId: null },
      });
      if (linked.count === 0) throw answered();
      const moved = await transitionMany(
        tx,
        { staffMemberId },
        'PENDING_SEND',
        'PENDING_SIGNATURE',
        'STAFF',
      );
      const deadline = new Date(now.getTime() + SEND_VALID_MS);
      if (moved.length)
        await tx.contract.updateMany({
          where: { contractId: { in: moved } },
          data: { signDeadlineAt: deadline },
        });
      // 날인 기한은 한국 날짜로 — 템플릿 예시 「10월 30일」(근로계약서 발송 직원 알림과 같다)
      const day = new Date(deadline.getTime() + 9 * 60 * 60 * 1000);
      for (const contractId of moved)
        await noticeStaff(tx, this.logger, {
          templateCode: 'PUSH_CONTRACT_SENT',
          accountId,
          relatedType: 'CONTRACT',
          relatedId: contractId,
          variables: {
            근무지: store?.name ?? '',
            날인기한: `${day.getUTCMonth() + 1}월 ${day.getUTCDate()}일`,
          },
        });
      return {
        staffMemberId,
        storeName: store?.name ?? '',
        contractIds: moved,
      };
    });
  }

  /** 거절 — 요청 · 함께 온 발송 대기 계약을 거절 · 거부로 닫고 같은 사유를 남긴다. 레코드는 둔다 */
  async reject(
    accountId: number,
    invitationId: number,
    dto: RejectAffiliationRequestDto,
    now = new Date(),
  ): Promise<void> {
    // 길이 · 앞뒤 공백은 DTO 가 본다(근로계약서 거부와 같다)
    const rejectReason = dto.reason || null;
    const done = await this.prisma.$transaction(async (tx) => {
      const { request } = await this.lockRequest(
        tx,
        accountId,
        invitationId,
        now,
      );
      const { staffMemberId, storeId, name } = request.staffMember;
      const rejected = await tx.invitation.updateMany({
        where: { invitationId, status: 'SENT' },
        data: { status: 'REJECTED', respondedAt: now, rejectReason },
      });
      if (rejected.count === 0) throw answered();
      const closed = await transitionMany(
        tx,
        { staffMemberId },
        'PENDING_SEND',
        'REJECTED',
        'STAFF',
      );
      if (closed.length)
        await tx.contract.updateMany({
          where: { contractId: { in: closed } },
          data: { rejectReason },
        });
      const writers = await tx.contract.findMany({
        where: { contractId: { in: closed } },
        select: { createdBy: true },
      });
      const store = await tx.store.findUnique({
        where: { storeId },
        select: { name: true },
      });
      return {
        staffMemberId,
        staffName: name,
        storeName: store?.name ?? '',
        writers: [...new Set(writers.map((w) => w.createdBy))],
      };
    });
    await this.noticeRejected(invitationId, done);
  }

  /**
   * 「소속 추가 확인 거절」 운영 알림(NTF_AFFILIATION_REJECTED) — 초안을 쓴 관리자에게(2026-10-26 재영). 그 관리자가 지금도 사용
   * 중이고 그 근무지를 맡고 있어야 한다(storeManagers — 가맹 점포 가림 기준 포함) — 그사이 비활성 · 담당 해제 · 다른 BP 로 옮겼으면
   * 직원 이름을 보여선 안 된다(api #164 리뷰). 그런 관리자뿐이거나 함께 온 계약이 없으면 근무지를 맡은 관리자에게 보낸다. 메일 EMAIL_AFFILIATION_REJECTED 는 사용 안 함이라 보내지 않는다. 커밋 뒤라 실패해도
   * 던지지 않는다(로그만).
   */
  private async noticeRejected(
    invitationId: number,
    done: {
      staffMemberId: number;
      staffName: string;
      storeName: string;
      writers: number[];
    },
  ): Promise<void> {
    const at = `invitation=${invitationId}`;
    try {
      const managers = await storeManagers(this.prisma, done.staffMemberId);
      const writers = done.writers.filter((w) => managers.includes(w));
      const recipients = writers.length ? writers : managers;
      await this.ops.notify({
        templateCode: 'NTF_AFFILIATION_REJECTED',
        variables: { 직원이름: done.staffName, 근무지: done.storeName },
        related: { type: 'STAFF_MEMBER', id: done.staffMemberId },
        link: `/staff-members/${done.staffMemberId}`,
        eventKey: String(invitationId),
        recipients,
      });
    } catch (e) {
      this.logger.error(
        `affiliation rejected notice FAILED ${at}: ${reasonOf(e)}`,
      );
    }
  }

  /**
   * 내 요청을 잠그고 다시 읽는다 — 번호 → 직원 행 순서(근무지 더하기 · 근로계약 저장과 같다). 요청이 없거나 내 것이 아니면 404,
   * 이미 답했으면 409, 만료됐으면(배치 전 포함) 404 AFFILIATION_REQUEST_ENDED. 잠근 뒤 직원 행의 번호 · 후보 계정이 그대로여야
   * 한다 — 그사이 근로계약 수정으로 번호가 바뀌었으면 끝난 요청이다.
   */
  private async lockRequest(
    tx: Prisma.TransactionClient,
    accountId: number,
    invitationId: number,
    now: Date,
  ) {
    // 경로의 id 는 정수만 받는다(ParseIntPipe) — int4 를 넘으면 DB 가 받지 못해 없는 요청과 같게 답한다
    if (invitationId < 1 || invitationId > 2_147_483_647) throw notFound();
    const { phone } = await this.accountOf(tx, accountId);
    await lockPeople(tx, [phone]);
    // 계정 행도 잠그고 다시 읽는다 — 수락이 옛 문구 버전 동의를 다시 쓰는 사이 내 정보 철회(이 행을 잠근다)가 들어와도
    // 덮지 않게(근무지 더하기와 같다, api #183 리뷰). 번호 → 계정 → 직원 행 순서다
    await tx.$executeRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
    const account = await this.accountOf(tx, accountId);
    const head = await tx.invitation.findUnique({
      where: { invitationId },
      select: { staffMemberId: true, invitationType: true },
    });
    if (!head || !REQUEST_TYPES.includes(head.invitationType)) throw notFound();
    await tx.$executeRaw`
      SELECT 1 FROM staff_members WHERE staff_member_id = ${head.staffMemberId} FOR UPDATE`;
    const request = await tx.invitation.findUnique({
      where: { invitationId },
      select: {
        status: true,
        expiresAt: true,
        staffMember: {
          select: {
            staffMemberId: true,
            storeId: true,
            name: true,
            phone: true,
            accountId: true,
            candidateAccountId: true,
          },
        },
      },
    });
    const s = request?.staffMember;
    // 근로계약서 이름이 계정 이름과 다르면 이 계정 요청이 아니다(sameName, WHALEERP-140) — 상태보다 먼저 봐, 번호를 넘겨받은
    // 다른 사람 앞 요청이 답했는지 끝났는지 드러나지 않게 한다(근무지 더하기와 같다)
    const otherName =
      !!s &&
      s.candidateAccountId === accountId &&
      !sameName(s.name, account.realName);
    if (!request || !s || s.candidateAccountId !== accountId || otherName) {
      // 이미 수락해 이 계정에 이어졌으면 답한 요청이다 — 레코드가 이 계정에 이어진 것이 본인이 답했다는 증거라, 그 뒤 이름이
      // 바뀌어도 409 다. 거절은 그런 증거가 없어(후보 계정만 남는다) 이름이 다르면 404 다 — 409 로 답하면 이름이 다른 계정에
      // 남의 요청이 답했다는 것이 드러난다
      if (s?.accountId === accountId && request?.status === 'ACCEPTED')
        throw answered();
      if (otherName)
        this.logger.warn(
          `계정 ${accountId} — 근로계약서 이름이 달라 소속 추가 확인 요청 ${invitationId} 에 답하지 못함`,
        );
      throw notFound();
    }
    if (request.status === 'ACCEPTED' || request.status === 'REJECTED')
      throw answered();
    if (
      request.status !== 'SENT' ||
      request.expiresAt <= now ||
      s.phone !== account.phone ||
      s.accountId !== null
    )
      throw ended();
    return { account, request };
  }

  /** 로그인한 계정 — 가드가 접속을 확인한 뒤 탈퇴했을 수 있다 */
  private async accountOf(db: Db, accountId: number) {
    const account = await db.account.findUnique({
      where: { accountId },
      select: {
        phone: true,
        realName: true,
        status: true,
        isHqSharingConsented: true,
        hqSharingConsentVersion: true,
      },
    });
    if (!account || account.status === 'WITHDRAWN')
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    return account;
  }
}
