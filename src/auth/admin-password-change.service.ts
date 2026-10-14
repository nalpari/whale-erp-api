import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ADMIN_SESSION_LIFETIME_MS } from '../admin-session/admin-session.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_PASSWORD_MESSAGES,
  validateAdminPassword,
} from './admin-password-policy';
import { AdminPasswordChangeDto } from './dto/admin-password-change.dto';
import { hashPassword, verifyPassword } from './password';

export const TERMS_REQUIRED_MESSAGE = '필수 약관에 동의해 주세요.';
/** 로그인에 쓴 임시 비밀번호가 더는 없다(만료 · 다시 발급 · 관리자 초기화). 새로 받은 비밀번호로 다시 들어온다. */
export const RELOGIN_REQUIRED_MESSAGE =
  '로그인한 비밀번호가 더 이상 유효하지 않습니다. 다시 로그인해 주세요.';

// 회원가입과 같은 필수 두 가지(1팀 S-VFGQLI).
const REQUIRED_TERMS = ['TERMS_SERVICE', 'PRIVACY_COLLECT'] as const;

/**
 * 강제 비밀번호 변경(1팀 S-VFGQLI). 초기 · 임시 비밀번호로 들어온 계정이 새 비밀번호를 정한다. 플랫폼등록이면서
 * 약관 미동의인 계정은 같은 요청에서 필수 약관 동의까지 받고, 둘은 한 트랜잭션이라 한쪽만 저장되지 않는다.
 *
 * 마이 페이지의 비밀번호 변경(현재 비밀번호 확인)은 이것이 아니다.
 */
@Injectable()
export class AdminPasswordChangeService {
  constructor(private readonly prisma: PrismaService) {}

  async changeRequired(
    adminAccountId: number,
    dto: AdminPasswordChangeDto,
    clientAddress: string | undefined,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 로그인 · 임시 비밀번호 발급과 같은 행 잠금 — 그 사이 다시 발급되면 그 뒤에 본다.
      await tx.$queryRaw`SELECT 1 FROM admin_accounts WHERE admin_account_id = ${adminAccountId} FOR UPDATE`;
      const now = new Date();
      const account = await tx.adminAccount.findUniqueOrThrow({
        where: { adminAccountId },
        select: {
          loginId: true,
          passwordHash: true,
          isPasswordChangeRequired: true,
          joinPathCode: true,
          termsAgreedAt: true,
        },
      });
      if (!account.isPasswordChangeRequired)
        throw new ConflictException('비밀번호 변경 대상이 아닙니다');
      // 로그인에 쓴 초기 · 임시 비밀번호. 만료됐거나, 다시 발급돼 끝났거나, 로그인 중에 관리자가 초기화해 처음부터
      // 없으면 이 세션으로는 바꿀 수 없다 — 다시 로그인하게 한다(갱신도 같은 경우 세션을 끝낸다).
      const issued = await tx.temporaryPassword.findFirst({
        where: {
          adminAccountId,
          usedAt: { not: null },
          invalidatedAt: null,
          isDeleted: false,
          expiresAt: { gt: now },
        },
        orderBy: { issuedAt: 'desc' },
        select: { passwordHash: true },
      });
      if (!issued) throw new UnauthorizedException(RELOGIN_REQUIRED_MESSAGE);

      // 정책 순서(PL-QSBSYY): 조합 · 길이 → 아이디 → 문자 → 현재 → 발급 → 확인.
      const { newPassword } = dto;
      const violation =
        validateAdminPassword(newPassword, account.loginId) ??
        ((await verifyPassword(newPassword, account.passwordHash))
          ? ADMIN_PASSWORD_MESSAGES.sameAsCurrent
          : null) ??
        ((await verifyPassword(newPassword, issued.passwordHash))
          ? ADMIN_PASSWORD_MESSAGES.sameAsIssued
          : null) ??
        (newPassword !== dto.newPasswordConfirm
          ? ADMIN_PASSWORD_MESSAGES.confirmMismatch
          : null);
      if (violation) throw new BadRequestException(violation);

      const needsTerms =
        account.joinPathCode === 'PLATFORM_REGISTERED' &&
        account.termsAgreedAt === null;
      if (needsTerms && dto.isTermsAgreed !== true)
        throw new BadRequestException(TERMS_REQUIRED_MESSAGE);
      const terms = needsTerms ? await this.activeTerms(tx) : null;

      await tx.adminAccount.update({
        where: { adminAccountId },
        data: {
          passwordHash: await hashPassword(newPassword),
          isPasswordChangeRequired: false,
          ...(terms && {
            termsOfUseVersionId: terms.TERMS_SERVICE,
            termsOfUseAgreedAt: now,
            privacyVersionId: terms.PRIVACY_COLLECT,
            privacyAgreedAt: now,
            termsAgreedAt: now,
          }),
        },
      });
      if (terms)
        await tx.termsAgreementLog.createMany({
          data: REQUIRED_TERMS.map((type) => ({
            adminAccountId,
            termsVersionId: terms[type],
            isAgreed: true,
            agreedAt: now,
            channel: 'FIRST_LOGIN' as const,
            clientAddress: clientAddress ?? null,
          })),
        });
      // 쓰지 않은 것까지 모두 끝낸다 — 이후 로그인은 새 비밀번호로만.
      await tx.temporaryPassword.updateMany({
        where: { adminAccountId, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      // 비밀번호 값은 남기지 않는다(PL-QSBSYY 저장과 검증).
      await tx.adminChangeHistory.create({
        data: {
          adminAccountId,
          field: '비밀번호',
          afterValue: '강제 변경',
          changedBy: adminAccountId,
          changedAt: now,
        },
      });
      // 바꿔도 이 기기 · 다른 기기 로그인은 이어진다. 임시 비밀번호 만료에 맞춰 잘려 있던 세션을 지금부터 1시간으로 편다.
      await tx.adminSession.updateMany({
        where: {
          adminAccountId,
          revokedAt: null,
          isDeleted: false,
          expiresAt: { gt: now },
        },
        data: {
          refreshLastUsedAt: now,
          expiresAt: new Date(now.getTime() + ADMIN_SESSION_LIFETIME_MS),
        },
      });
    });
  }

  /** 지금 쓰는 필수 약관 두 버전. 하나라도 없으면 설정 오류라 던진다 — 반쪽 동의를 남기지 않게. */
  private async activeTerms(
    tx: Pick<PrismaService, 'termsVersion'>,
  ): Promise<Record<(typeof REQUIRED_TERMS)[number], number>> {
    const rows = await tx.termsVersion.findMany({
      where: {
        termsTypeCode: { in: [...REQUIRED_TERMS] },
        isActive: true,
        isDeleted: false,
      },
      orderBy: { effectiveDate: 'desc' },
      select: { termsVersionId: true, termsTypeCode: true },
    });
    const pick = (type: string) => {
      const row = rows.find((r) => r.termsTypeCode === type);
      if (!row) throw new Error(`사용 중인 약관 버전이 없습니다: ${type}`);
      return row.termsVersionId;
    };
    return {
      TERMS_SERVICE: pick('TERMS_SERVICE'),
      PRIVACY_COLLECT: pick('PRIVACY_COLLECT'),
    };
  }
}
