import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CodesService } from '../codes/codes.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminLoginInfoResponseDto } from './dto/admin-login-info.response.dto';
import { buildMenuTree } from './menu-tree';

/**
 * 관리자 웹이 화면을 그릴 정보(`GET /auth/admin/login-info`). 부르는 시점의 값을 만든다 — 저장해 두지 않는다.
 * 「바뀐 권한 · 메뉴 · 점포는 다시 로그인할 때 반영」은 관리자 웹이 로그인 직후에만 부르는 것으로 지킨다
 * (front okf auth.md, 2026-10-13). 업무 API 의 판정은 이 값이 아니라 요청마다 현재 DB 로 한다.
 */
@Injectable()
export class AdminLoginInfoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
    private readonly codes: CodesService,
  ) {}

  async get(adminAccountId: number): Promise<AdminLoginInfoResponseDto> {
    const account = await this.prisma.adminAccount.findUnique({
      where: { adminAccountId },
      select: {
        adminAccountId: true,
        loginId: true,
        name: true,
        email: true,
        roleTypeCode: true,
        roleGroupId: true,
        isPasswordChangeRequired: true,
        joinPathCode: true,
        termsAgreedAt: true,
        isDeleted: true,
        bpCode: {
          select: {
            bpCodeId: true,
            bpCode: true,
            tradeName: true,
            isPlatform: true,
          },
        },
      },
    });
    // 세션은 살아 있어도(삭제 뒤 최대 1시간) 삭제된 계정의 화면 정보는 주지 않는다.
    if (!account || account.isDeleted)
      throw new UnauthorizedException('만료되었거나 종료된 접속입니다');

    const temporary = account.isPasswordChangeRequired
      ? await this.prisma.temporaryPassword.findFirst({
          where: {
            adminAccountId,
            usedAt: { not: null },
            invalidatedAt: null,
            isDeleted: false,
          },
          orderBy: { issuedAt: 'desc' },
          select: { expiresAt: true },
        })
      : null;

    const codes = await this.codes.forBp(account.bpCode.bpCode);
    // 사용중지한 서비스의 메뉴는 사용자 화면에서 빠진다(front system.md, S-UQPNIH).
    const services = (codes.SERVICE ?? []).map((s) => s.value);
    const [menus, permissions] = await Promise.all([
      this.prisma.menu.findMany({
        where: {
          isDeleted: false,
          status: 'ACTIVE',
          serviceCode: { in: services },
        },
        select: {
          menuId: true,
          parentMenuId: true,
          menuCode: true,
          name: true,
          url: true,
          depth: true,
          sortOrder: true,
        },
      }),
      this.prisma.roleGroupMenu.findMany({
        where: {
          roleGroupId: account.roleGroupId,
          isDeleted: false,
          roleGroup: { isDeleted: false },
        },
        select: {
          menuId: true,
          isReadable: true,
          isCreatable: true,
          isUpdatable: true,
          isDeletable: true,
        },
      }),
    ]);

    return {
      account: {
        adminAccountId: account.adminAccountId,
        loginId: account.loginId,
        name: account.name,
        email: account.email,
        roleTypeCode: account.roleTypeCode,
        bp: account.bpCode,
        isPasswordChangeRequired: account.isPasswordChangeRequired,
        temporaryPasswordExpiresAt: temporary?.expiresAt ?? null,
        // 시스템에서 만든 계정(플랫폼등록)은 첫 로그인 때 약관 동의를 함께 받는다(front auth.md, S-VFGQLI).
        isTermsAgreementRequired:
          account.joinPathCode === 'PLATFORM_REGISTERED' &&
          account.termsAgreedAt === null,
      },
      menus: buildMenuTree(menus, permissions),
      // 플랫폼 사용자는 점포 매핑 없이 BP 를 골라 일한다(front system.md). 고객 BP 점포 범위는 WHALEERP-301.
      stores: account.bpCode.isPlatform
        ? []
        : await this.scope.listStores(adminAccountId),
      codes,
    };
  }
}
