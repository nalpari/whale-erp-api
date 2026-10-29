import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { isPlatformRole } from '../admin-scope/admin-scope.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { callerOf, type HolidayCaller } from './bp-holiday-access';

/** BP 휴일 관리 메뉴(MN000015). 가드처럼 컨트롤러 경로로 찾는다 — 메뉴 URL 이 권한 키다. */
export const BP_HOLIDAY_MENU_URL = '/bp-holidays';

/**
 * 휴일을 다루는 관리자를 읽는다 — 권한 유형 · 다루는 BP · 맡은 점포 · 메뉴 권한. 메뉴 권한은 가드가 경로마다 이미
 * 봤다. 여기서 다시 읽는 것은 목록 · 상세의 「할 수 있는 것」에 쓰기 위해서다(가드는 그 경로의 동작 하나만 본다).
 *
 * 점포 범위는 점포 정보 관리(store-management scopeOf)와 같은 판정이다(WHALEERP-565) — 플랫폼 계정은 고른 BP 의
 * 모든 점포, 그 밖에는 전체 점포가 아니면 admin_store_mappings 의 점포.
 */
@Injectable()
export class BpHolidayCallerService {
  constructor(private readonly prisma: PrismaService) {}

  async load(
    adminAccountId: number,
    bp: TargetBpContext,
  ): Promise<HolidayCaller> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: {
        adminAccountId: true,
        bpCodeId: true,
        roleGroupId: true,
        roleTypeCode: true,
        isAllStores: true,
        bpCode: { select: { isPlatform: true } },
      },
    });
    if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const isPlatform = isPlatformRole(
      admin.roleTypeCode,
      admin.bpCode.isPlatform,
    );
    // 가드는 헤더가 없으면 소속 BP(플랫폼 BP)를 정한다 — 플랫폼 BP 에는 점포 · 휴일이 없으니 고르라고 답한다.
    if (isPlatform && bp.bpCodeId === admin.bpCodeId)
      throw new BadRequestException('휴일을 볼 BP 를 골라 주세요.');
    const [menu, mappings] = await Promise.all([
      this.prisma.roleGroupMenu.findFirst({
        where: {
          roleGroupId: admin.roleGroupId,
          isDeleted: false,
          roleGroup: { isDeleted: false },
          menu: {
            url: BP_HOLIDAY_MENU_URL,
            isDeleted: false,
            status: 'ACTIVE',
          },
        },
        select: { isCreatable: true, isUpdatable: true, isDeletable: true },
      }),
      isPlatform || admin.isAllStores
        ? Promise.resolve<{ storeId: number }[]>([])
        : this.prisma.adminStoreMapping.findMany({
            where: { adminAccountId, isDeleted: false },
            select: { storeId: true },
          }),
    ]);
    return callerOf({
      adminAccountId,
      targetBpCodeId: isPlatform ? bp.bpCodeId : admin.bpCodeId,
      roleTypeCode: admin.roleTypeCode,
      isPlatform,
      isAllStores: admin.isAllStores,
      mappedStoreIds: mappings.map((m) => m.storeId),
      rights: {
        create: menu?.isCreatable ?? false,
        update: menu?.isUpdatable ?? false,
        delete: menu?.isDeletable ?? false,
      },
    });
  }
}
