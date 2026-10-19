import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { InquiryStatus, Prisma, ReplyMailResult } from '@prisma/client';
import { adminNames } from '../common/admin-names';
import { statusesOf } from '../common/answer-status';
import {
  memoValue,
  type SaveInternalMemoDto,
} from '../common/save-internal-memo.dto';
import { sameMillisecond } from '../common/updated-at';
import { errorKind } from '../common/error-kind';
import { DB_ENUMS } from '../enums/db-enums.generated';
import {
  OPTIONAL_MAIL_SERVICE,
  type OptionalMailService,
} from '../mail/mail.module';
import {
  OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { addMonths, kstToday } from '../staff-members/kst-date';
import {
  deleteLeadNotifications,
  notifyLeadOperators,
} from './lead-notifications';
import type {
  LeadListResponseDto,
  LeadResponseDto,
} from './dto/lead.response.dto';
import type { LeadReplyMailResponseDto } from './dto/lead-reply-mail.response.dto';
import type { LeadStateResponseDto } from './dto/lead-state.response.dto';
import type { ListLeadsDto } from './dto/list-leads.dto';
import type { SaveLeadReplyDto } from './dto/save-lead-reply.dto';

const NOT_FOUND = '도입문의를 찾을 수 없습니다';
const STATE = { leadId: true, status: true, updatedAt: true } as const;
const STALE = '그사이 다른 운영자가 저장했습니다. 다시 불러온 뒤 저장해 주세요';
const RESEND_TOO_SOON = '방금 답변 메일을 보냈습니다. 1분 뒤 다시 보내 주세요';
const RESEND_NOT_ANSWERED =
  '답변완료 도입문의만 답변 메일을 다시 보낼 수 있습니다';
const MAIL_UNAVAILABLE =
  '메일 발송이 설정되지 않아 답변 메일을 보낼 수 없습니다. 운영자에게 문의해 주세요';

/**
 * 커뮤니티 관리 도입문의 — 목록 · 상세(WHALEERP-332), 처리중 · 답변 · 내부 메모(WHALEERP-274), 지우기(WHALEERP-590). 플랫폼 관리자만
 * 쓴다 — 권한은 컨트롤러가 본다. 접수(#295)는 LeadsService 다.
 *
 * 처리 상태가 바뀌면(처리중 전환 · 답변완료) 플랫폼 운영자에게 운영 알림 `NTF_LEAD_ANSWERED` 를 보낸다(운영 정책
 * NTF-01 · 04, 2026-10-14 재영). 커밋 뒤에 응답을 기다리게 하지 않고 보내고, 실패해도 처리는 성공이다.
 *
 * 처음 답변하면 문의자가 적은 이메일로 답변 본문을 보낸다(`EMAIL_LEAD_REPLY`, #588). 고쳐도 다시 보내지 않는다.
 * 알림과 같이 응답을 기다리게 하지 않고, 실패해도 답변 저장은 그대로다(운영 정책 NTF-08). 결과 · 시각은 도입문의 행에
 * 남기고(`reply_mail_result` · `reply_mail_attempted_at`), 실패했으면 운영자가 상세에서 다시 보낸다(#597).
 */
@Injectable()
export class LeadsAdminService {
  private readonly logger = new Logger(LeadsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: OpsNotificationService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
  ) {}

  /** 커뮤니티 관리 도입문의 목록 (#332). 접수 최신순. */
  async list({
    answerStatus,
    page,
    pageSize,
  }: ListLeadsDto): Promise<LeadListResponseDto> {
    const where: Prisma.LeadWhereInput = {
      AND: [
        notExpired(),
        answerStatus ? { status: { in: statusesOf(answerStatus) } } : {},
      ],
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        select: {
          leadId: true,
          contactName: true,
          phone: true,
          industryCode: true,
          industryDetail: true,
          interests: true,
          status: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { leadId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lead.count({ where }),
    ]);
    return { items, total };
  }

  /** 커뮤니티 관리 도입문의 상세 (#332, 운영 정책 CNT-12). */
  async get(leadId: number): Promise<LeadResponseDto> {
    const lead = await this.prisma.lead.findFirst({
      where: { leadId, ...notExpired() },
    });
    if (!lead) throw new NotFoundException(NOT_FOUND);
    const names = await adminNames(this.prisma, [
      lead.processingStartedBy,
      lead.repliedBy,
    ]);
    // 칸을 하나씩 옮긴다 — 행을 펼치면 테이블에 더해진 칸이 응답에 저절로 실린다.
    return {
      leadId: lead.leadId,
      contactName: lead.contactName,
      phone: lead.phone,
      industryCode: lead.industryCode,
      industryDetail: lead.industryDetail,
      interests: lead.interests,
      status: lead.status,
      createdAt: lead.createdAt,
      email: lead.email,
      planPeriodCode: lead.planPeriodCode,
      body: lead.body,
      privacyAgreedAt: lead.privacyAgreedAt,
      marketingAgreedAt: lead.marketingAgreedAt,
      processingStartedAt: lead.processingStartedAt,
      processingStartedBy: lead.processingStartedBy,
      processingStartedByName: names.get(lead.processingStartedBy) ?? null,
      reply: lead.reply,
      repliedAt: lead.repliedAt,
      repliedBy: lead.repliedBy,
      repliedByName: names.get(lead.repliedBy) ?? null,
      replyMailResult: lead.replyMailResult,
      replyMailAttemptedAt: lead.replyMailAttemptedAt,
      internalMemo: lead.internalMemo,
      // 날짜만 있는 칸은 UTC 자정 Date 로 온다(kst-date.ts).
      consultedDate: lead.consultedDate?.toISOString().slice(0, 10) ?? null,
      updatedAt: lead.updatedAt,
    };
  }

  /** 접수 상태만 처리중으로 바꾼다. 상태를 조건에 넣은 UPDATE 라 동시에 눌러도 하나만 바뀐다. */
  async startProcessing(
    adminId: number,
    leadId: number,
  ): Promise<LeadStateResponseDto> {
    const state = await this.updateAndRead(
      { leadId, status: 'RECEIVED' },
      {
        status: 'IN_PROGRESS',
        processingStartedBy: adminId,
        processingStartedAt: new Date(),
      },
    );
    if (state) {
      void this.notifyStatus(leadId, 'IN_PROGRESS');
      return state;
    }
    const current = await this.stateOf(leadId);
    throw new ConflictException(
      current.status === 'ANSWERED'
        ? '이미 답변한 도입문의입니다'
        : '이미 처리중인 도입문의입니다',
    );
  }

  /**
   * 답변을 저장하고 답변 완료로 바꾼다. 답변자 · 답변 시각은 마지막 저장의 것이다. 상담 완료일은 비어 있을 때만
   * 오늘(한국 날짜)로 채운다 — 1년 뒤 파기의 기준이라(CNT-11) 고칠 때 다시 쓰지 않고, 예전에 상담 완료일 없이
   * 답변완료가 된 행도 다음 저장 때 파기 대상에 든다.
   */
  async reply(
    adminId: number,
    leadId: number,
    dto: SaveLeadReplyDto,
  ): Promise<LeadStateResponseDto> {
    const before = await this.prisma.lead.findUnique({
      where: { leadId },
      select: {
        status: true,
        consultedDate: true,
        email: true,
      },
    });
    if (!before) throw new NotFoundException(NOT_FOUND);
    const now = new Date();
    const state = await this.updateAndRead(
      { leadId, updatedAt: sameMillisecond(dto.updatedAt) },
      {
        reply: dto.reply,
        repliedBy: adminId,
        repliedAt: now,
        status: 'ANSWERED',
        ...(before.consultedDate === null && {
          consultedDate: kstToday(now),
        }),
      },
    );
    if (!state) {
      await this.stateOf(leadId); // 그사이 지워졌으면(#590) 404
      throw new ConflictException(STALE);
    }
    // 그사이 누가 끼어들었으면 위 UPDATE 가 0 건이라, 여기 온 요청의 저장 전 상태는 믿을 수 있다.
    if (before.status !== 'ANSWERED') {
      void this.notifyStatus(leadId, 'ANSWERED');
      void this.mailFirstReply(leadId, before.email, dto.reply).catch(
        (e: unknown) =>
          this.logger.error(
            `lead reply mail NOT STARTED lead=${leadId} ${errorKind(e)}`,
          ),
      );
    }
    return state;
  }

  /**
   * 답변 메일 다시 보내기(WHALEERP-597, 2026-10-19 재영). 답변완료 도입문의에 저장된 지금 답변을 보낸다 — 고친 뒤
   * 보내면 고친 답변이 간다. 보낸 운영자는 메일 이력의 sent_by 에 남는다. 같은 도입문의는 1분에 한 번이다 — 마지막
   * 메일 시각을 조건에 건 UPDATE 로 시각을 잡으므로 동시에 눌러도 하나만 나간다. 시각은 DB 시계다. 시각을 잡을 때
   * 결과를 비운다 — 보내는 동안 상세가 「새 시각 + 지난 결과」를 보이지 않게(시각만 있으면 결과 모름).
   *
   * 결과를 기다려 돌려준다. SMTP 실패도 오류가 아니다 — 결과 칸에 남고 운영자가 보고 다시 보낸다. `MAIL_*` 가 없으면
   * 눌러도 계속 실패하므로 시각을 잡기 전에 503 이다(재설정 링크 발급과 같다). 파기 기한이 지난 도입문의는 상세처럼 404 다.
   */
  async resendReplyMail(
    adminId: number,
    leadId: number,
  ): Promise<LeadReplyMailResponseDto> {
    if (!this.mail) throw new ServiceUnavailableException(MAIL_UNAVAILABLE);
    const cutoff = addMonths(kstToday(), -12).toISOString().slice(0, 10);
    const [claimed] = await this.prisma.$queryRaw<
      { email: string; reply: string; attemptedAt: Date }[]
    >`
      UPDATE leads
      SET reply_mail_attempted_at = date_trunc('milliseconds', now()), reply_mail_result = NULL
      WHERE lead_id = ${leadId} AND status = 'ANSWERED' AND reply IS NOT NULL
        AND (reply_mail_attempted_at IS NULL OR reply_mail_attempted_at <= now() - interval '1 minute')
        AND (consulted_date IS NULL OR consulted_date >= ${cutoff}::date)
      RETURNING email, reply, reply_mail_attempted_at AS "attemptedAt"`;
    if (!claimed) {
      const found = await this.prisma.lead.findFirst({
        where: { leadId, ...notExpired() },
        select: { status: true, reply: true },
      });
      if (!found) throw new NotFoundException(NOT_FOUND);
      throw new ConflictException(
        found.status === 'ANSWERED' && found.reply !== null
          ? RESEND_TOO_SOON
          : RESEND_NOT_ANSWERED,
      );
    }
    const replyMailResult = await this.sendReply(
      leadId,
      claimed.email,
      claimed.reply,
      claimed.attemptedAt,
      adminId,
    );
    return { replyMailResult, replyMailAttemptedAt: claimed.attemptedAt };
  }

  async saveInternalMemo(
    leadId: number,
    dto: SaveInternalMemoDto,
  ): Promise<LeadStateResponseDto> {
    const state = await this.updateAndRead(
      { leadId, updatedAt: sameMillisecond(dto.updatedAt) },
      { internalMemo: memoValue(dto.internalMemo) },
    );
    if (state) return state;
    await this.stateOf(leadId); // 없으면 404
    throw new ConflictException(STALE);
  }

  /**
   * 상담하지 않은(상담 완료일 없고 답변하지 않은) 도입문의를 행째 지운다 — 개인정보 파기라 삭제 표시를 남기지 않고,
   * 문의자 이름이 든 운영 알림도 같은 트랜잭션에서 지운다(운영 정책 CNT-11, WHALEERP-590). 상담을 마친 건은 1년 뒤
   * 파기 배치가 지운다. 조건을 DELETE 에 넣어, 그사이 답변이 저장됐으면 지우지 않는다. 상담 완료일 없이 답변완료가 된
   * 옛 행도 답변한 건이라 지우지 않는다. 행이 없으니 누가 지웠는지는 서버 로그에만 남는다.
   */
  async remove(adminId: number, leadId: number): Promise<void> {
    const removed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.lead.deleteMany({
        where: { leadId, consultedDate: null, status: { not: 'ANSWERED' } },
      });
      if (count > 0) await deleteLeadNotifications(tx, [leadId]);
      return count > 0;
    });
    if (!removed) {
      const found = await this.prisma.lead.findFirst({
        where: { leadId, ...notExpired() },
        select: { leadId: true },
      });
      if (!found) throw new NotFoundException(NOT_FOUND);
      throw new ConflictException('상담을 마친 도입문의는 지울 수 없습니다');
    }
    this.logger.log(`lead deleted lead=${leadId} admin=${adminId}`);
  }

  /**
   * 조건에 맞으면 바꾸고 바꾼 행을 같은 트랜잭션 안에서(행 잠금을 쥔 채) 읽는다. 맞는 행이 없으면 null. 커밋 뒤에
   * 따로 읽으면 그사이 다른 운영자가 저장한 updatedAt 을 돌려줘, 다음 저장이 409 없이 남의 저장을 덮는다.
   */
  private updateAndRead(
    where: Prisma.LeadWhereInput & { leadId: number },
    data: Prisma.LeadUncheckedUpdateManyInput,
  ): Promise<LeadStateResponseDto | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.lead.updateMany({ where, data });
      if (count === 0) return null;
      return tx.lead.findUniqueOrThrow({
        where: { leadId: where.leadId },
        select: STATE,
      });
    });
  }

  /**
   * 첫 답변 메일(#588). 시각을 잡고 보낸다 — 1분 안의 다시 보내기는 이 시각에 막힌다. 첫 답변은 한 번뿐이라 시각이
   * 비어 있어야 하고, 비어 있지 않으면(커밋과 이 UPDATE 사이에 다시 보내기가 먼저 잡았으면) 보내지 않는다 — 두 통이
   * 나가지 않게. 그사이 지워졌을 때도 잡히지 않아 보내지 않는다.
   */
  private async mailFirstReply(
    leadId: number,
    email: string,
    reply: string,
  ): Promise<void> {
    const [claimed] = await this.prisma.$queryRaw<{ attemptedAt: Date }[]>`
      UPDATE leads
      SET reply_mail_attempted_at = date_trunc('milliseconds', now()), reply_mail_result = NULL
      WHERE lead_id = ${leadId} AND reply_mail_attempted_at IS NULL
      RETURNING reply_mail_attempted_at AS "attemptedAt"`;
    if (!claimed) {
      this.logger.log(`lead reply mail SKIPPED already claimed lead=${leadId}`);
      return;
    }
    await this.sendReply(leadId, email, reply, claimed.attemptedAt);
  }

  /**
   * 답변 본문만 보낸다 — 내부 메모는 문의자에게 가지 않는다. 비로그인 문의자라 버튼 링크도 없다.
   * 문의자 이름도 싣지 않는다 — 확인되지 않은 주소로 가는 회사 명의 메일에 비로그인 입력값이 실린다(재영 결정 2026-10-15,
   * 운영 정책 CNT-11 v134). 답변은 운영자가 쓴 글이라 싣는다.
   *
   * 결과는 잡은 시각이 그대로일 때만 쓴다 — SMTP 가 1분 넘게 걸려 그사이 다시 보냈으면, 늦게 끝난 앞 발송이 뒤 발송의
   * 결과를 덮지 않는다(못 쓰면 SUPERSEDED 로 남긴다). 첫 답변 때 MAIL_* 가 없어 못 보낸 것도 실패다. 던지지 않는다.
   */
  private async sendReply(
    leadId: number,
    to: string,
    reply: string,
    attemptedAt: Date,
    sentBy?: number,
  ): Promise<ReplyMailResult> {
    let result: ReplyMailResult = 'FAILED';
    if (!this.mail) {
      this.logger.warn(`lead reply mail SKIPPED no MAIL_* lead=${leadId}`);
    } else {
      try {
        await this.mail.send({
          templateCode: 'EMAIL_LEAD_REPLY',
          to,
          variables: { 답변: reply },
          ...(sentBy !== undefined && { sentBy }),
        });
        result = 'SUCCEEDED';
      } catch (e) {
        // 메시지는 남기지 않는다 — SMTP 오류에는 받는 주소가 섞인다.
        this.logger.error(
          `lead reply mail FAILED lead=${leadId} ${errorKind(e)}`,
        );
      }
    }
    try {
      // @updatedAt 을 건드리지 않게 SQL 로 쓴다 — 메일 결과가 운영자의 다음 저장을 409 로 만들면 안 된다.
      const count = await this.prisma.$executeRaw`
        UPDATE leads SET reply_mail_result = ${result}::reply_mail_result
        WHERE lead_id = ${leadId} AND reply_mail_attempted_at = ${attemptedAt}`;
      if (count === 0)
        this.logger.warn(
          `lead reply mail result SUPERSEDED lead=${leadId} result=${result}`,
        );
    } catch (e) {
      this.logger.error(
        `lead reply mail result NOT RECORDED lead=${leadId} result=${result} ${errorKind(e)}`,
      );
    }
    return result;
  }

  /**
   * 플랫폼 운영자에게 처리 상태 변경을 알린다. 사건 키는 도입문의 ID + 상태라 같은 상태로 두 번 알리지 않는다.
   * 무엇이 실패해도 던지지 않는다(커밋 뒤라 던지면 처리는 됐는데 500 이 된다).
   */
  private async notifyStatus(
    leadId: number,
    status: InquiryStatus,
  ): Promise<void> {
    try {
      await notifyLeadOperators(this.prisma, this.ops, leadId, {
        templateCode: 'NTF_LEAD_ANSWERED',
        eventKey: `${leadId}:${status}`,
        variables: { 처리상태: statusLabel(status) },
      });
    } catch (e) {
      this.logger.error(
        `lead status notification FAILED lead=${leadId} status=${status}: ${reasonOf(e)}`,
      );
    }
  }

  private async stateOf(leadId: number): Promise<LeadStateResponseDto> {
    const row = await this.prisma.lead.findUnique({
      where: { leadId },
      select: STATE,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }
}

/** enum 한글(DB 타입 설명에서 생성한 목록). 없으면 값 그대로. */
function statusLabel(status: InquiryStatus): string {
  return (
    DB_ENUMS.InquiryStatus.find(([value]) => value === status)?.[1] ?? status
  );
}

/**
 * 파기 기한 안의 도입문의. 파기 배치(`LeadsService.purgeExpired`)와 같은 기준이다 — 상담 완료일이 한국 날짜로 1년 전보다
 * 앞서면 파기 대상이다(운영 정책 CNT-11). 배치가 하루 실패해도 조회에는 연락처가 나오지 않는다. 기준을 바꾸면 둘을 같이
 * 바꾼다.
 */
function notExpired(): Prisma.LeadWhereInput {
  return {
    OR: [
      { consultedDate: null },
      { consultedDate: { gte: addMonths(kstToday(), -12) } },
    ],
  };
}
