import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  memoValue,
  type SaveInternalMemoDto,
} from '../common/save-internal-memo.dto';
import { sameMillisecond } from '../common/updated-at';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import type { LeadStateResponseDto } from './dto/lead-state.response.dto';
import type { SaveLeadReplyDto } from './dto/save-lead-reply.dto';

const NOT_FOUND = '도입문의를 찾을 수 없습니다';
const STATE = { leadId: true, status: true, updatedAt: true } as const;
const STALE = '그사이 다른 운영자가 저장했습니다. 다시 불러온 뒤 저장해 주세요';

/**
 * 도입문의 처리 — 처리중 · 답변 · 내부 메모 (WHALEERP-274). 플랫폼 관리자만 쓴다 — 권한은 컨트롤러가 본다.
 * 접수(#295)는 LeadsService, 목록 · 상세는 #332 다.
 *
 * ponytail: 답변을 문의자 이메일로 보내지 않는다 — 쓸 메일 템플릿이 없다(`EMAIL_LEAD_ANSWERED` 는 꺼져 있고 운영자용
 * 「처리 상태 변경」 문구다). 템플릿이 정해지면 reply 의 커밋 뒤에 MailService.send 를 더한다.
 */
@Injectable()
export class LeadsAdminService {
  constructor(private readonly prisma: PrismaService) {}

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
    if (state) return state;
    const current = await this.stateOf(leadId);
    throw new ConflictException(
      current.status === 'ANSWERED'
        ? '이미 답변한 도입문의입니다'
        : '이미 처리중인 도입문의입니다',
    );
  }

  /**
   * 답변을 저장하고 답변 완료로 바꾼다. 답변자 · 답변 시각은 마지막 저장의 것이다. 처음 답변 완료가 되는 날을
   * 상담 완료일로 남긴다 — 1년 뒤 파기의 기준이라(CNT-12) 고칠 때 다시 쓰지 않는다. 날짜는 한국 날짜다.
   */
  async reply(
    adminId: number,
    leadId: number,
    dto: SaveLeadReplyDto,
  ): Promise<LeadStateResponseDto> {
    const before = await this.prisma.lead.findUnique({
      where: { leadId },
      select: { status: true },
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
        ...(before.status !== 'ANSWERED' && { consultedDate: kstToday(now) }),
      },
    );
    if (!state) throw new ConflictException(STALE);
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

  private async stateOf(leadId: number): Promise<LeadStateResponseDto> {
    const row = await this.prisma.lead.findUnique({
      where: { leadId },
      select: STATE,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }
}
