import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';

/**
 * 본사 제공 동의 문구의 버전. 문구는 직원 앱에 있고 api 는 버전만 저장한다 — 문구를 바꾸면 앱과 이 값을 같이 고친다
 * (2026-10-20 노영주).
 */
export const HQ_SHARING_CONSENT_VERSION = 'v1.0';

const NOT_AGREED_MESSAGE = '위치정보 수집에 동의한 상태가 아닙니다';

/**
 * 직원 앱 내 정보의 동의 두 가지 (WHALEERP-193). 위치정보 동의(ATT-23 · ATT-26)는 `location_consents` 의 행이고, 철회하지
 * 않은 행이 계정에 하나다. 본사 제공 동의(ATT-30)는 계정 칸 넷이다.
 *
 * 모두 계정 행을 잠근 채 상태를 읽고 쓴다 — 두 기기에서 동시에 누르면 둘 다 「동의 없음」을 읽고 위치정보 동의를 두 행
 * 만들려다 부분 고유 인덱스에 걸려 500 이 된다. 상태가 맞지 않으면(이미 철회 등) 409 이고, 화면은 내 정보를 다시 받는다.
 */
@Injectable()
export class MyConsentService {
  private readonly logger = new Logger(MyConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 위치정보 동의 — 미동의 · 철회 뒤에. 버전은 지금 시행 중인 위치정보 약관(`LOCATION`)이다 */
  agreeLocation(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx) => {
      if (await this.activeLocationConsent(tx, accountId))
        throw new ConflictException('이미 위치정보 수집에 동의했습니다');
      // 공개 약관 API · 회원가입 동의와 같은 규칙 — 시행일이 KST 오늘까지인 것 중 늦은 것. 그래야 화면의 「약관 보기」와
      // 같은 버전에 동의가 남는다.
      const terms = await tx.termsVersion.findFirst({
        where: {
          termsTypeCode: 'LOCATION',
          isActive: true,
          isDeleted: false,
          effectiveDate: { lte: kstToday() },
        },
        orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
        select: { version: true },
      });
      if (!terms) {
        // 운영자가 위치정보 약관을 모두 끄거나 지우면 여기서 500 이다 — 원인을 로그에서 바로 찾게 남긴다.
        this.logger.error(
          `사용 중인 위치정보 약관 버전이 없어 동의를 남기지 못했다 accountId=${accountId}`,
        );
        throw new InternalServerErrorException(
          '지금은 위치정보 동의를 받을 수 없습니다. 관리자에게 문의해 주세요',
        );
      }
      await tx.locationConsent.create({
        data: {
          accountId,
          consentVersion: terms.version,
          agreedAt: new Date(),
        },
      });
    });
  }

  /** 잠시 멈춤 (ATT-26). 멈춘 동안 앱으로 출퇴근을 등록할 수 없다 */
  pauseLocation(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx) => {
      const row = await this.activeLocationConsent(tx, accountId);
      if (!row) throw new ConflictException(NOT_AGREED_MESSAGE);
      if (row.pausedAt) throw new ConflictException('이미 잠시 멈췄습니다');
      await tx.locationConsent.update({
        where: { locationConsentId: row.locationConsentId },
        data: { pausedAt: new Date() },
      });
    });
  }

  /** 다시 켜기 (ATT-26) — 새로 동의하지 않는다 */
  resumeLocation(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx) => {
      const row = await this.activeLocationConsent(tx, accountId);
      if (!row) throw new ConflictException(NOT_AGREED_MESSAGE);
      if (!row.pausedAt) throw new ConflictException('멈춘 상태가 아닙니다');
      await tx.locationConsent.update({
        where: { locationConsentId: row.locationConsentId },
        data: { pausedAt: null },
      });
    });
  }

  /** 철회 (ATT-23). 멈춘 동안에도 된다. 행은 남기고 철회 시각을 채운다 — 다시 동의하면 새 행이다 */
  withdrawLocation(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx) => {
      const row = await this.activeLocationConsent(tx, accountId);
      if (!row) throw new ConflictException(NOT_AGREED_MESSAGE);
      await tx.locationConsent.update({
        where: { locationConsentId: row.locationConsentId },
        data: { withdrawnAt: new Date() },
      });
    });
  }

  /**
   * 본사 제공 동의 — 처음이든 철회 뒤든. 앞의 동의 · 철회를 덮는다(A안, 2026-10-13 재영). 계정에 하나라 소속 가맹 점포
   * 모두에 같이 적용된다
   */
  agreeHqSharing(accountId: number): Promise<void> {
    return this.locked(accountId, async (tx, account) => {
      if (account.isHqSharingConsented)
        throw new ConflictException('이미 본사 제공에 동의했습니다');
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
        throw new ConflictException('본사 제공에 동의한 상태가 아닙니다');
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
      account: { isHqSharingConsented: boolean },
    ) => Promise<void>,
  ): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      const account = await tx.account.findUniqueOrThrow({
        where: { accountId },
        select: { status: true, isHqSharingConsented: true },
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
      select: { locationConsentId: true, pausedAt: true },
    });
  }
}
