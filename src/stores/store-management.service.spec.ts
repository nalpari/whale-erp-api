// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { MenuCaller } from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateStoreDto, UpdateStoreDto } from './dto/save-store.dto';
import { STORE_BUSINESS_VERIFIER } from './store-business-verifier';
import { StoreManagementService } from './store-management.service';

const BM: MenuCaller = {
  adminAccountId: 7,
  roleTypeCode: 'BM',
  roleGroupId: 2,
};
const PM: MenuCaller = {
  adminAccountId: 1,
  roleTypeCode: 'PM',
  roleGroupId: 1,
};
const FM: MenuCaller = {
  adminAccountId: 9,
  roleTypeCode: 'FM',
  roleGroupId: 3,
};
const UPDATED_AT = '2026-10-14T01:00:00.000Z';

/** 상세 · 수정 · 삭제가 읽는 점포 한 행 */
function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    storeId: 11,
    storeCode: 'ST000011',
    name: '모리커피 서초점',
    storeTypeCode: 'DIRECT',
    storeStatusCode: 'NOT_OPERATING',
    closedDate: null,
    bpCodeId: 3,
    phone: '0212345678',
    zipCode: '06611',
    address: '서울특별시 서초구 서초대로 1',
    addressDetail: '1층',
    latitude: new Prisma.Decimal('37.491234'),
    longitude: new Prisma.Decimal('127.012345'),
    isLocationApplied: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date(UPDATED_AT),
    updatedBy: null,
    bpCode: {
      bpCode: 'BP000003',
      tradeName: '모리커피',
      accountStatusCode: 'ACTIVE',
    },
    creator: { name: '김본사' },
    updater: null,
    businessProfile: null,
    floors: [],
    ...overrides,
  };
}

