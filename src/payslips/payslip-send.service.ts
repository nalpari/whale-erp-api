import {
  BadGatewayException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayslipStatus, Prisma } from '@prisma/client';
import {
  AdminScopeService,
  consentOpensStore,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { readStaffAppUrl } from '../auth/staff-app-url';
import { noticeStaff } from '../notifications/staff-notice';
import { containsText } from '../common/contains-text';
import { errorKind } from '../common/error-kind';
import { isSameMillisecond, sameMillisecond } from '../common/updated-at';
import { isProduction } from '../config/profile';
import {
  OPTIONAL_MAIL_SERVICE,
  type OptionalMailService,
} from '../mail/mail.module';
import { isMailTransportError } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { PayslipStatusChangeDto } from './dto/payslip-edit.dto';
import { SendPayslipsDto } from './dto/payslip-send.dto';
import {
  PayslipSendFailure,
  PayslipSendResultDto,
} from './dto/payslip-send.response.dto';
import { PayslipDetailResponseDto } from './dto/payslip.response.dto';
import { stale, statusConflict } from './payslip-edit.service';
import { PayslipListService } from './payslip-list.service';
import { PAYSLIP_NOT_FOUND_MESSAGE } from './payslip-menu';
import { monthRange, pickedStores, storeNames } from './payslip-shared';

/** 직원 앱의 명세서 상세 경로(직원 근무 앱 `/pay/[payslipId]`). */
const STAFF_APP_PAYSLIP_PATH = '/pay/';

const TARGET_SELECT = {
  payslipId: true,
  status: true,
  updatedAt: true,
  storeId: true,
  periodStartDate: true,
  staffMember: {
    select: {
      name: true,
      account: {
        select: {
          accountId: true,
          email: true,
          status: true,
          ...HQ_SHARING_SELECT.account.select,
        },
      },
    },
  },
  // 전에 이메일로 보낸 적이 있으면(확정 취소 뒤 다시 확정) 재발송 템플릿이다
  payslipDispatches: {
    where: { channel: 'EMAIL', status: 'SUCCEEDED' },
    take: 1,
    select: { payslipDispatchId: true },
  },
} satisfies Prisma.PayslipSelect;
type Target = Prisma.PayslipGetPayload<{ select: typeof TARGET_SELECT }>;

const FAILURE_MESSAGE: Record<PayslipSendFailure, string> = {
  MAIL_NOT_CONFIGURED: '메일 설정(MAIL_*)이 없어 보낼 수 없습니다.',
  APP_URL_NOT_CONFIGURED:
    '직원 앱 주소(STAFF_APP_URL)가 없어 보낼 수 없습니다.',
  NO_EMAIL: '직원 앱 계정이 없어(가입 전 · 탈퇴) 보낼 곳이 없습니다.',
  CONFLICT:
    '그사이 다른 관리자가 이 급여명세서를 고쳤거나 보내고 있습니다. 화면을 새로 고친 뒤 다시 해 주세요.',
  // SMTP 시간 초과면 메일이 나갔을 수도 있어 「이력부터 확인」을 앞세운다
  MAIL_FAILED:
    '메일을 보내지 못했습니다. 발송 이력을 확인한 뒤 다시 보내 주세요.',
  MASKED: '본사 제공 동의가 없는 직원이라 보낼 수 없습니다.',
};

type Delivery = { ok: true } | { ok: false; reason: PayslipSendFailure };

/**
 * 발송 중 표시가 이보다 오래되면 끊긴 것(처리 중 서버 종료 등)으로 보고 다시 잡게 둔다. SMTP 연결 · 응답 제한이 각 30초라
 * 정상 발송은 이 안에 끝난다.
 */
const SENDING_STALE_MS = 5 * 60_000;

/**
 * 급여명세서 발송 · 재발송 (WHALEERP-231). 확정한 명세서를 직원 앱 계정의 이메일로 보낸다(EMAIL_PAYSLIP_SENT, 전에 보낸 적이
 * 있으면 EMAIL_PAYSLIP_RESENT) — 메일의 버튼은 직원 앱 명세서 상세(`/pay/{id}`)로 간다. 발송 완료로 옮기면서 직원 알림(알림함 줄과
 * 앱 푸시 발송 대기, PUSH_PAYSLIP_SENT · RESENT, #259)도 만든다 — 실제 앱 푸시는 아직 없다(기기 토큰 · FCM, #261 · #321).
 * 급여 지급은 하지 않는다.
 *
 * 한 장을 보내는 순서: 읽은 상태 · updatedAt 을 조건으로, 발송 중 표시(sendingStartedAt)가 빈 것만 표시를 채워 잡는다
 * (같은 명세서를 두 요청이 함께 보내지 않게 — 잡은 뒤에 새로 읽은 요청도 표시 때문에 잡지 못한다) →
 * 트랜잭션 밖에서 메일(되돌릴 수 없어 커밋 뒤에 보낸다, mail.md) → 성공이면 발송 완료 · 발송 이력(성공) · 처리 이력(발송),
 * 실패면 발송 이력(실패)만 — 상태는 확정 그대로라 다시 보낼 수 있다. 메일이 나갔는데 그사이 확정이 취소됐거나 취소 뒤
 * 다시 확정됐으면(잡은 updatedAt 이 바뀜) 상태는 두고 이력만 남긴다. 어느 쪽이든 끝나면 발송 중 표시를 비운다 — 단 메일은
 * 나갔는데 기록 쓰기가 실패하면 비우지 않는다(메일이 간 줄 모르고 바로 다시 보내지 않게, 5분 뒤 풀린다).
 */
@Injectable()
export class PayslipSendService {
  private readonly logger = new Logger(PayslipSendService.name);
  private readonly appUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
    private readonly detail: PayslipListService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
    config: ConfigService,
  ) {
    this.appUrl = readStaffAppUrl(
      config.get<string>('STAFF_APP_URL'),
      isProduction(),
    );
  }

  /** 발송 — 확정만. */
  send(
    adminAccountId: number,
    payslipId: number,
    dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto | null> {
    return this.sendOne(adminAccountId, payslipId, dto, 'CONFIRMED');
  }

  /** 재발송 — 발송 완료만. 재발송 템플릿(문구는 처음 발송과 같다, 쟁점 NOTI-6 · #605). */
  resend(
    adminAccountId: number,
    payslipId: number,
    dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto | null> {
    return this.sendOne(adminAccountId, payslipId, dto, 'SENT');
  }

  /**
   * 그 달 확정 명세서 일괄 발송(목록 「확정 N건 발송」). 점포 · 직원명은 목록과 같은 조건이다. 한 장씩 보내 일부가 실패해도
   * 보낸 것은 그대로이고, 실패한 것은 이유와 함께 failed 에 담는다. 본사 역할에게 가려지는 명세서는 보내지 않고 이름 없이
   * MASKED 로 센다(목록의 확정 건수에 들어 있어서). 관리자 계정이 사용 중이 아니면 null(403).
   */
  async sendMany(
    adminAccountId: number,
    dto: SendPayslipsDto,
  ): Promise<PayslipSendResultDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) return null;
    const result: PayslipSendResultDto = { sent: [], failed: [] };
    const stores = await pickedStores(
      this.prisma,
      manageable.stores,
      dto.storeIds,
      dto.storeTypes,
    );
    if (stores.length === 0) return result;

    const storeById = new Map(stores.map((s) => [s.storeId, s]));
    const hidden = (storeId: number, consented: boolean) =>
      hidesPersonalData(
        manageable.roleTypeCode,
        storeById.get(storeId),
        consented,
      );
    const ids = (list: typeof stores) => list.map((s) => s.storeId);
    const open = stores.filter((s) => !hidden(s.storeId, false));
    // 동의한 직원만 보이는 점포 — 폐점한 가맹 점포는 동의해도 가려 어느 갈래에도 들지 않는다
    const masking = stores.filter((s) =>
      consentOpensStore(manageable.roleTypeCode, s),
    );
    const name = dto.staffName
      ? { staffMember: { name: containsText(dto.staffName) } }
      : null;
    // 직원명으로 거르면 가린 직원은 목록 · 건수에서 빠진다 — 같은 대상을 보낸다
    const scopeWhere: Prisma.PayslipWhereInput =
      name && open.length < stores.length
        ? {
            OR: [
              { storeId: { in: ids(open) } },
              {
                storeId: { in: ids(masking) },
                staffMember: HQ_SHARING_CONSENTED,
              },
            ],
          }
        : { storeId: { in: ids(stores) } };
    const rows = await this.prisma.payslip.findMany({
      where: {
        AND: [
          scopeWhere,
          { periodStartDate: monthRange(dto.month) },
          { status: 'CONFIRMED' },
          ...(name ? [name] : []),
        ],
      },
      orderBy: [{ staffMember: { name: 'asc' } }, { payslipId: 'asc' }],
      select: TARGET_SELECT,
    });
    if (rows.length === 0) return result;

    const names = await storeNames(
      this.prisma,
      rows.map((r) => r.storeId),
    );
    const masked: PayslipSendResultDto['failed'] = [];
    for (const r of rows) {
      if (hidden(r.storeId, hqSharingConsentedOf(r.staffMember))) {
        masked.push({
          payslipId: null,
          staffName: null,
          reason: 'MASKED',
          message: FAILURE_MESSAGE.MASKED,
        });
        continue;
      }
      const delivery = await this.deliver(adminAccountId, r, names(r.storeId));
      if (delivery.ok)
        result.sent.push({
          payslipId: r.payslipId,
          staffName: r.staffMember.name,
        });
      else
        result.failed.push({
          payslipId: r.payslipId,
          staffName: r.staffMember.name,
          reason: delivery.reason,
          message: FAILURE_MESSAGE[delivery.reason],
        });
    }
    result.failed.push(...masked);
    return result;
  }

  private async sendOne(
    adminAccountId: number,
    payslipId: number,
    dto: PayslipStatusChangeDto,
    from: PayslipStatus,
  ): Promise<PayslipDetailResponseDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    const target =
      manageable &&
      (await this.prisma.payslip.findFirst({
        where: {
          payslipId,
          storeId: { in: manageable.stores.map((s) => s.storeId) },
        },
        select: TARGET_SELECT,
      }));
    if (
      !manageable ||
      !target ||
      hidesPersonalData(
        manageable.roleTypeCode,
        manageable.stores.find((s) => s.storeId === target.storeId),
        hqSharingConsentedOf(target.staffMember),
      )
    )
      throw new NotFoundException(PAYSLIP_NOT_FOUND_MESSAGE);
    if (target.status !== from) throw statusConflict(target.status);
    if (!isSameMillisecond(target.updatedAt, dto.updatedAt)) throw stale();

    const names = await storeNames(this.prisma, [target.storeId]);
    const delivery = await this.deliver(
      adminAccountId,
      target,
      names(target.storeId),
    );
    if (!delivery.ok) {
      const body = (status: HttpStatus, error: string) => ({
        statusCode: status,
        error,
        code: delivery.reason,
        message: FAILURE_MESSAGE[delivery.reason],
      });
      switch (delivery.reason) {
        case 'MAIL_NOT_CONFIGURED':
        case 'APP_URL_NOT_CONFIGURED':
          throw new ServiceUnavailableException(
            body(HttpStatus.SERVICE_UNAVAILABLE, 'Service Unavailable'),
          );
        case 'NO_EMAIL':
          throw new UnprocessableEntityException(
            body(HttpStatus.UNPROCESSABLE_ENTITY, 'Unprocessable Entity'),
          );
        case 'CONFLICT':
          // 단건은 읽은 값이 같아도 다른 요청이 보내는 중이면 여기로 온다 — 「고쳤습니다」만으로는 설명이 안 된다
          throw new ConflictException({
            ...body(HttpStatus.CONFLICT, 'Conflict'),
            code: 'PAYSLIP_STALE',
          });
        default:
          throw new BadGatewayException({
            ...body(HttpStatus.BAD_GATEWAY, 'Bad Gateway'),
            code: 'SEND_FAILED',
          });
      }
    }
    return this.detail.findOne(adminAccountId, payslipId);
  }

  /** 한 장 보내기. 설정 · 받는 곳이 없으면 쓰지 않고 실패. 그 밖은 클래스 주석의 순서. */
  private async deliver(
    adminAccountId: number,
    t: Target,
    storeName: string,
  ): Promise<Delivery> {
    if (!this.mail) return { ok: false, reason: 'MAIL_NOT_CONFIGURED' };
    if (!this.appUrl) return { ok: false, reason: 'APP_URL_NOT_CONFIGURED' };
    const account = t.staffMember.account;
    if (!account || account.status === 'WITHDRAWN')
      return { ok: false, reason: 'NO_EMAIL' };

    // 잡을 때 발송 중 표시(sendingStartedAt)를 채운다. updatedAt 만 바꾸면 잡은 뒤에 새로 읽은 요청(다시 누름 · 다른 관리자)이
    // 같은 값으로 다시 잡아 메일이 두 통 간다. 표시가 남은 명세서는 잡지 못한다 — 끝내지 못하고 끊긴 것은 SENDING_STALE_MS 뒤에 풀린다.
    const claimedAt = new Date();
    const { count } = await this.prisma.payslip.updateMany({
      where: {
        payslipId: t.payslipId,
        status: t.status,
        updatedAt: sameMillisecond(t.updatedAt.toISOString()),
        OR: [
          { sendingStartedAt: null },
          {
            sendingStartedAt: {
              lt: new Date(claimedAt.getTime() - SENDING_STALE_MS),
            },
          },
        ],
      },
      data: { updatedAt: claimedAt, sendingStartedAt: claimedAt },
    });
    if (count === 0) return { ok: false, reason: 'CONFLICT' };

    const again = t.status === 'SENT' || t.payslipDispatches.length > 0;
    const at = `payslip=${t.payslipId}`;
    try {
      await this.mail.send({
        templateCode: again ? 'EMAIL_PAYSLIP_RESENT' : 'EMAIL_PAYSLIP_SENT',
        to: account.email,
        variables: {
          직원이름: t.staffMember.name,
          근무지: storeName,
          // 문구의 달은 급여 기간 시작 달이다(NTF-20)
          급여월: `${t.periodStartDate.getUTCMonth() + 1}월`,
          링크: new URL(
            `${STAFF_APP_PAYSLIP_PATH}${t.payslipId}`,
            this.appUrl,
          ).toString(),
        },
        sentBy: adminAccountId,
      });
    } catch (e) {
      // SMTP 단계 실패와 보내기 전에 막힌 실패(템플릿 꺼짐 · 주소 형식 등 — 다시 눌러도 풀리지 않는다)를 로그에서 가른다
      if (isMailTransportError(e))
        this.logger.warn(`payslip mail FAILED(SMTP) ${at} ${errorKind(e)}`);
      else
        this.logger.error(
          `payslip mail NOT SENT(template · address) ${at} ${errorKind(e)}`,
        );
      // 잡을 때 바꾼 updatedAt 을 되돌리고 발송 중 표시를 비운다 — 그대로 두면 화면이 가진 값이 낡아 다시 보내기가 늘
      // 409 PAYSLIP_STALE 이 된다. 그사이 다른 요청이 고쳤으면(updatedAt 이 claimedAt 이 아니면) 표시만 비운다.
      await this.release(t, claimedAt).catch((releaseError: unknown) =>
        this.logger.error(
          `payslip claim not released ${at} ${errorKind(releaseError)}`,
        ),
      );
      await this.prisma.payslipDispatch
        .create({
          data: {
            payslipId: t.payslipId,
            channel: 'EMAIL',
            status: 'FAILED',
            sentBy: adminAccountId,
          },
        })
        .catch((logError: unknown) =>
          this.logger.error(
            `payslip dispatch FAILED row not written ${at} ${errorKind(logError)}`,
          ),
        );
      return { ok: false, reason: 'MAIL_FAILED' };
    }

    // 메일은 나갔다 — 여기서 실패해도 「보내지 않음」으로 돌리지 않고 남긴다(다시 누르면 두 번 간다)
    try {
      await this.prisma.$transaction(async (tx) => {
        // 잡은 그대로일 때만 옮긴다. 그사이 확정 취소 · 수정 · 다시 확정이 있었으면 updatedAt 이 바뀌어 0건 —
        // 보낸 메일과 다른 값이 직원 앱에 발송 완료로 보이지 않게 상태는 두고 이력만 남긴다.
        const { count: moved } = await tx.payslip.updateMany({
          where: {
            payslipId: t.payslipId,
            status: { in: ['CONFIRMED', 'SENT'] },
            updatedAt: claimedAt,
          },
          data: { status: 'SENT', sendingStartedAt: null },
        });
        if (moved === 0) {
          this.logger.warn(
            `payslip mail SENT but status not moved (changed while sending) ${at}`,
          );
          await tx.payslip.updateMany({
            where: { payslipId: t.payslipId, sendingStartedAt: claimedAt },
            data: { sendingStartedAt: null },
          });
        }
        await tx.payslipDispatch.create({
          data: {
            payslipId: t.payslipId,
            channel: 'EMAIL',
            status: 'SUCCEEDED',
            sentBy: adminAccountId,
          },
        });
        const changed = moved > 0 && t.status === 'CONFIRMED';
        await tx.payslipLog.create({
          data: {
            payslipId: t.payslipId,
            logType: 'SEND',
            fromStatus: changed ? 'CONFIRMED' : null,
            toStatus: changed ? 'SENT' : null,
            summary: `${again ? '재발송' : '발송'} · 이메일`,
            changedBy: adminAccountId,
          },
        });
        // 직원 알림(#259) — 알림함 줄과 앱 푸시 발송 대기. 상태가 발송 완료로 옮겨졌을 때만이다(그사이 바뀐 명세서를 가리키지
        // 않게). 다시 보내도 처음 발송과 같은 문구다(NOTI-6). 퇴직한 직원도 받는다(NOTI-5)
        if (moved > 0)
          await noticeStaff(tx, this.logger, {
            templateCode: again ? 'PUSH_PAYSLIP_RESENT' : 'PUSH_PAYSLIP_SENT',
            accountId: account.accountId,
            relatedType: 'PAYSLIP',
            relatedId: t.payslipId,
            variables: {
              급여월: `${t.periodStartDate.getUTCMonth() + 1}월`,
              근무지: storeName,
            },
          });
      });
    } catch (e) {
      // 발송 중 표시는 비우지 않는다 — 메일이 간 명세서를 바로 다시 보내지 않게 SENDING_STALE_MS 동안 막아 둔다
      this.logger.error(
        `payslip mail SENT but records not written ${at} ${errorKind(e)}`,
      );
    }
    return { ok: true };
  }

  /** 메일이 나가지 않았을 때 잡기를 푼다 — 잡은 그대로면 updatedAt 도 되돌리고, 그사이 바뀌었으면 발송 중 표시만 비운다. */
  private async release(t: Target, claimedAt: Date): Promise<void> {
    const { count } = await this.prisma.payslip.updateMany({
      where: { payslipId: t.payslipId, updatedAt: claimedAt },
      data: { updatedAt: t.updatedAt, sendingStartedAt: null },
    });
    if (count === 0)
      await this.prisma.payslip.updateMany({
        where: { payslipId: t.payslipId, sendingStartedAt: claimedAt },
        data: { sendingStartedAt: null },
      });
  }
}
