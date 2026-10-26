import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { adminWebLink, readOptionalAdminWebUrl } from '../common/admin-web-url';
import { errorKind } from '../common/error-kind';
import { isProduction } from '../config/profile';
import {
  OPTIONAL_MAIL_SERVICE,
  type OptionalMailService,
} from '../mail/mail.module';
import {
  OpsNotificationService,
  reasonOf,
} from '../notifications/ops-notification.service';
import { storeManagers } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';

/** 관리자에게 알리는 근로계약 상태 변화(WHALEERP-154) — 날인 · 거부 · 날인 기한 만료 */
export type ContractStatusEvent = 'SIGNED' | 'REJECTED' | 'EXPIRED';

const TEMPLATES: Record<ContractStatusEvent, { ops: string; mail: string }> = {
  SIGNED: { ops: 'NTF_CONTRACT_SIGNED', mail: 'EMAIL_CONTRACT_SIGNED' },
  REJECTED: { ops: 'NTF_CONTRACT_REJECTED', mail: 'EMAIL_CONTRACT_REJECTED' },
  EXPIRED: { ops: 'NTF_CONTRACT_EXPIRED', mail: 'EMAIL_CONTRACT_EXPIRED' },
};

/** 알림 문장에 넣을 계약 값 */
type Target = {
  contractId: number;
  staffMemberId: number;
  staffName: string;
  storeName: string;
  rejectReason: string | null;
  endDate: Date | null;
};

/**
 * 근로계약을 맡은 사업자 관리자에게 알린다 — 날인 · 거부 · 만료(WHALEERP-154), 갱신 예정(WHALEERP-152). 받는 사람은 그 직원의
 * 근무지를 맡은 관리자(storeManagers — 가맹 점포면 본사 역할은 본사 제공 동의한 직원만)다. 운영 알림함(notify)과 메일
 * (MailService.send)을 따로 부르고 서로의 실패에 묶이지 않는다 — 운영 알림은 메일을 붙이지 않는다(NTF-03). 메일 버튼은
 * 알림함을 거치지 않고 계약 상세(ADMIN_WEB_URL + /contracts/:id)로 바로 가고, 메일로 봐도 알림함 읽음은 맞추지 않는다. 메일
 * 결과는 MailService 가 mail_send_logs 에 남긴다.
 *
 * 업무 트랜잭션이 커밋된 뒤에 부른다 — 알림 쪽 오류가 업무를 되돌리지 않게, 되돌린 업무를 알리지 않게. 무엇이 실패해도 던지지
 * 않는다(로그만). 메일 설정(MAIL_*) · ADMIN_WEB_URL 이 없으면 메일만 건너뛴다.
 */
