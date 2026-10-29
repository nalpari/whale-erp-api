import {
  activeAdmin,
  platformOperators,
  storeManagers,
  type RecipientsPrisma,
} from './recipients';
import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';

describe('운영 알림 수신자 판정', () => {
  let prisma: {
    adminAccount: { findMany: jest.Mock; findFirst: jest.Mock };
    store: { findFirst: jest.Mock };
    staffMember: { findUnique: jest.Mock };
  };
  const db = () => prisma as unknown as RecipientsPrisma;

  beforeEach(() => {
    prisma = {
      adminAccount: { findMany: jest.fn(), findFirst: jest.fn() },
      store: { findFirst: jest.fn() },
      staffMember: {
        findUnique: jest.fn().mockResolvedValue({
          storeId: 5,
          account: { isHqSharingConsented: false },
        }),
      },
    };
  });

  describe('platformOperators', () => {
    it('사용 중인 플랫폼 마스터·플랫폼 관리자만 고른다', async () => {
      prisma.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: 1 },
        { adminAccountId: 2 },
      ]);

      await expect(platformOperators(db())).resolves.toEqual([1, 2]);
      expect(prisma.adminAccount.findMany).toHaveBeenCalledWith({
        where: {
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
          roleTypeCode: { in: ['PM', 'PA'] },
        },
        select: { adminAccountId: true },
      });
    });
  });

  describe('storeManagers', () => {
    const managers = [
      { adminAccountId: 10, roleTypeCode: 'BM' },
      { adminAccountId: 11, roleTypeCode: 'BA' },
      { adminAccountId: 12, roleTypeCode: 'FM' },
      { adminAccountId: 13, roleTypeCode: 'FA' },
    ];

    it('직원 근무지 BP 의 사업자 관리자 가운데 전체 점포이거나 그 점포가 매핑된 사람을 고른다', async () => {
      prisma.store.findFirst.mockResolvedValue({
        bpCodeId: 7,
        storeTypeCode: 'DIRECT',
      });
      prisma.adminAccount.findMany.mockResolvedValue(managers.slice(0, 2));

      await expect(storeManagers(db(), 30)).resolves.toEqual([10, 11]);
      expect(prisma.staffMember.findUnique).toHaveBeenCalledWith({
        where: { staffMemberId: 30 },
        select: {
          storeId: true,
          account: {
            select: {
              isHqSharingConsented: true,
              hqSharingConsentVersion: true,
            },
          },
        },
      });
      expect(prisma.store.findFirst).toHaveBeenCalledWith({
        where: { storeId: 5, isDeleted: false },
        select: { bpCodeId: true, storeTypeCode: true, storeStatusCode: true },
      });
      expect(prisma.adminAccount.findMany).toHaveBeenCalledWith({
        where: {
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
          bpCodeId: 7,
          roleTypeCode: { in: ['BM', 'BA', 'FM', 'FA'] },
          OR: [
            { isAllStores: true },
            { storeMappings: { some: { storeId: 5, isDeleted: false } } },
          ],
        },
        select: { adminAccountId: true, roleTypeCode: true },
      });
    });

    it('가맹 점포 직원이 본사 제공에 동의하지 않았으면 BP 마스터·BP 관리자는 빠진다 (NOTIFY-13)', async () => {
      prisma.store.findFirst.mockResolvedValue({
        bpCodeId: 7,
        storeTypeCode: 'FRANCHISE',
      });
      prisma.adminAccount.findMany.mockResolvedValue(managers);

      await expect(storeManagers(db(), 30)).resolves.toEqual([12, 13]);
    });

    it('가맹 점포 직원이 본사 제공에 동의했으면 BP 마스터·BP 관리자도 받는다 (NOTIFY-13)', async () => {
      prisma.staffMember.findUnique.mockResolvedValue({
        storeId: 5,
        account: {
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        },
      });
      prisma.store.findFirst.mockResolvedValue({
        bpCodeId: 7,
        storeTypeCode: 'FRANCHISE',
      });
      prisma.adminAccount.findMany.mockResolvedValue(managers);

      await expect(storeManagers(db(), 30)).resolves.toEqual([10, 11, 12, 13]);
    });

    it('가맹 점포의 가입 전 직원(계정 없음)이면 BP 마스터·BP 관리자는 빠진다 — 동의할 계정이 없다', async () => {
      prisma.staffMember.findUnique.mockResolvedValue({
        storeId: 5,
        account: null,
      });
      prisma.store.findFirst.mockResolvedValue({
        bpCodeId: 7,
        storeTypeCode: 'FRANCHISE',
      });
      prisma.adminAccount.findMany.mockResolvedValue(managers);

      await expect(storeManagers(db(), 30)).resolves.toEqual([12, 13]);
    });

    it('없는 직원 레코드나 지운 점포면 아무도 고르지 않는다', async () => {
      prisma.staffMember.findUnique.mockResolvedValueOnce(null);
      await expect(storeManagers(db(), 30)).resolves.toEqual([]);

      prisma.store.findFirst.mockResolvedValue(null);
      await expect(storeManagers(db(), 30)).resolves.toEqual([]);
      expect(prisma.adminAccount.findMany).not.toHaveBeenCalled();
    });
  });

  describe('activeAdmin', () => {
    it('사용 중인 관리자면 그 한 사람을 돌려준다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({ adminAccountId: 3 });

      await expect(activeAdmin(db(), 3)).resolves.toEqual([3]);
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 3,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: { adminAccountId: true },
      });
    });

    it('사용 안 함·탈퇴·삭제된 관리자면 빈 목록이다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);

      await expect(activeAdmin(db(), 3)).resolves.toEqual([]);
    });
  });
});
