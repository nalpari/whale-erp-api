import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { LocationConsentAction, Prisma } from '@prisma/client';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import {
  HQ_SHARING_CONSENT_VERSION,
  type HqSharingAccount,
  hqSharingAgreedOf,
} from '../admin-scope/hq-sharing';
import { PrismaService } from '../prisma/prisma.service';
import { currentLocationTermsVersion } from './location-terms';

const NOT_AGREED_MESSAGE = '위치정보 수집에 동의한 상태가 아닙니다.';

/**
 * 직원 앱 내 정보의 동의 두 가지 (WHALEERP-193). 위치정보 동의(ATT-23 · ATT-26)는 `location_consents` 의 행이고, 철회하지
 * 않은 행이 계정에 하나다. 본사 제공 동의(ATT-30)는 계정 칸 넷이다.
 *
 * 모두 계정 행을 잠근 채 상태를 읽고 쓴다 — 두 기기에서 동시에 누르면 둘 다 「동의 없음」을 읽고 위치정보 동의를 두 행
 * 만들려다 부분 고유 인덱스에 걸려 500 이 된다. 상태가 맞지 않으면(이미 철회 등) 409 이고, 화면은 내 정보를 다시 받는다.
 *
 * 위치정보 동의 · 철회 · 잠시 멈춤 · 다시 켜기는 할 때마다 `location_consent_histories` 에 한 줄 남긴다(운영 정책 ATT-26,
 * 2026-10-23 재영) — 같은 트랜잭션 · 같은 시각. 확인자료(`location_access_logs`)의 수집 · 이용 · 제공과는 따로다.
 */
/** 위치정보 동의 이력 한 줄(ATT-26) */
const history = (
  tx: Prisma.TransactionClient,
  locationConsentId: number,
  action: LocationConsentAction,
  occurredAt: Date,
) =>
  tx.locationConsentHistory.create({
    data: { locationConsentId, action, occurredAt },
  });

