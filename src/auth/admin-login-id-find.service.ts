import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminLoginIdFindDto } from './dto/admin-login-id-find.dto';
import { AdminLoginIdFindResponseDto } from './dto/admin-login-id-find.response.dto';

export const LOGIN_ID_NOT_FOUND_MESSAGE =
  '입력하신 정보와 일치하는 계정을 찾을 수 없습니다.';

/**
 * 앞 2자와 뒤 1자만 보이고 나머지는 실제 길이만큼 `*` 다. 예: hanwhale1 → ha******1.
 * 아이디는 영문 · 숫자 4~20자(admin_accounts_login_id_format)라 그보다 짧으면 던진다 — 가릴 글자가 없어 다 드러난다.
 */
export function maskLoginId(loginId: string): string {
  if (loginId.length < 4) throw new Error('가릴 수 없는 아이디: 4자 미만');
  return (
    loginId.slice(0, 2) + '*'.repeat(loginId.length - 3) + loginId.slice(-1)
  );
}

/**
 * 관리자 웹 아이디 찾기(front okf auth.md 「계정 찾기」). 이름 · 이메일이 맞는 사용 중 계정의 아이디를 가려서
 * 화면에만 보인다 — 메일로 보내지 않는다. 사용 중 계정 사이에서는 이메일이 고유해 많아야 하나다.
 */
@Injectable()
export class AdminLoginIdFindService {
  constructor(private readonly prisma: PrismaService) {}

  async find(dto: AdminLoginIdFindDto): Promise<AdminLoginIdFindResponseDto> {
    const account = await this.prisma.adminAccount.findFirst({
      where: {
        name: dto.name,
        email: dto.email,
        accountStatusCode: 'ACTIVE',
        isDeleted: false,
      },
      select: { loginId: true },
    });
    // 미사용 · 탈퇴 · 삭제 계정과 맞아도 같은 404 다 — 응답으로 계정 존재가 드러나지 않게.
    if (!account) throw new NotFoundException(LOGIN_ID_NOT_FOUND_MESSAGE);
    return { maskedLoginId: maskLoginId(account.loginId) };
  }
}
