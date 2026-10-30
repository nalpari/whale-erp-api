import { BadRequestException } from '@nestjs/common';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  AdminScopeService,
  ManageableStores,
} from './admin-scope.service';

/**
 * 탭 BP(`@TargetBp()`)의 관리 점포 — 급여명세서 · 출퇴근 기록 관리자 경로가 쓴다(WHALEERP-637). 플랫폼 계정이 헤더
 * (X-Bp-Code-Id) 없이 부르면 대상이 자기 플랫폼 BP 라 볼 점포가 없으니 고르라고 400 이다(근로계약 `checkTargetBp` 와
 * 같다). 헤더로 온 플랫폼 BP 는 가드가 404 로 막으므로 플랫폼 BP 면 헤더가 없던 것이다. BP · 가맹 계정은 가드가 소속 BP 로
 * 정해 묻지 않는다. `bp` 가 없으면 계정의 소속 BP 다(단위 테스트 · 옮기기 전 동작). 계정이 사용 중이 아니면 null.
 */
export async function targetStores(
  scope: AdminScopeService,
  prisma: PrismaService,
  adminAccountId: number,
  bp: TargetBpContext | undefined,
  missingMessage: string,
): Promise<ManageableStores | null> {
  if (bp?.isPlatformCaller) {
    const target = await prisma.bpCode.findFirst({
      where: { bpCodeId: bp.bpCodeId },
      select: { isPlatform: true },
    });
    if (target?.isPlatform) throw new BadRequestException(missingMessage);
  }
  return scope.getManageableStores(adminAccountId, bp);
}
