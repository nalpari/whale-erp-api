import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { InquiryStatus, Prisma } from '@prisma/client';
import { PLATFORM_BP_CODE } from '../code-groups/code-format';
import { adminNames } from '../common/admin-names';
import { statusesOf } from '../common/answer-status';
import {
  memoValue,
  type SaveInternalMemoDto,
} from '../common/save-internal-memo.dto';
import { sameMillisecond } from '../common/updated-at';
import { DB_ENUMS } from '../enums/db-enums.generated';
import {
  OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { platformOperators } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import { addMonths, kstToday } from '../staff-members/kst-date';
import { INDUSTRY_OTHER } from './dto/create-lead.dto';
import type {
  LeadListResponseDto,
  LeadResponseDto,
} from './dto/lead.response.dto';
import type { LeadStateResponseDto } from './dto/lead-state.response.dto';
import type { ListLeadsDto } from './dto/list-leads.dto';
import type { SaveLeadReplyDto } from './dto/save-lead-reply.dto';

const NOT_FOUND = '도입문의를 찾을 수 없습니다';
const STATE = { leadId: true, status: true, updatedAt: true } as const;
const STALE = '그사이 다른 운영자가 저장했습니다. 다시 불러온 뒤 저장해 주세요';

/**
 * 커뮤니티 관리 도입문의 — 목록 · 상세(WHALEERP-332)와 처리중 · 답변 · 내부 메모(WHALEERP-274). 플랫폼 관리자만
 * 쓴다 — 권한은 컨트롤러가 본다. 접수(#295)는 LeadsService 다.
 *
 * 처리 상태가 바뀌면(처리중 전환 · 답변완료) 플랫폼 운영자에게 운영 알림 `NTF_LEAD_ANSWERED` 를 보낸다(운영 정책
 * NTF-01 · 04, 2026-10-14 재영). 커밋 뒤에 응답을 기다리게 하지 않고 보내고, 실패해도 처리는 성공이다.
 *
 * 답변을 문의자 이메일로 보내는 것은 후속 일감 #588 이다 — 문의자용 답변 메일 템플릿이 아직 없다.
 */
@Injectable()
export class LeadsAdminService {
  private readonly logger = new Logger(LeadsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: OpsNotificationService,
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
      select: { status: true, consultedDate: true },
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
    if (!state) throw new ConflictException(STALE);
    // 그사이 누가 끼어들었으면 위 UPDATE 가 0 건이라, 여기 온 요청의 저장 전 상태는 믿을 수 있다.
    if (before.status !== 'ANSWERED')
      void this.notifyStatus(leadId, 'ANSWERED');
    return state;
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
   * 플랫폼 운영자에게 처리 상태 변경을 알린다. 사건 키는 도입문의 ID + 상태라 같은 상태로 두 번 알리지 않는다.
   * 무엇이 실패해도 던지지 않는다(커밋 뒤라 던지면 처리는 됐는데 500 이 된다).
   */
  private async notifyStatus(
    leadId: number,
    status: InquiryStatus,
  ): Promise<void> {
    try {
      const lead = await this.prisma.lead.findUnique({
        where: { leadId },
        select: { contactName: true, industryCode: true, industryDetail: true },
      });
      if (!lead) return;
      await this.ops.notify({
        templateCode: 'NTF_LEAD_ANSWERED',
        variables: {
          처리상태: statusLabel(status),
          도입문의자: `${lead.contactName} · ${await this.industryOf(lead)}`,
        },
        related: { type: 'LEAD', id: leadId },
        link: `/platform/community/leads/${leadId}`,
        eventKey: `${leadId}:${status}`,
        recipients: await platformOperators(this.prisma),
      });
    } catch (e) {
      this.logger.error(
        `lead status notification FAILED lead=${leadId} status=${status}: ${reasonOf(e)}`,
      );
    }
  }

  /** 업종 이름. 기타면 직접 입력한 값, 아니면 공통코드 이름(사용 중지된 코드도 이름은 쓴다), 없으면 코드. */
  private async industryOf(lead: {
    industryCode: string;
    industryDetail: string | null;
  }): Promise<string> {
    if (lead.industryCode === INDUSTRY_OTHER && lead.industryDetail)
      return lead.industryDetail;
    const item = await this.prisma.codeItem.findFirst({
      where: {
        groupCode: 'INDUSTRY',
        itemCode: lead.industryCode,
        bpCode: PLATFORM_BP_CODE,
      },
      select: { label: true },
    });
    return item?.label ?? lead.industryCode;
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
