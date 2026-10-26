import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_PASSWORD_MESSAGES,
  validateAdminPassword,
} from './admin-password-policy';
import { AdminMyPasswordChangeDto } from './dto/admin-my-password-change.dto';
import { hashPassword, verifyPassword } from './password';

/**
 * 내 비밀번호 변경(MY PAGE, 1팀 S-PTWREE). 로그인한 관리자 본인이 현재 비밀번호를 확인한 뒤 새 비밀번호로
 * 바꾼다. 강제 비밀번호 변경(admin-password-change.service.ts AdminPasswordChangeService)과 달리 초기 ·
 * 임시 비밀번호 발급 이력을 보지 않고, 약관 동의도 다루지 않는다.
 *
 * 바꿔도 이 기기 · 다른 기기의 로그인은 모두 이어지고 재로그인을 요구하지 않는다(S-PTWREE outcome) — 3팀
 * 직원 앱의 같은 종류 변경(my-password.service.ts MyPasswordService)은 다른 기기 세션을 끊지만, 1팀은
 * 그렇게 정하지 않았다. adminSession 을 건드리지 않는 것은 그래서다.
 */
@Injectable()
export class AdminMyPasswordService {
  constructor(private readonly prisma: PrismaService) {}

  async change(
    adminAccountId: number,
    dto: AdminMyPasswordChangeDto,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 로그인 · 비밀번호 초기화와 같은 행 잠금 — 그 사이 바뀌면 그 뒤 값으로 본다.
      await tx.$queryRaw`SELECT 1 FROM admin_accounts WHERE admin_account_id = ${adminAccountId} FOR UPDATE`;
      const account = await tx.adminAccount.findUniqueOrThrow({
        where: { adminAccountId },
        select: { loginId: true, passwordHash: true },
      });

      // 정책 순서(1팀 PL-QSBSYY) + S-PTWREE action 순서: 현재 비밀번호 → 조합·길이 → 아이디 → 문자 →
      // 현재와 동일 → 확인. 현재 비밀번호를 가장 먼저 본다 — 틀린 사람에게 새 비밀번호 규칙까지
      // 알려줄 이유가 없다.
      if (!(await verifyPassword(dto.currentPassword, account.passwordHash)))
        throw new BadRequestException(ADMIN_PASSWORD_MESSAGES.currentMismatch);

      const { newPassword } = dto;
      const violation =
        validateAdminPassword(newPassword, account.loginId) ??
        ((await verifyPassword(newPassword, account.passwordHash))
          ? ADMIN_PASSWORD_MESSAGES.sameAsCurrent
          : null) ??
        (newPassword !== dto.newPasswordConfirm
          ? ADMIN_PASSWORD_MESSAGES.confirmMismatch
          : null);
      if (violation) throw new BadRequestException(violation);

      await tx.adminAccount.update({
        where: { adminAccountId },
        data: { passwordHash: await hashPassword(newPassword) },
      });
      // 비밀번호 값은 남기지 않는다(PL-QSBSYY 저장과 검증) — field 만 '비밀번호'로 남긴다.
      await tx.adminChangeHistory.create({
        data: {
          adminAccountId,
          field: '비밀번호',
          afterValue: '변경',
          changedBy: adminAccountId,
          changedAt: new Date(),
        },
      });
    });
  }
}
