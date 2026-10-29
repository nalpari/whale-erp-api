import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_PASSWORD_MESSAGES,
  validateAdminPassword,
} from './admin-password-policy';
import { AdminMyPasswordChangeDto } from './dto/admin-my-password-change.dto';
import { hashPassword, verifyPassword } from './password';

const NOT_FOUND = '관리자 계정을 찾을 수 없습니다.';

/**
 * 내 비밀번호 변경(마이페이지, 1팀 S-PTWREE). 로그인한 관리자 본인이 현재 비밀번호를 확인한 뒤 새 비밀번호로
 * 바꾼다. 강제 비밀번호 변경(admin-password-change.service.ts AdminPasswordChangeService)과 달리 초기
 * 비밀번호 · isPasswordChangeRequired · 약관 동의는 다루지 않는다 — 다만 살아있는 찾기용 임시 비밀번호를
 * 모두 끝내는 것은 강제 경로와 같다(아래).
 *
 * 바꿔도 이 기기 · 다른 기기의 로그인은 모두 이어지고 재로그인을 요구하지 않는다(S-PTWREE outcome) — 3팀
 * 직원 앱의 같은 종류 변경(my-password.service.ts MyPasswordService)은 다른 기기 세션을 끊지만, 1팀은
 * 그렇게 정하지 않았다. adminSession 을 건드리지 않는 것은 그래서다.
 */
@Injectable()
export class AdminMyPasswordService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 현재 비밀번호 확인(회원 탈퇴 1단계, S-JHQQNR). 맞으면 아무것도 쓰지 않는다. 비교 · 문구는 change · 탈퇴
   * 실행(admin-withdrawal.service.ts)과 같다. 로그인 실패 횟수 · 잠금에는 넣지 않는다 — 시도는 경로의 계정 축
   * 한도가 막는다.
   */
  async verify(adminAccountId: number, currentPassword: string): Promise<void> {
    const account = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false },
      select: { passwordHash: true },
    });
    if (!account) throw new NotFoundException(NOT_FOUND);
    if (!(await verifyPassword(currentPassword, account.passwordHash)))
      throw new BadRequestException(ADMIN_PASSWORD_MESSAGES.currentMismatch);
  }

  async change(
    adminAccountId: number,
    dto: AdminMyPasswordChangeDto,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 로그인 · 비밀번호 초기화와 같은 행 잠금 — 그 사이 바뀌면 그 뒤 값으로 본다.
      await tx.$queryRaw`SELECT 1 FROM admin_accounts WHERE admin_account_id = ${adminAccountId} FOR UPDATE`;
      // isDeleted 를 거른다 — admin-profile.service.ts find() 와 같다. 접근 토큰을 쥔 세션은 계정이 삭제돼도
      // 최대 1시간 살아있어(admin-session.service.ts findActive 가 계정 상태를 보지 않는다), 그 사이 지운
      // 행의 비밀번호를 바꿀 수 있었다(naming.md "모든 조회에 is_deleted = false 를 건다", 코드 리뷰로 찾음,
      // 2026-10-26).
      const account = await tx.adminAccount.findFirst({
        where: { adminAccountId, isDeleted: false },
        select: { loginId: true, passwordHash: true },
      });
      if (!account) throw new NotFoundException(NOT_FOUND);

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

      const now = new Date();
      await tx.adminAccount.update({
        where: { adminAccountId },
        data: { passwordHash: await hashPassword(newPassword) },
      });
      // 쓰지 않은 것까지 모두 끝낸다 — 강제 비밀번호 변경(admin-password-change.service.ts)과 같은 규칙(코드
      // 리뷰로 찾음, 2026-10-26). 일반 로그인(admin-auth.service.ts completeSuccess)은 쓰지 않은 것만 끝내지만,
      // 그건 이미 한 번 써서 포렌식 강제 변경이 켜져 있는 임시 비밀번호까지 죽이면 그 로그인 자체가 막히기
      // 때문이다 — 본인이 지금 비밀번호를 직접 바꾸는 이 경로엔 그 제약이 없으니, 이미 쓴 임시 비밀번호가
      // 남은 시간 동안 로그인(→ 강제 변경 재진입)을 여는 구멍을 막는다.
      await tx.temporaryPassword.updateMany({
        where: { adminAccountId, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      // 비밀번호 값은 남기지 않는다(PL-QSBSYY 저장과 검증) — field 만 '비밀번호'로 남긴다.
      await tx.adminChangeHistory.create({
        data: {
          adminAccountId,
          field: '비밀번호',
          afterValue: '변경',
          changedBy: adminAccountId,
          changedAt: now,
        },
      });
    });
  }
}
