import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CodesService } from '../codes/codes.service';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from './access-messages';
import { AdminLoginInfoResponseDto } from './dto/admin-login-info.response.dto';
import { buildMenuTree } from './menu-tree';

/**
 * 관리자 웹이 화면을 그릴 정보(`GET /auth/admin/login-info`). 부르는 시점의 값을 만든다 — 저장해 두지 않는다.
 * 관리자 웹은 로그인 직후에 받고, 그 뒤에는 로그인 정보 버전(`version`)이 바뀌었을 때만 다시 받는다(2026-11-02).
 * 업무 API 의 판정은 이 값이 아니라 요청마다 현재 DB 로 한다.
 */
@Injectable()
export class AdminLoginInfoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
    private readonly codes: CodesService,
  ) {}

  /**
   * 관리 점포만(`GET /auth/admin/me/stores`) — 로그인 정보의 stores 와 같은 판정 · 모양이다. 관리자 웹이 점포 목록
   * 버전(`GET /bp-codes/:id/stores-version`)이 바뀌었을 때 메뉴 · 공통코드까지 다시 받지 않으려고 부른다.
   */
  async stores(
    adminAccountId: number,
  ): Promise<AdminLoginInfoResponseDto['stores']> {
    const account = await this.prisma.adminAccount.findUnique({
      where: { adminAccountId },
      select: { isDeleted: true, bpCode: { select: { isPlatform: true } } },
    });
    if (!account || account.isDeleted)
      throw new UnauthorizedException('만료되었거나 종료된 접속입니다.');
    return account.bpCode.isPlatform
      ? []
      : this.scope.listStores(adminAccountId);
  }

  /**
   * 로그인 정보 버전(`GET /auth/admin/me/login-info-version`) — 이전 값과 다르면 관리자 웹이 login-info 를 다시 받는다.
   * 재료는 내 계정 · 소속 BP 의 `updatedAt`, 권한 그룹 · 그 그룹 메뉴 권한(지운 행 포함) · 메뉴 전체(지운 행 포함)의
   * 행마다 `updatedAt` · `isDeleted`. 최근 시각 · 개수로 줄이지 않는 이유는 점포 목록 버전과 같다 — `@updatedAt` 은
   * 커밋이 아니라 쿼리를 만들 때 시각이라, 늦게 커밋된 수정이 먼저 커밋된 것보다 이른 시각을 가질 수 있다.
   *
   * 공통코드(`SERVICE` 사용중지로 빠지는 메뉴 포함)는 담지 않는다 — 늦어도 다음 로그인 때, 다른 이유로 버전이 바뀌면
   * 그때 함께 반영된다. 계정은 사용 중 · 지우지 않은 것만 읽어, 상태 확인과 해시에 쓰는 `updatedAt` 이 한 조회에서
   * 나온다. 읽은 뒤 바뀐 상태는 다음 호출에서 403 이다.
   */
  async version(adminAccountId: number): Promise<{ version: string }> {
    const account = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { updatedAt: true, roleGroupId: true, bpCodeId: true },
    });
    if (!account) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const [group, groupMenus, menus, bp] = await Promise.all([
      this.prisma.roleGroup.findUnique({
        where: { roleGroupId: account.roleGroupId },
        select: { updatedAt: true, isDeleted: true },
      }),
      this.prisma.roleGroupMenu.findMany({
        where: { roleGroupId: account.roleGroupId },
        select: MENU_ROW_SELECT,
        orderBy: { menuId: 'asc' },
      }),
      this.prisma.menu.findMany({
        select: MENU_ROW_SELECT,
        orderBy: { menuId: 'asc' },
      }),
      this.prisma.bpCode.findUnique({
        where: { bpCodeId: account.bpCodeId },
        select: { updatedAt: true },
      }),
    ]);
    const hash = createHash('sha256').update(
      [
        `account:${account.updatedAt.getTime()}`,
        `group:${group ? `${group.updatedAt.getTime()}.${group.isDeleted ? 1 : 0}` : '-'}`,
        `groupMenus:${rowsKey(groupMenus)}`,
        `menus:${rowsKey(menus)}`,
        `bp:${bp?.updatedAt.getTime() ?? '-'}`,
      ].join('|'),
    );
    // 내부 값(id · 시각)을 그대로 내보내지 않고 짧은 지문으로 — front 는 비교만 한다.
    return { version: hash.digest('base64url').slice(0, 22) };
  }

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
        accountStatusCode: true,
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
      throw new UnauthorizedException('만료되었거나 종료된 접속입니다.');
    // 사용중지는 세션이 남는다(가드는 상태를 보지 않는다). 탈퇴는 그때 세션을 끊어 보통 401 이 먼저 나지만 같은
    // 판정으로 막는다. 관리자 웹은 이 경로의 이 문구에 로그아웃시킨다(front 요청, 2026-11-02 — 다른 업무 경로에서는
    // 안내 뒤 이전 화면).
    if (account.accountStatusCode !== 'ACTIVE')
      throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);

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
          serviceCode: true,
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

const MENU_ROW_SELECT = {
  menuId: true,
  updatedAt: true,
  isDeleted: true,
} as const;

/** 행마다 `menuId.updatedAt(ms).isDeleted` 를 잇는다 — 한 행만 바뀌어도 값이 달라진다. */
function rowsKey(
  rows: { menuId: number; updatedAt: Date; isDeleted: boolean }[],
): string {
  return rows
    .map((r) => `${r.menuId}.${r.updatedAt.getTime()}.${r.isDeleted ? 1 : 0}`)
    .join(',');
}