@Injectable()
export class MyConsentService {
  private readonly logger = new Logger(MyConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 위치정보 동의 — 미동의 · 철회 뒤에, 그리고 동의한 약관 버전이 지금 시행 중인 것과 다를 때(ATT-23 — 버전이 바뀌면 다시
   * 받는다). 버전은 지금 시행 중인 위치정보 약관(`LOCATION`)이다. 다시 받을 때는 앞 행을 닫고(withdrawn_at) 새 행을 만든다 —
   * 버전마다 동의한 기록이 남는다. 닫은 행은 철회와 같은 꼴이지만 바로 뒤에 살아 있는 새 행이 있어 상태는 동의다.
   * 일시 중지 중이었으면 새 행도 멈춘 채로 둔다 — 다시 켜기는 직원이 따로 고른다(ATT-26).
   * `shownVersion`(화면이 동의 시트에 보여 준 버전, 보인 약관이 없었으면 null)은 시행 중인 버전과 같아야 한다 — 시트를 연 사이
   * 약관이 바뀌었으면 409 로 거절해 보인 고지와 남는 버전이 어긋나지 않게 한다(WHALEERP-628).
   */
  agreeLocation(accountId: number, shownVersion: string | null): Promise<void> {
    return this.locked(accountId, async (tx) => {
      const version = await currentLocationTermsVersion(tx);
      if (!version) {
        // 운영자가 위치정보 약관을 모두 끄거나 지우면 여기서 500 이다 — 원인을 로그에서 바로 찾게 남긴다.
        this.logger.error(
          `사용 중인 위치정보 약관 버전이 없어 동의를 남기지 못했다 accountId=${accountId}`,
        );
        throw new InternalServerErrorException(
          '지금은 위치정보 동의를 받을 수 없습니다. 관리자에게 문의해 주세요.',
        );
      }
      if (shownVersion !== version)
        throw new ConflictException(
          '그사이 위치정보 약관이 바뀌었습니다. 바뀐 약관을 확인하고 다시 동의해 주세요.',
        );
      const active = await this.activeLocationConsent(tx, accountId);
      if (active?.consentVersion === version)
        throw new ConflictException('이미 위치정보 수집에 동의했습니다.');
      const now = new Date();
      if (active) {
        await tx.locationConsent.update({
          where: { locationConsentId: active.locationConsentId },
          data: { withdrawnAt: now },
        });
        await history(tx, active.locationConsentId, 'WITHDRAW', now);
      }
      const { locationConsentId } = await tx.locationConsent.create({
        data: {
          accountId,
          consentVersion: version,
          agreedAt: now,
          pausedAt: active?.pausedAt ?? null,
        },
        select: { locationConsentId: true },
      });
      await history(tx, locationConsentId, 'AGREE', now);
    });
  }

  /** 잠시 멈춤 (ATT-26). 멈춘 동안 앱으로 출퇴근을 등록할 수 없다 */
  pauseLocation(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx) => {
      const row = await this.activeLocationConsent(tx, accountId);
      if (!row) throw new ConflictException(NOT_AGREED_MESSAGE);
      if (row.pausedAt) throw new ConflictException('이미 잠시 멈췄습니다.');
      const now = new Date();
      await tx.locationConsent.update({
        where: { locationConsentId: row.locationConsentId },
        data: { pausedAt: now },
      });
      await history(tx, row.locationConsentId, 'PAUSE', now);
    });
  }

  /** 다시 켜기 (ATT-26) — 새로 동의하지 않는다 */
  resumeLocation(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx) => {
      const row = await this.activeLocationConsent(tx, accountId);
      if (!row) throw new ConflictException(NOT_AGREED_MESSAGE);
      if (!row.pausedAt) throw new ConflictException('멈춘 상태가 아닙니다.');
      await tx.locationConsent.update({
        where: { locationConsentId: row.locationConsentId },
        data: { pausedAt: null },
      });
      await history(tx, row.locationConsentId, 'RESUME', new Date());
    });
  }

  /** 철회 (ATT-23). 멈춘 동안에도 된다. 행은 남기고 철회 시각을 채운다 — 다시 동의하면 새 행이다 */
  withdrawLocation(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx) => {
      const row = await this.activeLocationConsent(tx, accountId);
      if (!row) throw new ConflictException(NOT_AGREED_MESSAGE);
      const now = new Date();
      await tx.locationConsent.update({
        where: { locationConsentId: row.locationConsentId },
        data: { withdrawnAt: now },
      });
      await history(tx, row.locationConsentId, 'WITHDRAW', now);
    });
  }

  /**
   * 본사 제공 동의 — 처음이든 철회 뒤든, 더는 받아 주지 않는 문구 버전에 동의했던 뒤든(ATT-30). 앞의 동의 · 철회를
   * 덮는다(A안, 2026-10-13 재영). 계정에 하나라 소속 가맹 점포 모두에 같이 적용된다
   */
  agreeHqSharing(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx, account) => {
      if (hqSharingAgreedOf(account))
        throw new ConflictException('이미 본사 제공에 동의했습니다.');
      await tx.account.update({
        where: { accountId },
        data: {
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: new Date(),
          hqSharingWithdrawnAt: null,
        },
      });
    });
  }

  /** 본사 제공 동의 철회. 동의한 버전 · 시각은 남긴다 — CHECK `accounts_hq_sharing_not_consented_fields` 가 요구한다 */
  withdrawHqSharing(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx, account) => {
      if (!account.isHqSharingConsented)
        throw new ConflictException('본사 제공에 동의한 상태가 아닙니다.');
      await tx.account.update({
        where: { accountId },
        data: { isHqSharingConsented: false, hqSharingWithdrawnAt: new Date() },
      });
    });
  }

  private locked(
    accountId: number,
    work: (
      tx: Prisma.TransactionClient,
      account: HqSharingAccount,
    ) => Promise<void>,
  ): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      const account = await tx.account.findUniqueOrThrow({
        where: { accountId },
        select: {
          status: true,
          isHqSharingConsented: true,
          hqSharingConsentVersion: true,
        },
      });
      if (account.status === 'WITHDRAWN')
        throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
      await work(tx, account);
    });
  }

  private activeLocationConsent(
    tx: Prisma.TransactionClient,
    accountId: number,
  ) {
    return tx.locationConsent.findFirst({
      where: { accountId, withdrawnAt: null },
      select: { locationConsentId: true, consentVersion: true, pausedAt: true },
    });
  }
}