function updateDto(overrides: Partial<UpdateStoreDto> = {}): UpdateStoreDto {
  return {
    name: '모리커피 서초점',
    phone: '0212345678',
    zipCode: '06611',
    address: '서울특별시 서초구 서초대로 1',
    addressDetail: '1층',
    latitude: 37.491234,
    longitude: 127.012345,
    isLocationApplied: true,
    floors: [],
    business: {},
    storeStatus: 'NOT_OPERATING',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('StoreManagementService', () => {
  let service: StoreManagementService;
  let verifier: { verify: jest.Mock } | null;
  let prisma: Record<string, any>;

  async function build() {
    const module = await Test.createTestingModule({
      providers: [
        StoreManagementService,
        { provide: PrismaService, useValue: prisma },
        { provide: STORE_BUSINESS_VERIFIER, useValue: verifier },
      ],
    }).compile();
    service = module.get(StoreManagementService);
  }

  beforeEach(async () => {
    verifier = { verify: jest.fn().mockResolvedValue(true) };
    prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({
          bpCodeId: 3,
          isAllStores: true,
          roleTypeCode: 'BM',
        }),
      },
      bpCode: {
        findFirst: jest.fn().mockResolvedValue({ accountStatusCode: 'ACTIVE' }),
      },
      store: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(storeRow()),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ storeId: 50, storeCode: data.storeCode }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      staffMember: { groupBy: jest.fn().mockResolvedValue([]) },
      contract: { count: jest.fn().mockResolvedValue(0) },
      storeBusinessProfile: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      storeFloor: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminStoreMapping: { create: jest.fn().mockResolvedValue({}) },
      storeChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$transaction = jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    );
    await build();
  });

  function historyRows(): {
    field: string;
    beforeValue: unknown;
    afterValue: unknown;
  }[] {
    return prisma.storeChangeHistory.createMany.mock.calls.flatMap(
      ([{ data }]) => data,
    );
  }

  describe('list', () => {
    it('BP 전체 점포 계정은 자기 BP 의 지우지 않은 점포를, 기본으로 미운영 · 운영만, 등록일 최신순(+ id)으로 본다', async () => {
      prisma.store.findMany.mockResolvedValue([
        {
          storeId: 11,
          storeCode: 'ST000011',
          name: '서초점',
          storeTypeCode: 'DIRECT',
          storeStatusCode: 'OPERATING',
          bpCodeId: 3,
          phone: null,
          address: '서울특별시 서초구 서초대로 1',
          createdAt: new Date('2026-10-01T00:00:00Z'),
          bpCode: { tradeName: '모리커피' },
          businessProfile: { bizRegistrationNumber: '1234567890' },
        },
      ]);
      prisma.store.count.mockResolvedValue(1);
      prisma.staffMember.groupBy.mockResolvedValue([
        { storeId: 11, _count: { _all: 4 } },
      ]);

      await expect(
        service.list(BM, { page: 2, pageSize: 20 }),
      ).resolves.toEqual({
        items: [
          {
            storeId: 11,
            storeCode: 'ST000011',
            name: '서초점',
            storeTypeCode: 'DIRECT',
            storeStatusCode: 'OPERATING',
            bpCodeId: 3,
            bpTradeName: '모리커피',
            bizRegistrationNumber: '1234567890',
            phone: null,
            region: '서울특별시 서초구',
            staffCount: 4,
            createdAt: new Date('2026-10-01T00:00:00Z'),
          },
        ],
        total: 1,
      });

      const args = prisma.store.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        AND: [
          { isDeleted: false, bpCodeId: 3 },
          {
            storeStatusCode: { in: ['NOT_OPERATING', 'OPERATING'] },
            storeTypeCode: { in: ['DIRECT', 'FRANCHISE'] },
          },
        ],
      });
      expect(args.orderBy).toEqual([
        { createdAt: 'desc' },
        { storeId: 'desc' },
      ]);
      expect(args.skip).toBe(20);
      expect(args.take).toBe(20);
      expect(prisma.store.count.mock.calls[0][0]).toEqual({
        where: args.where,
      });
      expect(prisma.staffMember.groupBy.mock.calls[0][0].where).toEqual({
        storeId: { in: [11] },
        employmentStatus: 'EMPLOYED',
      });
    });

    it('일부 점포 계정은 매핑된 점포만 본다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        isAllStores: false,
        roleTypeCode: 'FM',
      });
      await service.list(FM, { page: 1, pageSize: 20 });
      expect(prisma.store.findMany.mock.calls[0][0].where.AND[0]).toEqual({
        isDeleted: false,
        bpCodeId: 3,
        adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
      });
    });

    it('플랫폼 계정은 모든 BP 의 점포를 보고, 조건을 그대로 건다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 1,
        isAllStores: true,
        roleTypeCode: 'PM',
      });
      await service.list(PM, {
        page: 1,
        pageSize: 20,
        bpCodeId: 3,
        storeIds: [11, 12],
        keyword: '서초',
        bizRegistrationNumber: '12345',
        statuses: ['CLOSED'],
        storeTypes: ['FRANCHISE'],
      });
      expect(prisma.store.findMany.mock.calls[0][0].where).toEqual({
        AND: [
          { isDeleted: false },
          {
            storeStatusCode: { in: ['CLOSED'] },
            storeTypeCode: { in: ['FRANCHISE'] },
            storeId: { in: [11, 12] },
            bpCodeId: 3,
            OR: [
              { name: { contains: '서초', mode: 'insensitive' } },
              { storeCode: { contains: '서초', mode: 'insensitive' } },
            ],
            businessProfile: {
              is: { bizRegistrationNumber: { contains: '12345' } },
            },
          },
        ],
      });
    });

    it('사용 중인 관리자 계정이 아니면 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(
        service.list(BM, { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('detail', () => {
    it('범위 밖이거나 지운 점포는 404', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      await expect(service.detail(BM, 11)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.store.findFirst.mock.calls[0][0].where).toEqual({
        AND: [{ isDeleted: false, bpCodeId: 3 }, { storeId: 11 }],
      });
    });

    it('좌표는 숫자로, 사업자정보와 전환 가능 여부를 함께 준다', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          floors: [
            {
              storeFloorId: 5,
              floorTypeCode: 'GROUND',
              floorNumber: 1,
              floorAreaPyeong: new Prisma.Decimal('18.0'),
              floorAreaSqm: null,
              seatCount: 24,
            },
          ],
        }),
      );
      prisma.staffMember.groupBy.mockResolvedValue([
        { storeId: 11, _count: { _all: 2 } },
      ]);
      const detail = await service.detail(BM, 11);
      expect(detail).toMatchObject({
        storeCode: 'ST000011',
        latitude: 37.491234,
        longitude: 127.012345,
        bpAccountStatusCode: 'ACTIVE',
        staffCount: 2,
        createdByName: '김본사',
        updatedByName: null,
        floors: [
          {
            storeFloorId: 5,
            floorTypeCode: 'GROUND',
            floorNumber: 1,
            floorAreaPyeong: 18,
            floorAreaSqm: null,
            seatCount: 24,
          },
        ],
        business: { isVerified: false, bizRegistrationNumber: null },
        transitions: {
          missingForOperation: ['BUSINESS_VERIFICATION'],
          inProgressContractCount: 0,
          canClose: true,
          canDelete: true,
          isSubscriptionChecked: false,
        },
      });
      expect(prisma.contract.count.mock.calls[0][0]).toEqual({
        where: {
          storeId: 11,
          status: {
            in: ['DRAFT', 'PENDING_SEND', 'PENDING_SIGNATURE', 'SIGNED'],
          },
        },
      });
    });

    it('소속 BP 가 미사용이면 운영 · 폐점 · 삭제를 할 수 없다고 준다', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          bpCode: {
            bpCode: 'BP000003',
            tradeName: '모리커피',
            accountStatusCode: 'INACTIVE',
          },
        }),
      );
      const { transitions } = await service.detail(BM, 11);
      expect(transitions).toMatchObject({
        canClose: false,
        canDelete: false,
      });
      expect(transitions.missingForOperation).toContain('BP_INACTIVE');
    });
  });

  describe('create', () => {
    const dto: CreateStoreDto = {
      storeTypeCode: 'DIRECT',
      name: '서초점',
      isLocationApplied: true,
      floors: [],
      business: {},
    };

    it('가맹 역할은 권한과 상관없이 403 이고 아무것도 쓰지 않는다', async () => {
      await expect(service.create(FM, dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.store.create).not.toHaveBeenCalled();
    });

    it('점포코드를 마지막 코드(지운 것 포함) 다음으로 잠근 채 채번하고, 늘 미운영으로 만든다', async () => {
      prisma.store.findFirst.mockResolvedValue({ storeCode: 'ST000042' });
      await expect(service.create(BM, dto)).resolves.toEqual({
        storeId: 50,
        storeCode: 'ST000043',
      });
      expect(prisma.store.findFirst.mock.calls[0][0]).toEqual({
        orderBy: { storeCode: 'desc' },
        select: { storeCode: true },
      });
      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(prisma.store.create.mock.calls[0][0].data).toMatchObject({
        storeCode: 'ST000043',
        bpCodeId: 3,
        storeTypeCode: 'DIRECT',
        name: '서초점',
        storeStatusCode: 'NOT_OPERATING',
        createdBy: 7,
      });
      expect(historyRows()).toEqual([
        {
          storeId: 50,
          field: '등록',
          beforeValue: null,
          afterValue: '서초점',
          changedBy: 7,
          retainEndDate: expect.any(Date),
        },
      ]);
    });

    it('첫 점포는 ST000001', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      await expect(service.create(BM, dto)).resolves.toMatchObject({
        storeCode: 'ST000001',
      });
    });

    it('전체 점포 계정이 아니면 등록한 사람을 그 점포에 매핑한다 — 자기가 만든 점포를 보게', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        isAllStores: false,
        roleTypeCode: 'BA',
      });
      prisma.store.findFirst.mockResolvedValue(null);
      await service.create({ ...BM, roleTypeCode: 'BA' }, dto);
      expect(prisma.adminStoreMapping.create).toHaveBeenCalledWith({
        data: { adminAccountId: 7, storeId: 50, createdBy: 7 },
      });
    });

    it('층별 정보와 직접 넣은 사업자정보를 함께 저장한다', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      await service.create(BM, {
        ...dto,
        floors: [{ floorTypeCode: 'GROUND', floorNumber: 1, seatCount: 10 }],
        business: { tradeName: '모리', category: '음식점업' },
      });
      expect(prisma.storeFloor.createMany.mock.calls[0][0].data).toEqual([
        {
          storeId: 50,
          floorTypeCode: 'GROUND',
          floorNumber: 1,
          floorAreaPyeong: null,
          floorAreaSqm: null,
          seatCount: 10,
          createdBy: 7,
        },
      ]);
      expect(
        prisma.storeBusinessProfile.create.mock.calls[0][0].data,
      ).toMatchObject({
        storeId: 50,
        bizTradeName: '모리',
        bizCategory: '음식점업',
        bizRegistrationNumber: null,
        createdBy: 7,
      });
    });

    it('플랫폼 계정은 BP 를 골라야 한다 — 없으면 400', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 1,
        isAllStores: true,
        roleTypeCode: 'PM',
      });
      await expect(service.create(PM, dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('플랫폼 계정은 고른 고객 BP 에 만든다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 1,
        isAllStores: true,
        roleTypeCode: 'PM',
      });
      prisma.store.findFirst.mockResolvedValue(null);
      await service.create(PM, { ...dto, bpCodeId: 8 });
      expect(prisma.bpCode.findFirst.mock.calls[0][0].where).toEqual({
        bpCodeId: 8,
        isDeleted: false,
        isPlatform: false,
      });
      expect(prisma.store.create.mock.calls[0][0].data.bpCodeId).toBe(8);
      expect(prisma.adminStoreMapping.create).not.toHaveBeenCalled();
    });

    it('BP 쪽 계정이 다른 BP 를 보내면 400', async () => {
      await expect(
        service.create(BM, { ...dto, bpCodeId: 8 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('소속 BP 가 미사용이면 409', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({
        accountStatusCode: 'INACTIVE',
      });
      await expect(service.create(BM, dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.store.create).not.toHaveBeenCalled();
    });

    describe('사업자 인증', () => {
      const withIdentity: CreateStoreDto = {
        ...dto,
        businessVerification: {
          bizRegistrationNumber: '1234567890',
          ceoName: '김대표',
          openDate: '2020-03-02',
        },
      };

      it('미운영 · 운영 점포가 쓰는 번호면 국세청에 묻기 전에 409', async () => {
        prisma.storeBusinessProfile.count.mockResolvedValue(1);
        await expect(service.create(BM, withIdentity)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(verifier!.verify).not.toHaveBeenCalled();
        expect(prisma.storeBusinessProfile.count.mock.calls[0][0]).toEqual({
          where: {
            bizRegistrationNumber: '1234567890',
            store: {
              isDeleted: false,
              storeStatusCode: { in: ['NOT_OPERATING', 'OPERATING'] },
            },
          },
        });
      });

      it('국세청 정보와 맞지 않으면 400', async () => {
        verifier!.verify.mockResolvedValue(false);
        await expect(service.create(BM, withIdentity)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(prisma.store.create).not.toHaveBeenCalled();
      });

      it('연동이 없거나 실패하면 503', async () => {
        verifier!.verify.mockRejectedValue(new Error('timeout'));
        await expect(service.create(BM, withIdentity)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        verifier = null;
        await build();
        await expect(service.create(BM, withIdentity)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(prisma.store.create).not.toHaveBeenCalled();
      });

      it('맞으면 번호 · 대표자명 · 개업일자 · 인증일시를 저장하고, 잠근 뒤 중복을 다시 본다', async () => {
        prisma.store.findFirst.mockResolvedValue(null);
        await service.create(BM, withIdentity);
        expect(verifier!.verify).toHaveBeenCalledWith({
          bizRegistrationNumber: '1234567890',
          ceoName: '김대표',
          openDate: new Date('2020-03-02T00:00:00Z'),
        });
        expect(prisma.storeBusinessProfile.count).toHaveBeenCalledTimes(2);
        expect(
          prisma.storeBusinessProfile.create.mock.calls[0][0].data,
        ).toMatchObject({
          bizRegistrationNumber: '1234567890',
          bizCeoName: '김대표',
          bizOpenDate: new Date('2020-03-02T00:00:00Z'),
          bizVerifiedAt: expect.any(Date),
        });
      });

      it('잠그고 다시 보니 그 사이 다른 점포가 번호를 가져갔으면 409', async () => {
        prisma.storeBusinessProfile.count
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(1);
        await expect(service.create(BM, withIdentity)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(prisma.store.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('update', () => {
    it('폐점한 점포는 409', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({ storeStatusCode: 'CLOSED' }),
      );
      await expect(
        service.update(BM, 11, updateDto({ storeStatus: 'CLOSED' })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.store.updateMany).not.toHaveBeenCalled();
    });

    it('소속 BP 가 미사용이면 409', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          bpCode: {
            bpCode: 'BP000003',
            tradeName: '모리커피',
            accountStatusCode: 'INACTIVE',
          },
        }),
      );
      await expect(service.update(BM, 11, updateDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('범위 밖 점포는 404', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      await expect(service.update(BM, 11, updateDto())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('운영에서 미운영으로는 되돌리지 못한다 — 400', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          storeStatusCode: 'OPERATING',
          businessProfile: { bizRegistrationNumber: '1234567890' },
        }),
      );
      await expect(service.update(BM, 11, updateDto())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('운영은 인증과 좌표가 있어야 한다 — 모자라면 400', async () => {
      await expect(
        service.update(
          BM,
          11,
          updateDto({ storeStatus: 'OPERATING', latitude: null }),
        ),
      ).rejects.toThrow(/사업자정보 인증.*좌표/);
    });

    it('운영 점포에서 좌표를 지우고 저장하는 것도 막는다', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          storeStatusCode: 'OPERATING',
          businessProfile: { bizRegistrationNumber: '1234567890' },
        }),
      );
      await expect(
        service.update(
          BM,
          11,
          updateDto({ storeStatus: 'OPERATING', longitude: null }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('인증된 미운영 점포는 운영으로 바꾸고 이력을 남긴다', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({ businessProfile: { bizRegistrationNumber: '1234567890' } }),
      );
      await service.update(BM, 11, updateDto({ storeStatus: 'OPERATING' }));
      const args = prisma.store.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({
        storeId: 11,
        isDeleted: false,
        storeStatusCode: 'NOT_OPERATING',
        updatedAt: {
          gte: new Date(UPDATED_AT),
          lt: new Date(new Date(UPDATED_AT).getTime() + 1),
        },
      });
      expect(args.data).toMatchObject({
        storeStatusCode: 'OPERATING',
        updatedBy: 7,
      });
      expect(args.data.closedDate).toBeUndefined();
      expect(historyRows()).toEqual([
        expect.objectContaining({
          field: '점포상태',
          beforeValue: '미운영',
          afterValue: '운영',
        }),
      ]);
    });

    it('진행 중인 근로계약이 있으면 폐점하지 못한다 — 409', async () => {
      prisma.contract.count.mockResolvedValue(2);
      await expect(
        service.update(BM, 11, updateDto({ storeStatus: 'CLOSED' })),
      ).rejects.toThrow(/2건/);
      expect(prisma.store.updateMany).not.toHaveBeenCalled();
    });

    it('폐점하면 폐점일을 오늘(한국 날짜)로 넣는다', async () => {
      await service.update(BM, 11, updateDto({ storeStatus: 'CLOSED' }));
      expect(
        prisma.store.updateMany.mock.calls[0][0].data.closedDate,
      ).toBeInstanceOf(Date);
    });

    it('그 사이 다른 사람이 고쳤으면 409', async () => {
      prisma.store.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.update(BM, 11, updateDto({ name: '새 이름' })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.storeChangeHistory.createMany).not.toHaveBeenCalled();
    });

    it('바뀐 항목만 이력에 남기고, 층별 정보는 바뀌었을 때만 갈아 끼운다', async () => {
      await service.update(
        BM,
        11,
        updateDto({
          name: '서초 2호점',
          phone: null,
          isLocationApplied: false,
        }),
      );
      expect(
        historyRows().map((h) => [h.field, h.beforeValue, h.afterValue]),
      ).toEqual([
        ['점포명', '모리커피 서초점', '서초 2호점'],
        ['점포 연락처', '0212345678', null],
        ['위치 적용 여부', '사용', '미사용'],
      ]);
      expect(prisma.storeFloor.updateMany).not.toHaveBeenCalled();
      expect(prisma.storeBusinessProfile.upsert).not.toHaveBeenCalled();

      prisma.storeChangeHistory.createMany.mockClear();
      await service.update(
        BM,
        11,
        updateDto({ floors: [{ floorTypeCode: 'GROUND', floorNumber: 2 }] }),
      );
      expect(prisma.storeFloor.updateMany).toHaveBeenCalledWith({
        where: { storeId: 11, isDeleted: false },
        data: { isDeleted: true, updatedBy: 7 },
      });
      expect(historyRows()).toEqual([
        expect.objectContaining({
          field: '층별 정보',
          beforeValue: null,
          afterValue: '지상 2층',
        }),
      ]);
    });

    it('재인증은 번호 · 개업일자가 저장된 값과 같아야 한다 — 다르면 400', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          businessProfile: {
            bizRegistrationNumber: '1234567890',
            bizOpenDate: new Date('2020-03-02T00:00:00Z'),
            bizCeoName: '김대표',
          },
        }),
      );
      await expect(
        service.update(
          BM,
          11,
          updateDto({
            businessVerification: {
              bizRegistrationNumber: '9999999999',
              ceoName: '이대표',
              openDate: '2020-03-02',
            },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(verifier!.verify).not.toHaveBeenCalled();
    });

    it('재인증은 번호 중복을 다시 보지 않고, 대표자명 · 인증일시를 바꾼다', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          businessProfile: {
            bizRegistrationNumber: '1234567890',
            bizOpenDate: new Date('2020-03-02T00:00:00Z'),
            bizCeoName: '김대표',
          },
        }),
      );
      await service.update(
        BM,
        11,
        updateDto({
          businessVerification: {
            bizRegistrationNumber: '1234567890',
            ceoName: '이대표',
            openDate: '2020-03-02',
          },
        }),
      );
      expect(prisma.storeBusinessProfile.count).not.toHaveBeenCalled();
      expect(
        prisma.storeBusinessProfile.upsert.mock.calls[0][0].update,
      ).toMatchObject({
        bizCeoName: '이대표',
        bizVerifiedAt: expect.any(Date),
      });
      expect(historyRows()).toEqual([
        expect.objectContaining({
          field: '대표자명',
          beforeValue: '김대표',
          afterValue: '이대표',
        }),
      ]);
    });

    it('최초 인증은 자기 점포를 빼고 번호 중복을 본다', async () => {
      await service.update(
        BM,
        11,
        updateDto({
          businessVerification: {
            bizRegistrationNumber: '1234567890',
            ceoName: '김대표',
            openDate: '2020-03-02',
          },
        }),
      );
      expect(
        prisma.storeBusinessProfile.count.mock.calls[0][0].where.storeId,
      ).toEqual({ not: 11 });
      expect(historyRows().map((h) => h.field)).toEqual([
        '사업자등록번호',
        '대표자명',
        '개업일자',
      ]);
    });
  });

  describe('remove', () => {
    it('운영 점포는 지우지 못한다 — 409', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({ storeStatusCode: 'OPERATING' }),
      );
      await expect(service.remove(BM, 11)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('진행 중인 근로계약이 있으면 409', async () => {
      prisma.contract.count.mockResolvedValue(1);
      await expect(service.remove(BM, 11)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.store.updateMany).not.toHaveBeenCalled();
    });

    it('미운영 점포를 지움 표시하고 삭제 이력을 남긴다', async () => {
      await service.remove(BM, 11);
      expect(prisma.store.updateMany).toHaveBeenCalledWith({
        where: {
          storeId: 11,
          isDeleted: false,
          storeStatusCode: 'NOT_OPERATING',
        },
        data: { isDeleted: true, updatedBy: 7 },
      });
      expect(historyRows()).toEqual([
        expect.objectContaining({
          field: '삭제',
          beforeValue: '모리커피 서초점',
          afterValue: null,
        }),
      ]);
    });

    it('그 사이 지워지거나 상태가 바뀌었으면 409', async () => {
      prisma.store.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.remove(BM, 11)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('histories', () => {
    it('보존 기한 안의 이력을 최신순으로 쪽 나눠 준다', async () => {
      prisma.storeChangeHistory.findMany.mockResolvedValue([
        {
          changeId: 3,
          field: '점포명',
          beforeValue: 'a',
          afterValue: 'b',
          changedAt: new Date('2026-10-02T00:00:00Z'),
          changer: { name: '김본사' },
        },
      ]);
      prisma.storeChangeHistory.count.mockResolvedValue(11);
      await expect(
        service.histories(BM, 11, { page: 2, pageSize: 10 }),
      ).resolves.toEqual({
        items: [
          {
            changeId: 3,
            field: '점포명',
            beforeValue: 'a',
            afterValue: 'b',
            changedAt: new Date('2026-10-02T00:00:00Z'),
            changedByName: '김본사',
          },
        ],
        total: 11,
      });
      const args = prisma.storeChangeHistory.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        storeId: 11,
        retainEndDate: { gte: expect.any(Date) },
      });
      expect(args.orderBy).toEqual([
        { changedAt: 'desc' },
        { changeId: 'desc' },
      ]);
      expect(args.skip).toBe(10);
    });
  });

  describe('verifyBusiness', () => {
    const input = {
      bizRegistrationNumber: '1234567890',
      ceoName: '김대표',
      openDate: '2020-03-02',
    };

    it('번호가 겹치면 DUPLICATE — 국세청에 묻지 않는다', async () => {
      prisma.storeBusinessProfile.count.mockResolvedValue(1);
      await expect(service.verifyBusiness(BM, input)).resolves.toEqual({
        result: 'DUPLICATE',
      });
      expect(verifier!.verify).not.toHaveBeenCalled();
    });

    it('맞으면 VERIFIED, 다르면 UNVERIFIABLE', async () => {
      await expect(service.verifyBusiness(BM, input)).resolves.toEqual({
        result: 'VERIFIED',
      });
      verifier!.verify.mockResolvedValue(false);
      await expect(service.verifyBusiness(BM, input)).resolves.toEqual({
        result: 'UNVERIFIABLE',
      });
    });

    it('수정 중인 점포는 범위 안이어야 하고, 그 점포를 빼고 중복을 본다', async () => {
      prisma.store.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.verifyBusiness(BM, { ...input, storeId: 11 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      await service.verifyBusiness(BM, { ...input, storeId: 11 });
      expect(
        prisma.storeBusinessProfile.count.mock.calls[0][0].where.storeId,
      ).toEqual({ not: 11 });
    });

    it('연동이 없으면 503', async () => {
      verifier = null;
      await build();
      await expect(service.verifyBusiness(BM, input)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
