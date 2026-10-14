import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { adminWebLink, readAdminWebUrl } from '../common/admin-web-url';
import {
  memoValue,
  type SaveInternalMemoDto,
} from '../common/save-internal-memo.dto';
import { sameMillisecond } from '../common/updated-at';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import type { MailService } from '../mail/mail.service';
import {
  OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { activeAdmin } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateInquiryReplyDto } from './dto/create-inquiry-reply.dto';
import type { InquiryStateResponseDto } from './dto/inquiry-state.response.dto';

const NOT_FOUND = '문의를 찾을 수 없습니다';
const STALE = '그사이 다른 운영자가 저장했습니다. 다시 불러온 뒤 저장해 주세요';

/**
 * 문의사항 처리 — 처리중 · 답변 · 내부 메모 (WHALEERP-274). 커뮤니티 관리는 플랫폼 관리자만 쓴다 — 권한은
 * 컨트롤러가 본다. 목록 · 상세 조회는 #332 다.
 *
 * 첫 답변이면 등록한 관리자에게 운영 알림과 메일을 따로 보낸다(운영 정책 NTF-03 · 04). 둘 다 커밋 뒤에 보내고
 * 실패해도 답변 저장은 성공이다 — 알림이 못 갔다고 운영자가 답변을 다시 쓰게 하지 않는다.
 */