@Injectable()
export class ContractNoticeService {
  private readonly logger = new Logger(ContractNoticeService.name);
  private readonly adminWebUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: OpsNotificationService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
    config: ConfigService,
  ) {
    this.adminWebUrl = readOptionalAdminWebUrl(
      config.get<string>('ADMIN_WEB_URL'),
      isProduction(),
    );
    if (isProduction() && (!this.mail || !this.adminWebUrl))
      this.logger.error(
        `${!this.mail ? 'MAIL_*' : 'ADMIN_WEB_URL'} 이 비어 있어 근로계약 알림 메일을 보낼 수 없다`,
      );
  }

  /** 날인 · 거부 · 만료. 사건 키는 그 상태 이력 ID 다 — 같은 사건을 두 번 알리지 않는다(dedupe_key) */
  async statusChanged(
    event: ContractStatusEvent,
    contractId: number,
    historyId: number,
  ): Promise<void> {
    const target = await this.targetOf(contractId).catch((e: unknown) => {
      this.logger.error(
        `contract ${event} notice FAILED contract=${contractId}: ${reasonOf(e)}`,
      );
      return null;
    });
    if (!target) return;
    const { ops, mail } = TEMPLATES[event];
    // 거부 운영 알림에는 근무지가 없고 거부 사유는 선택이다 — 템플릿에 없는 변수를 넘기면 렌더러가 던진다
    // 거부 사유는 선택이라 비면 「없음」 — 넘기지 않으면 렌더러가 빈 문자열로 채워 「사유 · 」만 남는다
    const reason: Record<string, string> =
      event === 'REJECTED' ? { 거부사유: target.rejectReason || '없음' } : {};
    const opsVariables: Record<string, string> =
      event === 'REJECTED'
        ? { 직원이름: target.staffName, ...reason }
        : { 직원이름: target.staffName, 근무지: target.storeName };
    await this.send(target, event, String(historyId), {
      ops: { templateCode: ops, variables: opsVariables },
      mail: {
        templateCode: mail,
        variables: {
          직원이름: target.staffName,
          근무지: target.storeName,
          ...reason,
        },
      },
    });
  }

  /** 갱신 예정(계약 종료일 30일 전). 사건 키는 계약 ID — 계약마다 한 번이다(배치가 보낸 때를 계약에 남긴다) */
  async renewalDue(contractId: number): Promise<void> {
    const target = await this.targetOf(contractId).catch((e: unknown) => {
      this.logger.error(
        `contract RENEWAL_DUE notice FAILED contract=${contractId}: ${reasonOf(e)}`,
      );
      return null;
    });
    if (!target?.endDate) return;
    // 템플릿 예시 「11월 6일」 — 날짜만 있는 값이라 UTC 로 읽는다
    const endDate = `${target.endDate.getUTCMonth() + 1}월 ${target.endDate.getUTCDate()}일`;
    const variables = {
      직원이름: target.staffName,
      계약종료일: endDate,
      근무지: target.storeName,
    };
    await this.send(target, 'RENEWAL_DUE', String(contractId), {
      ops: { templateCode: 'NTF_CONTRACT_RENEWAL_DUE', variables },
      mail: { templateCode: 'EMAIL_CONTRACT_RENEWAL_DUE', variables },
    });
  }

  /** 이름은 계약서 값(관리자가 넣은 당사자 이름), 당사자 행이 없는 옛 계약만 직원 레코드 값 — 상세와 같다 */
  private async targetOf(contractId: number): Promise<Target | null> {
    const c = await this.prisma.contract.findUnique({
      where: { contractId },
      select: {
        contractId: true,
        staffMemberId: true,
        storeId: true,
        rejectReason: true,
        endDate: true,
        staffMember: { select: { name: true } },
        contractParty: { select: { enteredName: true } },
      },
    });
    if (!c) return null;
    // stores 는 1팀 테이블이라 Prisma 관계가 없다 — 지운 점포여도 이름은 보인다
    const store = await this.prisma.store.findUnique({
      where: { storeId: c.storeId },
      select: { name: true },
    });
    return {
      contractId: c.contractId,
      staffMemberId: c.staffMemberId,
      staffName: c.contractParty?.enteredName ?? c.staffMember.name,
      storeName: store?.name ?? '',
      rejectReason: c.rejectReason,
      endDate: c.endDate,
    };
  }

  private async send(
    target: Target,
    event: ContractStatusEvent | 'RENEWAL_DUE',
    eventKey: string,
    templates: {
      ops: { templateCode: string; variables: Record<string, string> };
      mail: { templateCode: string; variables: Record<string, string> };
    },
  ): Promise<void> {
    const at = `contract=${target.contractId} event=${event}`;
    const recipients = await storeManagers(
      this.prisma,
      target.staffMemberId,
    ).catch((e: unknown): number[] => {
      this.logger.error(
        `contract notice recipients FAILED ${at}: ${reasonOf(e)}`,
      );
      return [];
    });
    if (recipients.length === 0) {
      this.logger.warn(`contract notice SKIPPED no recipients ${at}`);
      return;
    }
    const path = `/contracts/${target.contractId}`;
    await Promise.all([
      this.ops
        .notify({
          ...templates.ops,
          related: { type: 'CONTRACT', id: target.contractId },
          link: path,
          eventKey,
          recipients,
        })
        .catch((e: unknown) =>
          this.logger.error(`contract notice FAILED ${at}: ${reasonOf(e)}`),
        ),
      this.sendMails(recipients, path, templates.mail, at),
    ]);
  }

  /** 받는 관리자마다 한 통씩. 이메일이 없는 관리자는 건너뛴다. 한 사람의 실패가 다른 사람 메일을 막지 않는다 */
  private async sendMails(
    recipients: number[],
    path: string,
    template: { templateCode: string; variables: Record<string, string> },
    at: string,
  ): Promise<void> {
    const mail = this.mail;
    if (!mail || !this.adminWebUrl) {
      this.logger.warn(
        `contract mail SKIPPED ${!mail ? 'no MAIL_*' : 'no ADMIN_WEB_URL'} ${at}`,
      );
      return;
    }
    const link = adminWebLink(this.adminWebUrl, path);
    const admins = await this.prisma.adminAccount
      .findMany({
        where: { adminAccountId: { in: recipients } },
        select: { adminAccountId: true, email: true },
      })
      .catch(
        (e: unknown): { adminAccountId: number; email: string | null }[] => {
          this.logger.error(`contract mail FAILED ${at}: ${reasonOf(e)}`);
          return [];
        },
      );
    await Promise.all(
      admins.map(async ({ adminAccountId, email }) => {
        if (!email) {
          this.logger.warn(
            `contract mail SKIPPED no email ${at} admin=${adminAccountId}`,
          );
          return;
        }
        await mail
          .send({
            templateCode: template.templateCode,
            to: email,
            variables: { ...template.variables, 링크: link },
            adminAccountId,
          })
          // 메시지는 남기지 않는다 — SMTP 오류에는 받는 주소가 섞인다(문의 답변 메일과 같다)
          .catch((e: unknown) =>
            this.logger.error(
              `contract mail FAILED ${at} admin=${adminAccountId} ${errorKind(e)}`,
            ),
          );
      }),
    );
  }
}
