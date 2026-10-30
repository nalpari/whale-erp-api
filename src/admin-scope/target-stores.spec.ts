import { BadRequestException } from '@nestjs/common';
import { targetStores } from './target-stores';

describe('targetStores (탭 BP 의 관리 점포, WHALEERP-637)', () => {
  const stores = { roleTypeCode: 'PM', stores: [] };
  const setup = (isPlatform: boolean | null) => {
    const scope = { getManageableStores: jest.fn().mockResolvedValue(stores) };
    const prisma = {
      bpCode: {
        findFirst: jest
          .fn()
          .mockResolvedValue(isPlatform === null ? null : { isPlatform }),
      },
    };
    const run = (bp?: { bpCodeId: number; isPlatformCaller: boolean }) =>
      targetStores(scope as never, prisma as never, 5, bp, '고르세요.');
    return { scope, prisma, run };
  };

  it('BP · 가맹 계정은 BP 를 묻지 않고 그 BP 로 관리 점포를 찾는다', async () => {
    const { scope, prisma, run } = setup(false);
    const bp = { bpCodeId: 3, isPlatformCaller: false };
    await expect(run(bp)).resolves.toBe(stores);
    expect(prisma.bpCode.findFirst).not.toHaveBeenCalled();
    expect(scope.getManageableStores).toHaveBeenCalledWith(5, bp);
  });

  it('플랫폼 계정이 고객 BP 를 고르면 그 BP 의 점포다', async () => {
    const { scope, run } = setup(false);
    const bp = { bpCodeId: 9, isPlatformCaller: true };
    await expect(run(bp)).resolves.toBe(stores);
    expect(scope.getManageableStores).toHaveBeenCalledWith(5, bp);
  });

  it('플랫폼 계정이 헤더 없이 부르면(대상이 플랫폼 BP) 범위를 보기 전에 400', async () => {
    const { scope, run } = setup(true);
    await expect(run({ bpCodeId: 1, isPlatformCaller: true })).rejects.toThrow(
      new BadRequestException('고르세요.'),
    );
    expect(scope.getManageableStores).not.toHaveBeenCalled();
  });

  it('bp 가 없으면 계정의 소속 BP 다(옮기기 전 동작)', async () => {
    const { scope, run } = setup(null);
    await expect(run()).resolves.toBe(stores);
    expect(scope.getManageableStores).toHaveBeenCalledWith(5, undefined);
  });
});