@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);
  private readonly adminWebUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: OpsNotificationService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: MailService | null,
    config: ConfigService,
  ) {
    this.adminWebUrl = readAdminWebUrl(config.get<string>('ADMIN_WEB_URL'));
  }

  /**
   * 접수 상태만 처리중으로 바꾼다. 바꾼 관리자 · 시각은 상세 처리 이력의 「확인」 줄이다(2026-10-13 재영).
   * 상태를 조건에 넣은 UPDATE 라 둘이 동시에 눌러도 하나만 바뀌고 나머지는 409 다.
   */
  async startProcessing(
    adminId: number,
    inquiryId: number,
  ): Promise<InquiryStateResponseDto> {
    const { count } = await this.prisma.inquiry.updateMany({
      where: { inquiryId, status: 'RECEIVED' },
      data: {
        status: 'IN_PROGRESS',
        processingStartedBy: adminId,
        processingStartedAt: new Date(),
      },
    });
    const current = await this.stateOf(inquiryId);
    if (count === 0)
      throw new ConflictException(
        current.status === 'ANSWERED'
          ? '이미 답변한 문의입니다'
          : '이미 처리중인 문의입니다',
      );
    return current;
  }

  /**
   * 답변을 저장하고 답변 완료로 바꾼다. 처리중을 거치지 않아도 된다. 고칠 때도 새 행을 더해 이전 답변 · 고친
   * 시각 · 고친 운영자가 남고, 상태는 답변 완료 그대로이며 다시 알리지 않는다(CNT-17).
   *
   * 읽은 뒤 아무도 저장하지 않았을 때만 저장한다. `updatedAt` 을 조건에 넣은 UPDATE 라, 동시에 두 답변이 와도
   * PostgreSQL 이 뒤의 것을 행 잠금 뒤 다시 평가해 0 건이 된다 — 그쪽이 409 다.
   */
  async reply(
    adminId: number,
    inquiryId: number,
    dto: CreateInquiryReplyDto,
  ): Promise<InquiryStateResponseDto> {
    const before = await this.prisma.inquiry.findUnique({
      where: { inquiryId },
      select: { status: true, createdBy: true, title: true },
    });
    if (!before) throw new NotFoundException(NOT_FOUND);

    // 응답 상태는 행 잠금을 쥔 채 읽는다. 알림 · 메일(최대 수십 초)을 기다린 뒤에 읽으면 그사이 다른 운영자가
    // 저장한 updatedAt 을 돌려주게 되고, 이 운영자의 다음 저장이 409 없이 남의 저장을 덮는다.
    const state = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.inquiry.updateMany({
        where: { inquiryId, updatedAt: sameMillisecond(dto.updatedAt) },
        data: { status: 'ANSWERED' },
      });
      if (count === 0) throw new ConflictException(STALE);
      await tx.inquiryReply.create({
        data: { inquiryId, body: dto.body, repliedBy: adminId },
      });
      return tx.inquiry.findUniqueOrThrow({
        where: { inquiryId },
        select: { inquiryId: true, status: true, updatedAt: true },
      });
    });

    if (before.status !== 'ANSWERED')
      await this.notifyAnswered(adminId, inquiryId, before);
    return state;
  }

  async saveInternalMemo(
    inquiryId: number,
    dto: SaveInternalMemoDto,
  ): Promise<InquiryStateResponseDto> {
    const { count } = await this.prisma.inquiry.updateMany({
      where: { inquiryId, updatedAt: sameMillisecond(dto.updatedAt) },
      data: { internalMemo: memoValue(dto.internalMemo) },
    });
    const current = await this.stateOf(inquiryId);
    if (count === 0) throw new ConflictException(STALE);
    return current;
  }

  /**
   * 운영 알림과 메일을 따로 보낸다. 커밋 뒤라 무엇이 실패해도 던지지 않는다 — 던지면 답변은 저장됐는데 500 이
   * 되고, 운영자가 같은 updatedAt 으로 다시 보내 409 를 받는다.
   */
  private async notifyAnswered(
    adminId: number,
    inquiryId: number,
    inquiry: { createdBy: number; title: string },
  ): Promise<void> {
    try {
      await this.sendAnswered(adminId, inquiryId, inquiry);
    } catch (e) {
      this.logger.error(
        `inquiry answered notify FAILED inquiry=${inquiryId}: ${reasonOf(e)}`,
      );
    }
  }

  private async sendAnswered(
    adminId: number,
    inquiryId: number,
    inquiry: { createdBy: number; title: string },
  ): Promise<void> {
    // 고객지원 쪽 문의 상세다 — 받는 사람은 문의를 등록한 사업자 관리자다.
    const path = `/support/inquiries/${inquiryId}`;
    await this.ops.notify({
      templateCode: 'NTF_INQUIRY_ANSWERED',
      variables: { 문의제목: inquiry.title },
      related: { type: 'INQUIRY', id: inquiryId },
      link: path,
      eventKey: String(inquiryId),
      recipients: await activeAdmin(this.prisma, inquiry.createdBy),
    });

    const at = `inquiry=${inquiryId}`;
    if (!this.mail || !this.adminWebUrl) {
      this.logger.warn(
        `inquiry answered mail SKIPPED ${!this.mail ? 'no MAIL_*' : 'no ADMIN_WEB_URL'} ${at}`,
      );
      return;
    }
    const to = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId: inquiry.createdBy,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: { email: true },
    });
    if (!to?.email) {
      this.logger.warn(
        `inquiry answered mail SKIPPED inactive author or no email ${at}`,
      );
      return;
    }
    try {
      await this.mail.send({
        templateCode: 'EMAIL_INQUIRY_ANSWERED',
        to: to.email,
        variables: {
          문의제목: inquiry.title,
          링크: adminWebLink(this.adminWebUrl, path),
        },
        adminAccountId: inquiry.createdBy,
        sentBy: adminId,
      });
    } catch (e) {
      // 발송 결과는 mail_send_logs 에 남는다. 여기서는 답변이 성공했다는 것만 지킨다.
      this.logger.error(`inquiry answered mail FAILED ${at}: ${reasonOf(e)}`);
    }
  }

  private async stateOf(inquiryId: number): Promise<InquiryStateResponseDto> {
    const row = await this.prisma.inquiry.findUnique({
      where: { inquiryId },
      select: { inquiryId: true, status: true, updatedAt: true },
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }
}
