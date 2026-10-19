// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../auth/access-messages';
import { Prisma } from '@prisma/client';
import type { MenuCaller } from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import type { CreateStoreDto, UpdateStoreDto } from './dto/save-store.dto';
import { STORE_BUSINESS_VERIFIER } from './store-business-verifier';
import { canTransition } from './store-format';
import {
  STORE_IMAGE_THUMBNAIL,
  StoreManagementService,
} from './store-management.service';

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
    imageFiles: [],
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
  let storage: {
    put: jest.Mock;
    delete: jest.Mock;
    downloadUrl: jest.Mock;
    thumbnailUrl: jest.Mock;
  } | null;
  let prisma: Record<string, any>;
  /** 트랜잭션 안에서만 쓰는 잠금 · 다시 세기. 밖의 prisma 와 갈라 「안에서 다시 봤다」를 확인한다. */
  let tx: Record<string, any>;

  async function build() {
    const module = await Test.createTestingModule({
      providers: [
        StoreManagementService,
        { provide: PrismaService, useValue: prisma },
        { provide: STORE_BUSINESS_VERIFIER, useValue: verifier },
        { provide: STORAGE, useValue: storage },
      ],
    }).compile();
    service = module.get(StoreManagementService);
  }

  beforeEach(async () => {
    verifier = { verify: jest.fn().mockResolvedValue(true) };
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      thumbnailUrl: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(`https://thumb/${key}`),
        ),
      downloadUrl: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(`https://signed/${key}`),
        ),
    };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({
          bpCodeId: 3,
          isAllStores: true,
          roleTypeCode: 'BM',
          bpCode: { isPlatform: false },
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
      storeImageFile: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            fileId: 70,
            fileName: data.fileName,
            fileType: data.fileType,
            sizeBytes: data.sizeBytes,
            storageKey: data.storageKey,
          }),
        ),
      },
      storeChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    tx = {
      ...prisma,
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { storeStatusCode: 'NOT_OPERATING', isDeleted: false },
        ]),
      contract: { count: jest.fn().mockResolvedValue(0) },
      storeBusinessProfile: {
        ...prisma.storeBusinessProfile,
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$transaction = jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (t: unknown) => unknown)(tx)
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
          imageFiles: [],
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
            imageUrl: null,
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
        bpCode: { isPlatform: false },
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
        bpCode: { isPlatform: true },
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

    it('소속 BP 의 is_platform 을 함께 읽는다 — 권한 유형만으로 플랫폼 계정을 가리지 않는다', async () => {
      await service.list(BM, { page: 1, pageSize: 20 });
      expect(prisma.adminAccount.findFirst.mock.calls[0][0].select).toEqual({
        bpCodeId: true,
        isAllStores: true,
        roleTypeCode: true,
        bpCode: { select: { isPlatform: true } },
      });
    });

    it('고객 BP 소속 PM 은 플랫폼 계정이 아니다 — 자기 BP 의 점포만 본다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        isAllStores: true,
        roleTypeCode: 'PM',
        bpCode: { isPlatform: false },
      });
      await service.list(PM, { page: 1, pageSize: 20, bpCodeId: 8 });
      expect(prisma.store.findMany.mock.calls[0][0].where.AND[0]).toEqual({
        isDeleted: false,
        bpCodeId: 3,
      });
    });

    it('고객 BP 소속 PA 가 일부 점포 계정이면 매핑된 점포만 본다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        isAllStores: false,
        roleTypeCode: 'PA',
        bpCode: { isPlatform: false },
      });
      await service.list(
        { ...PM, roleTypeCode: 'PA' },
        { page: 1, pageSize: 20 },
      );
      expect(prisma.store.findMany.mock.calls[0][0].where.AND[0]).toEqual({
        isDeleted: false,
        bpCodeId: 3,
        adminMappings: { some: { adminAccountId: 1, isDeleted: false } },
      });
    });

    it('검색어의 % · _ · \\ 는 와일드카드가 아니라 글자로 찾는다 — _ 하나로 모든 점포가 나오지 않게', async () => {
      await service.list(BM, { page: 1, pageSize: 20, keyword: '50%_A\\' });
      const escaped = '50\\%\\_A\\\\';
      expect(prisma.store.findMany.mock.calls[0][0].where.AND[1].OR).toEqual([
        { name: { contains: escaped, mode: 'insensitive' } },
        { storeCode: { contains: escaped, mode: 'insensitive' } },
      ]);
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

    it('고객 BP 소속 PM 은 다른 BP 의 점포를 ID 로도 보지 못한다 — 자기 BP 로 거른다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        isAllStores: true,
        roleTypeCode: 'PM',
        bpCode: { isPlatform: false },
      });
      prisma.store.findFirst.mockResolvedValue(null);
      await expect(service.detail(PM, 99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.store.findFirst.mock.calls[0][0].where).toEqual({
        AND: [{ isDeleted: false, bpCodeId: 3 }, { storeId: 99 }],
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
            in: [
              'DRAFT',
              'PENDING_SEND',
              'PENDING_SIGNATURE',
              'CORRECTION_REQUESTED',
              'SIGNED',
            ],
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
      expect(tx.$executeRaw).toHaveBeenCalled();
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
        bpCode: { isPlatform: false },
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
        bpCode: { isPlatform: true },
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
        bpCode: { isPlatform: true },
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

    it('고객 BP 소속 PM 은 다른 BP 에 등록하지 못한다 — 400', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        isAllStores: true,
        roleTypeCode: 'PM',
        bpCode: { isPlatform: false },
      });
      await expect(
        service.create(PM, { ...dto, bpCodeId: 8 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.store.create).not.toHaveBeenCalled();
    });

    it('고객 BP 소속 PM 은 BP 를 고르지 않아도 자기 BP 에 등록한다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        isAllStores: true,
        roleTypeCode: 'PM',
        bpCode: { isPlatform: false },
      });
      prisma.store.findFirst.mockResolvedValue(null);
      await service.create(PM, dto);
      expect(prisma.store.create.mock.calls[0][0].data.bpCodeId).toBe(3);
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
        expect(prisma.storeBusinessProfile.count).toHaveBeenCalledTimes(1);
        expect(tx.storeBusinessProfile.count).toHaveBeenCalledTimes(1);
        // 이 번호로 잠근 뒤에 다시 센다 — 점포코드 잠금만으로는 이 테스트가 통과하지 않는다.
        const lockCall = tx.$executeRaw.mock.calls.findIndex((call) =>
          call.slice(1).includes('stores:biz:1234567890'),
        );
        expect(lockCall).toBeGreaterThanOrEqual(0);
        const lockedAt: number =
          tx.$executeRaw.mock.invocationCallOrder[lockCall];
        const recountedAt: number =
          tx.storeBusinessProfile.count.mock.invocationCallOrder[0];
        expect(lockedAt).toBeLessThan(recountedAt);
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
        tx.storeBusinessProfile.count.mockResolvedValue(1);
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
          updateDto({
            storeStatus: 'OPERATING',
            latitude: null,
            longitude: null,
          }),
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
          updateDto({
            storeStatus: 'OPERATING',
            latitude: null,
            longitude: null,
          }),
        ),
      ).rejects.toThrow('운영 중인 점포의 좌표는 지울 수 없습니다');
    });

    // 진위확인 연동이 없어 인증을 채울 수 없다 — 이미 운영 중인 점포(공용 DB 11곳)는 그대로 고칠 수 있어야 한다.
    it('사업자번호가 없는 운영 점포도 다른 칸은 고칠 수 있다 — 운영 조건은 운영으로 바꿀 때만 본다', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({ storeStatusCode: 'OPERATING', businessProfile: null }),
      );
      await service.update(
        BM,
        11,
        updateDto({ storeStatus: 'OPERATING', phone: '0298765432' }),
      );
      expect(prisma.store.updateMany).toHaveBeenCalled();
      expect(verifier!.verify).not.toHaveBeenCalled();
    });

    it('좌표가 없던 운영 점포도 좌표 없이 저장할 수 있다', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          storeStatusCode: 'OPERATING',
          latitude: null,
          longitude: null,
          businessProfile: null,
        }),
      );
      await service.update(
        BM,
        11,
        updateDto({
          storeStatus: 'OPERATING',
          name: '새 이름',
          latitude: null,
          longitude: null,
        }),
      );
      expect(prisma.store.updateMany).toHaveBeenCalled();
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

    it('폐점은 점포 행을 잠근 뒤 트랜잭션 안에서 계약을 다시 센다 — 그사이 생긴 계약이 있으면 409', async () => {
      // 앞의 확인은 0건, 잠근 뒤에는 그사이 만든 1건이 보인다.
      tx.contract.count.mockResolvedValue(1);
      await expect(
        service.update(BM, 11, updateDto({ storeStatus: 'CLOSED' })),
      ).rejects.toThrow(/1건/);
      expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
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

    it('점포 행을 잠근 뒤 트랜잭션 안에서 계약을 다시 센다 — 그사이 생긴 계약이 있으면 409', async () => {
      tx.contract.count.mockResolvedValue(1);
      await expect(service.remove(BM, 11)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
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

  // 국세청 키 · 하루 할당량을 모든 BP 가 함께 쓴다. 인증 확인 · 등록 · 수정이 국세청을 실제로 부를 때만
  // 관리자별 한 시간 10번으로 센다 — 일반 저장은 막지 않는다(#51 ⑤ 블로커).
  describe('국세청 호출 한도', () => {
    const input = {
      bizRegistrationNumber: '1234567890',
      ceoName: '김대표',
      openDate: '2020-03-02',
    };
    let now: jest.SpyInstance;
    beforeEach(() => {
      now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });
    afterEach(() => now.mockRestore());

    const verifyTimes = async (caller: MenuCaller, times: number) => {
      for (let i = 0; i < times; i++)
        await service.verifyBusiness(caller, input);
    };

    it('한 관리자는 한 시간에 10번까지 — 11번째는 429 이고 국세청에 묻지 않는다', async () => {
      await verifyTimes(BM, 10);
      await expect(service.verifyBusiness(BM, input)).rejects.toMatchObject({
        status: 429,
      });
      expect(verifier!.verify).toHaveBeenCalledTimes(10);
    });

    it('다른 관리자는 따로 세고, 한 시간이 지나면 다시 된다', async () => {
      await verifyTimes(BM, 10);
      await expect(service.verifyBusiness(PM, input)).resolves.toEqual({
        result: 'VERIFIED',
      });
      now.mockReturnValue(1_000_000 + 3_600_000);
      await expect(service.verifyBusiness(BM, input)).resolves.toEqual({
        result: 'VERIFIED',
      });
    });

    it('등록 · 수정 안의 인증도 같은 10번에서 센다 — 저장 경로로 한도를 돌아가지 못하게', async () => {
      await verifyTimes(BM, 10);
      // 확인한 적 없는 값이라 저장이 국세청을 새로 불러야 한다.
      await expect(
        service.update(
          BM,
          11,
          updateDto({ businessVerification: { ...input, ceoName: '이대표' } }),
        ),
      ).rejects.toMatchObject({ status: 429 });
      expect(verifier!.verify).toHaveBeenCalledTimes(10);
    });

    it('한도를 다 써도 사업자 인증 없는 일반 저장은 된다', async () => {
      await verifyTimes(BM, 10);
      await expect(
        service.update(BM, 11, updateDto()),
      ).resolves.toBeUndefined();
    });

    // 화면은 「인증하기」로 한 번 묻고 저장 때 서버가 다시 묻는다. 같은 관리자가 10분 안에 일치를 받은 같은
    // 세 값이면 저장 때 다시 묻지 않는다 — 점포 하나가 호출 하나가 되게. 서버가 직접 받은 결과만 믿는다.
    it('10분 안에 같은 관리자가 일치를 받은 같은 값이면 저장 때 국세청에 다시 묻지 않는다', async () => {
      await service.verifyBusiness(BM, input);
      await service.update(BM, 11, updateDto({ businessVerification: input }));
      expect(verifier!.verify).toHaveBeenCalledTimes(1);
    });

    it('다른 관리자 · 다른 대표자명 · 10분이 지난 뒤 · 일치가 아니었던 값은 다시 묻는다', async () => {
      await service.verifyBusiness(BM, input);
      await service.update(PM, 11, updateDto({ businessVerification: input }));
      expect(verifier!.verify).toHaveBeenCalledTimes(2);

      await service
        .update(
          BM,
          11,
          updateDto({ businessVerification: { ...input, ceoName: '이대표' } }),
        )
        .catch(() => undefined);
      expect(verifier!.verify).toHaveBeenCalledTimes(3);

      now.mockReturnValue(1_000_000 + 600_000);
      await service.update(BM, 11, updateDto({ businessVerification: input }));
      expect(verifier!.verify).toHaveBeenCalledTimes(4);

      verifier!.verify.mockResolvedValue(false);
      await service.verifyBusiness(FM, input).catch(() => undefined);
      await service
        .update(FM, 11, updateDto({ businessVerification: input }))
        .catch(() => undefined);
      expect(verifier!.verify).toHaveBeenCalledTimes(6);
    });

    it('국세청에 묻지 않고 끝난 요청(번호 중복)은 세지 않는다', async () => {
      prisma.storeBusinessProfile.count.mockResolvedValue(1);
      await verifyTimes(BM, 10);
      prisma.storeBusinessProfile.count.mockResolvedValue(0);
      await expect(service.verifyBusiness(BM, input)).resolves.toEqual({
        result: 'VERIFIED',
      });
    });
  });

  describe('verifyBusiness', () => {
    const input = {
      bizRegistrationNumber: '1234567890',
      ceoName: '김대표',
      openDate: '2020-03-02',
    };

    it('사용 중인 관리자 계정이 아니면 점포를 고르지 않았어도 403 — 국세청에 묻지 않는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.verifyBusiness(BM, input)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(verifier!.verify).not.toHaveBeenCalled();
    });

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

  describe('excel', () => {
    const excelRow = {
      storeId: 11,
      storeCode: 'ST000011',
      name: '서초점',
      storeTypeCode: 'DIRECT',
      storeStatusCode: 'OPERATING',
      phone: null,
      zipCode: null,
      address: null,
      addressDetail: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      bpCode: { tradeName: '모리커피' },
      businessProfile: null,
    };
    let now: jest.SpyInstance;

    beforeEach(() => {
      now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      prisma.store.findMany.mockResolvedValue([excelRow]);
      prisma.store.count.mockResolvedValue(1);
    });
    afterEach(() => now.mockRestore());

    it('목록과 같은 조건 · 순서로 전부 읽어 xlsx 를 만든다(쪽 나눔 없음)', async () => {
      prisma.staffMember.groupBy.mockResolvedValue([
        { storeId: 11, _count: { _all: 3 } },
      ]);
      const file = await service.excel(BM, { statuses: ['CLOSED'] });

      expect(file.fileName).toMatch(/^점포목록_\d{8}\.xlsx$/);
      // xlsx 는 zip 이다.
      expect(file.buffer.subarray(0, 2).toString()).toBe('PK');
      const args = prisma.store.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        AND: [
          { isDeleted: false, bpCodeId: 3 },
          {
            storeStatusCode: { in: ['CLOSED'] },
            storeTypeCode: { in: ['DIRECT', 'FRANCHISE'] },
          },
        ],
      });
      expect(prisma.store.count.mock.calls[0][0]).toEqual({
        where: args.where,
      });
      expect(args.orderBy).toEqual([
        { createdAt: 'desc' },
        { storeId: 'desc' },
      ]);
      expect(args.skip).toBeUndefined();
      expect(args.take).toBeUndefined();
      expect(args.select.businessProfile).toBeTruthy();
    });

    it('1만 건 이상이면 400 이고 읽지 않는다 — 조건을 좁혀 다시 받을 수 있다', async () => {
      prisma.store.count.mockResolvedValue(10_000);
      await expect(service.excel(BM, {})).rejects.toThrow(
        '1만 건 이상은 바로 받을 수 없습니다',
      );
      expect(prisma.store.findMany).not.toHaveBeenCalled();

      prisma.store.count.mockResolvedValue(9_999);
      await expect(service.excel(BM, {})).resolves.toBeDefined();
    });

    it('한 사람은 1분에 한 번 — 그 안의 두 번째는 429, 다른 사람은 받는다, 1분이 지나면 다시 받는다', async () => {
      await service.excel(BM, {});
      await expect(service.excel(BM, {})).rejects.toMatchObject({
        status: 429,
      });
      await expect(service.excel(PM, {})).resolves.toBeDefined();
      now.mockReturnValue(1_000_000 + 60_000);
      await expect(service.excel(BM, {})).resolves.toBeDefined();
    });

    it('동시에 두 번 눌러도 하나만 만든다', async () => {
      const results = await Promise.allSettled([
        service.excel(BM, {}),
        service.excel(BM, {}),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
    });

    it('사용 중인 관리자 계정이 아니면 403, 횟수에 세지 않는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValueOnce(null);
      await expect(service.excel(BM, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.excel(BM, {})).resolves.toBeDefined();
    });
  });

  describe('대표 이미지', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const GIF = Buffer.from('GIF89a');
    const upload = (overrides: Record<string, unknown> = {}) => ({
      buffer: PNG,
      size: 1024,
      originalname: '서초점 외관.png',
      ...overrides,
    });
    const KEY = /^stores\/11\/[0-9a-f-]{36}\.png$/;
    const savedImage = {
      fileId: 60,
      fileName: '예전.jpg',
      fileType: 'JPG',
      sizeBytes: 2048,
      storageKey: 'stores/11/00000000-0000-4000-8000-000000000000.jpg',
    };

    describe('조회', () => {
      it('목록은 썸네일 주소다 — 원본(최대 5MB)을 카드마다 받지 않게', async () => {
        prisma.store.findMany.mockResolvedValue([
          {
            storeId: 11,
            storeCode: 'ST000011',
            name: '서초점',
            storeTypeCode: 'DIRECT',
            storeStatusCode: 'OPERATING',
            bpCodeId: 3,
            phone: null,
            address: null,
            createdAt: new Date('2026-10-01T00:00:00Z'),
            bpCode: { tradeName: '모리커피' },
            businessProfile: null,
            imageFiles: [savedImage],
          },
        ]);
        const { items } = await service.list(BM, { page: 1, pageSize: 20 });
        expect(items[0].imageUrl).toBe(
          `https://thumb/${savedImage.storageKey}`,
        );
        expect(storage!.thumbnailUrl).toHaveBeenCalledWith(
          savedImage.storageKey,
        );
        expect(storage!.downloadUrl).not.toHaveBeenCalled();
        expect(
          prisma.store.findMany.mock.calls[0][0].select.imageFiles.where,
        ).toEqual({ isDeleted: false });
      });

      it('상세는 지우지 않은 이미지 한 장과 서명한 주소를 준다', async () => {
        prisma.store.findFirst.mockResolvedValue(
          storeRow({ imageFiles: [savedImage] }),
        );
        const { image } = await service.detail(BM, 11);
        expect(image).toEqual({
          fileId: 60,
          fileName: '예전.jpg',
          fileType: 'JPG',
          sizeBytes: 2048,
          url: `https://signed/${savedImage.storageKey}`,
        });
      });

      it('저장소 설정이 없거나 서명이 실패해도 조회는 되고 주소만 null', async () => {
        prisma.store.findFirst.mockResolvedValue(
          storeRow({ imageFiles: [savedImage] }),
        );
        storage!.downloadUrl.mockRejectedValueOnce(new Error('no credentials'));
        expect((await service.detail(BM, 11)).image?.url).toBeNull();

        storage = null;
        await build();
        expect((await service.detail(BM, 11)).image).toMatchObject({
          fileId: 60,
          url: null,
        });
      });
    });

    describe('putImage', () => {
      it('내용으로 판정한 종류로 stores/{점포}/{uuid} 에 올리고, 옛 이미지를 지움 표시한 뒤 새 행과 이력을 남긴다', async () => {
        prisma.storeImageFile.findFirst.mockResolvedValue({
          fileId: 60,
          fileName: '예전.jpg',
        });
        const image = await service.putImage(BM, 11, upload());

        const [key, body, kind, options] = storage!.put.mock.calls[0];
        expect(key).toMatch(KEY);
        expect(body).toBe(PNG);
        expect(kind).toBe('PNG');
        // 목록 카드가 쓸 썸네일 사본을 함께 만든다 — 점포 이미지는 늘 이 옵션으로 올린다.
        expect(options).toEqual({ thumbnail: STORE_IMAGE_THUMBNAIL });
        // 같은 점포의 이미지 교체를 점포 행 잠금으로 줄 세운다.
        expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
        expect(prisma.storeImageFile.update).toHaveBeenCalledWith({
          where: { fileId: 60 },
          data: { isDeleted: true, updatedBy: 7 },
        });
        expect(prisma.storeImageFile.create.mock.calls[0][0].data).toEqual({
          storeId: 11,
          fileName: '서초점 외관.png',
          fileType: 'PNG',
          sizeBytes: 1024,
          storageKey: key,
          createdBy: 7,
        });
        expect(historyRows()).toEqual([
          expect.objectContaining({
            field: '대표 이미지',
            beforeValue: '예전.jpg',
            afterValue: '서초점 외관.png',
          }),
        ]);
        expect(image).toEqual({
          fileId: 70,
          fileName: '서초점 외관.png',
          fileType: 'PNG',
          sizeBytes: 1024,
          url: `https://signed/${key}`,
        });
      });

      it('파일 이름의 제어 문자를 빼고 255자로 자른다', async () => {
        await service.putImage(
          BM,
          11,
          upload({ originalname: `a\u0000b\u001f${'가'.repeat(300)}.png` }),
        );
        const { fileName } = prisma.storeImageFile.create.mock.calls[0][0].data;
        expect(fileName).toHaveLength(255);
        expect(fileName.startsWith('ab가')).toBe(true);
        expect(historyRows()[0].afterValue).toBe(fileName);
      });

      it('제어 문자를 빼면 남는 것이 없으면 image.png 로 둔다', async () => {
        await service.putImage(BM, 11, upload({ originalname: '\u0000 ' }));
        expect(
          prisma.storeImageFile.create.mock.calls[0][0].data.fileName,
        ).toBe('image.png');
      });

      it('처음 올리면 지울 행 없이 이력의 이전 값이 비어 있다', async () => {
        await service.putImage(BM, 11, upload());
        expect(prisma.storeImageFile.update).not.toHaveBeenCalled();
        expect(historyRows()[0]).toMatchObject({ beforeValue: null });
      });

      it('파일이 없으면 400', async () => {
        await expect(
          service.putImage(BM, 11, undefined),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(storage!.put).not.toHaveBeenCalled();
      });

      it('JPG · PNG 가 아니면 확장자와 상관없이 400', async () => {
        await expect(
          service.putImage(
            BM,
            11,
            upload({ buffer: GIF, originalname: 'a.png' }),
          ),
        ).rejects.toThrow('JPG · PNG 파일만 올릴 수 있습니다.');
        expect(storage!.put).not.toHaveBeenCalled();
      });

      it('5MB 를 넘으면 400', async () => {
        await expect(
          service.putImage(BM, 11, upload({ size: 5 * 1024 * 1024 + 1 })),
        ).rejects.toThrow('파일은 5MB까지 올릴 수 있습니다.');
      });

      it('저장소 설정이 없으면 503', async () => {
        storage = null;
        await build();
        await expect(service.putImage(BM, 11, upload())).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      });

      it('범위 밖 점포는 404, 올리지 않는다', async () => {
        prisma.store.findFirst.mockResolvedValue(null);
        await expect(service.putImage(BM, 11, upload())).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(storage!.put).not.toHaveBeenCalled();
      });

      it.each([
        ['폐점한 점포', storeRow({ storeStatusCode: 'CLOSED' })],
        [
          '소속 BP 가 미사용인 점포',
          storeRow({
            bpCode: {
              bpCode: 'BP000003',
              tradeName: '모리커피',
              accountStatusCode: 'INACTIVE',
            },
          }),
        ],
      ])('%s는 409, 올리지 않는다', async (_, row) => {
        prisma.store.findFirst.mockResolvedValue(row);
        await expect(service.putImage(BM, 11, upload())).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(storage!.put).not.toHaveBeenCalled();
      });

      it.each([
        ['깨진 이미지', '이미지를 읽을 수 없습니다.'],
        ['화소가 너무 큰 이미지', '이미지가 너무 큽니다.'],
      ])(
        '썸네일을 만들 수 없는 %s 는 503 이 아니라 그대로 400 이다',
        async (_, message) => {
          storage!.put.mockRejectedValue(new BadRequestException(message));
          await expect(service.putImage(BM, 11, upload())).rejects.toThrow(
            message,
          );
          expect(prisma.storeImageFile.create).not.toHaveBeenCalled();
        },
      );

      it('저장소가 없어도 범위 밖 점포는 404 다 — 503 이 404 · 403 을 가리지 않게', async () => {
        storage = null;
        await build();
        prisma.store.findFirst.mockResolvedValue(null);
        await expect(service.putImage(BM, 11, upload())).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });

      it('올리기가 실패하면 503, DB 는 건드리지 않는다', async () => {
        storage!.put.mockRejectedValue(new Error('S3 down'));
        await expect(service.putImage(BM, 11, upload())).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(prisma.storeImageFile.create).not.toHaveBeenCalled();
      });

      it('잠근 뒤 보니 그사이 폐점했으면 409, 올린 파일을 지운다', async () => {
        tx.$queryRaw.mockResolvedValue([
          { storeStatusCode: 'CLOSED', isDeleted: false },
        ]);
        await expect(service.putImage(BM, 11, upload())).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(prisma.storeImageFile.create).not.toHaveBeenCalled();
        expect(storage!.delete).toHaveBeenCalledWith(
          storage!.put.mock.calls[0][0],
        );
      });

      it('잠근 뒤 보니 그사이 지워졌으면 404, 올린 파일을 지운다', async () => {
        tx.$queryRaw.mockResolvedValue([
          { storeStatusCode: 'NOT_OPERATING', isDeleted: true },
        ]);
        await expect(service.putImage(BM, 11, upload())).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(storage!.delete).toHaveBeenCalled();
      });

      it('DB 저장이 실패하면 올린 파일을 지우고 원래 오류를 낸다 — 지우기가 실패해도', async () => {
        const failure = new Error('db down');
        prisma.storeImageFile.create.mockRejectedValue(failure);
        storage!.delete.mockRejectedValue(new Error('S3 down'));
        await expect(service.putImage(BM, 11, upload())).rejects.toBe(failure);
        expect(storage!.delete).toHaveBeenCalledWith(
          storage!.put.mock.calls[0][0],
        );
      });
    });

    describe('removeImage', () => {
      it('지우지 않은 이미지를 지움 표시하고 이력을 남긴다. 저장소의 파일은 남긴다', async () => {
        prisma.storeImageFile.findFirst.mockResolvedValue({
          fileId: 60,
          fileName: '예전.jpg',
        });
        await service.removeImage(BM, 11);
        expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
        expect(prisma.storeImageFile.update).toHaveBeenCalledWith({
          where: { fileId: 60 },
          data: { isDeleted: true, updatedBy: 7 },
        });
        expect(historyRows()).toEqual([
          expect.objectContaining({
            field: '대표 이미지',
            beforeValue: '예전.jpg',
            afterValue: null,
          }),
        ]);
        expect(storage!.delete).not.toHaveBeenCalled();
      });

      it('이미지가 없으면 아무것도 하지 않는다', async () => {
        await service.removeImage(BM, 11);
        expect(prisma.storeImageFile.update).not.toHaveBeenCalled();
        expect(historyRows()).toEqual([]);
      });

      it('저장소 설정이 없어도 지울 수 있다', async () => {
        storage = null;
        await build();
        prisma.storeImageFile.findFirst.mockResolvedValue({
          fileId: 60,
          fileName: '예전.jpg',
        });
        await service.removeImage(BM, 11);
        expect(prisma.storeImageFile.update).toHaveBeenCalled();
      });

      it('폐점한 점포는 409', async () => {
        prisma.store.findFirst.mockResolvedValue(
          storeRow({ storeStatusCode: 'CLOSED' }),
        );
        await expect(service.removeImage(BM, 11)).rejects.toBeInstanceOf(
          ConflictException,
        );
      });
    });
  });

  describe('리뷰 반영 — 빠진 분기', () => {
    const identity = {
      bizRegistrationNumber: '1234567890',
      ceoName: '김대표',
      openDate: '2020-03-02',
    };
    const createDto: CreateStoreDto = {
      storeTypeCode: 'DIRECT',
      name: '서초점',
      isLocationApplied: true,
      floors: [],
      business: {},
    };

    it('가맹관리자(FA)도 등록하지 못한다', async () => {
      await expect(
        service.create({ ...FM, roleTypeCode: 'FA' }, createDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // 관리자 웹은 403 문구로 화면 동작을 가른다(auth/access-messages) — 업무마다 문구를 짓지 않는다.
    it('403 문구는 관리자 API 공용 문구다', async () => {
      await expect(service.create(FM, createDto)).rejects.toThrow(
        ACCESS_DENIED_MESSAGE,
      );
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.detail(BM, 11)).rejects.toThrow(
        ACCOUNT_UNAVAILABLE_MESSAGE,
      );
    });

    it('없는 BP(지운 BP · 플랫폼 BP 포함)에는 등록하지 못한다 — 400', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(null);
      await expect(service.create(BM, createDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.store.create).not.toHaveBeenCalled();
    });

    it('점포코드를 다 쓰면(ST999999 다음) 409', async () => {
      prisma.store.findFirst.mockResolvedValue({ storeCode: 'ST999999' });
      await expect(service.create(BM, createDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('점포코드가 겹쳐 고유 제약에 걸리면(채번 잠금을 거치지 않은 등록) 500 이 아니라 409', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      prisma.store.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(service.create(BM, createDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('모든 칸이 빈 층 줄은 저장하지 않는다', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      await service.create(BM, {
        ...createDto,
        floors: [{}, { floorTypeCode: 'GROUND', floorNumber: 1 }, {}],
      });
      expect(prisma.storeFloor.createMany.mock.calls[0][0].data).toHaveLength(
        1,
      );
    });

    it('수정에서도 빈 층 줄은 버린다 — 빈 줄만 보내면 층 정보는 그대로다', async () => {
      await service.update(BM, 11, updateDto({ floors: [{}, {}] }));
      expect(prisma.storeFloor.updateMany).not.toHaveBeenCalled();
      expect(historyRows()).toEqual([]);
    });

    it('최초 인증과 운영 전환을 한 번에 보내면 이번 인증으로 운영 조건을 채운다', async () => {
      await service.update(
        BM,
        11,
        updateDto({ storeStatus: 'OPERATING', businessVerification: identity }),
      );
      expect(prisma.store.updateMany.mock.calls[0][0].data).toMatchObject({
        storeStatusCode: 'OPERATING',
      });
    });

    it('수정의 최초 인증도 잠근 뒤 다시 세어, 그사이 번호를 가져갔으면 409', async () => {
      tx.storeBusinessProfile.count.mockResolvedValue(1);
      await expect(
        service.update(BM, 11, updateDto({ businessVerification: identity })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.store.updateMany).not.toHaveBeenCalled();
    });

    it('PUT 은 전체 교체다 — 빠진 사업자 칸은 지우고 이력을 남긴다(인증한 번호는 남는다)', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          businessProfile: {
            bizRegistrationNumber: '1234567890',
            bizCeoName: '김대표',
            bizOpenDate: new Date('2020-03-02T00:00:00Z'),
            bizVerifiedAt: new Date('2026-10-01T00:00:00Z'),
            bizTradeName: '모리',
            bizCeoPhone: null,
            bizZipCode: null,
            bizAddress: null,
            bizAddressDetail: null,
            bizCategory: '음식점업',
            bizItem: null,
          },
        }),
      );
      await service.update(BM, 11, updateDto({ business: {} }));
      expect(
        tx.storeBusinessProfile.upsert.mock.calls[0][0].update,
      ).toMatchObject({
        bizTradeName: null,
        bizCategory: null,
        bizRegistrationNumber: '1234567890',
        bizCeoName: '김대표',
      });
      expect(historyRows().map((h) => h.field)).toEqual(['상호명', '업태']);
    });

    it('폐점일은 한국 날짜다 — UTC 로는 전날 밤이어도', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-10-14T15:30:00Z'));
      try {
        await service.update(BM, 11, updateDto({ storeStatus: 'CLOSED' }));
      } finally {
        jest.useRealTimers();
      }
      const { closedDate } = prisma.store.updateMany.mock.calls[0][0].data;
      expect(closedDate.toISOString().slice(0, 10)).toBe('2026-10-15');
    });

    it.each([
      ['미운영 · 계약 없음', 'NOT_OPERATING', 0, true, true],
      ['미운영 · 계약 있음', 'NOT_OPERATING', 1, false, false],
      ['운영 · 계약 없음', 'OPERATING', 0, true, false],
      ['폐점', 'CLOSED', 0, false, false],
    ])(
      '상세의 전환 가능 여부 — %s',
      async (_, storeStatusCode, contracts, canClose, canDelete) => {
        prisma.store.findFirst.mockResolvedValue(storeRow({ storeStatusCode }));
        prisma.contract.count.mockResolvedValue(contracts);
        const { transitions } = await service.detail(BM, 11);
        expect(transitions).toMatchObject({ canClose, canDelete });
      },
    );

    it('이력은 오늘(한국 날짜) 이후까지 보존하는 것만 본다', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-10-14T15:30:00Z'));
      try {
        await service.histories(BM, 11, { page: 1, pageSize: 10 });
      } finally {
        jest.useRealTimers();
      }
      const { where } = prisma.storeChangeHistory.findMany.mock.calls[0][0];
      expect(where.retainEndDate.gte.toISOString().slice(0, 10)).toBe(
        '2026-10-15',
      );
    });

    it.each([
      ['위도만', { latitude: 37.5, longitude: null }],
      ['경도만', { latitude: null, longitude: 127.0 }],
    ])(
      '좌표는 위도 · 경도를 함께 넣는다 — %s 있으면 400',
      async (_, coords) => {
        await expect(
          service.update(BM, 11, updateDto(coords)),
        ).rejects.toBeInstanceOf(BadRequestException);
        prisma.store.findFirst.mockResolvedValue(null);
        await expect(
          service.create(BM, { ...createDto, ...coords }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.store.updateMany).not.toHaveBeenCalled();
        expect(prisma.store.create).not.toHaveBeenCalled();
      },
    );

    describe('remove', () => {
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
        await expect(service.remove(BM, 11)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(prisma.store.updateMany).not.toHaveBeenCalled();
      });

      it('폐점한 점포는 지우지 못한다 — 409', async () => {
        prisma.store.findFirst.mockResolvedValue(
          storeRow({ storeStatusCode: 'CLOSED' }),
        );
        await expect(service.remove(BM, 11)).rejects.toBeInstanceOf(
          ConflictException,
        );
      });
    });

    describe('removeImage', () => {
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
        await expect(service.removeImage(BM, 11)).rejects.toBeInstanceOf(
          ConflictException,
        );
      });

      it('잠근 뒤 보니 그사이 폐점했으면 409, 아무것도 지우지 않는다', async () => {
        tx.$queryRaw.mockResolvedValue([
          { storeStatusCode: 'CLOSED', isDeleted: false },
        ]);
        await expect(service.removeImage(BM, 11)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(prisma.storeImageFile.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('2차 리뷰 반영 — 잠금 순서 · 원자성 · 빈틈', () => {
    const identity = {
      bizRegistrationNumber: '1234567890',
      ceoName: '김대표',
      openDate: '2020-03-02',
    };
    const createDto: CreateStoreDto = {
      storeTypeCode: 'DIRECT',
      name: '서초점',
      isLocationApplied: true,
      floors: [],
      business: {},
    };
    /** fn 이 처음 불린 순서. 불리지 않았으면 Infinity. */
    // 여기 넘기는 mock 들은 Record<string, any> 에서 꺼낸 값이라 any 로 받는다.
    const firstCall = (fn: any): number =>
      (fn as jest.Mock).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;

    // tx 의 쓰기를 prisma 와 다른 mock 으로 갈라, 쓰기가 트랜잭션 밖(this.prisma)으로 새면 잡는다.
    function splitWrites() {
      const fresh = () => ({
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ fileId: 70, ...data }),
          ),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      });
      tx.store = { ...prisma.store, updateMany: fresh().updateMany };
      tx.storeFloor = fresh();
      tx.storeChangeHistory = { createMany: fresh().createMany };
      tx.storeBusinessProfile = {
        ...tx.storeBusinessProfile,
        upsert: fresh().upsert,
      };
      tx.storeImageFile = fresh();
    }
    function expectNoWriteOutsideTransaction() {
      expect(prisma.store.updateMany).not.toHaveBeenCalled();
      expect(prisma.storeFloor.updateMany).not.toHaveBeenCalled();
      expect(prisma.storeFloor.createMany).not.toHaveBeenCalled();
      expect(prisma.storeChangeHistory.createMany).not.toHaveBeenCalled();
      expect(prisma.storeBusinessProfile.upsert).not.toHaveBeenCalled();
      expect(prisma.storeImageFile.create).not.toHaveBeenCalled();
      expect(prisma.storeImageFile.update).not.toHaveBeenCalled();
    }

    it('수정의 쓰기는 모두 트랜잭션 안이다 — 점포 · 층 · 사업자정보 · 이력', async () => {
      splitWrites();
      await service.update(
        BM,
        11,
        updateDto({
          name: '새 이름',
          floors: [{ floorTypeCode: 'GROUND', floorNumber: 1 }],
          business: { tradeName: '모리' },
        }),
      );
      expect(tx.store.updateMany).toHaveBeenCalled();
      expect(tx.storeFloor.createMany).toHaveBeenCalled();
      expect(tx.storeBusinessProfile.upsert).toHaveBeenCalled();
      expect(tx.storeChangeHistory.createMany).toHaveBeenCalled();
      expectNoWriteOutsideTransaction();
    });

    it('이미지 교체의 쓰기도 모두 트랜잭션 안이다', async () => {
      splitWrites();
      tx.storeImageFile.findFirst.mockResolvedValue({
        fileId: 60,
        fileName: '예전.jpg',
      });
      const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await service.putImage(BM, 11, {
        buffer: PNG,
        size: 8,
        originalname: 'a.png',
      });
      expect(tx.storeImageFile.update).toHaveBeenCalled();
      expect(tx.storeImageFile.create).toHaveBeenCalled();
      expect(tx.storeChangeHistory.createMany).toHaveBeenCalled();
      expectNoWriteOutsideTransaction();
    });

    it('DB 의 층 값(Decimal)과 같은 층을 보내면 층을 갈아 끼우지 않고 이력도 없다', async () => {
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          floors: [
            {
              storeFloorId: 5,
              floorTypeCode: 'GROUND',
              floorNumber: 1,
              floorAreaPyeong: new Prisma.Decimal('18.0'),
              floorAreaSqm: new Prisma.Decimal('59.50'),
              seatCount: 24,
            },
          ],
        }),
      );
      await service.update(
        BM,
        11,
        updateDto({
          floors: [
            {
              floorTypeCode: 'GROUND',
              floorNumber: 1,
              floorAreaPyeong: 18,
              floorAreaSqm: 59.5,
              seatCount: 24,
            },
          ],
        }),
      );
      expect(prisma.storeFloor.updateMany).not.toHaveBeenCalled();
      expect(historyRows()).toEqual([]);
    });

    it('등록은 점포코드 잠금을 잡은 뒤에 마지막 코드를 읽는다', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      await service.create(BM, createDto);
      const lockCall = tx.$executeRaw.mock.calls.findIndex((call) =>
        call[0].join('').includes("'stores:store_code'"),
      );
      expect(lockCall).toBeGreaterThanOrEqual(0);
      const lockedAt: number =
        tx.$executeRaw.mock.invocationCallOrder[lockCall];
      expect(lockedAt).toBeLessThan(firstCall(prisma.store.findFirst));
    });

    it.each([
      [
        '폐점',
        (s: StoreManagementService) =>
          s.update(BM, 11, updateDto({ storeStatus: 'CLOSED' })),
      ],
      ['삭제', (s: StoreManagementService) => s.remove(BM, 11)],
    ])('%s는 점포 행을 잠근 뒤에 근로계약을 다시 센다', async (_, act) => {
      await act(service);
      expect(firstCall(tx.$queryRaw)).toBeLessThan(
        firstCall(tx.contract.count),
      );
    });

    it('수정의 최초 인증도 번호로 잠근 뒤 다시 센다', async () => {
      await service.update(
        BM,
        11,
        updateDto({ businessVerification: identity }),
      );
      const lockCall = tx.$executeRaw.mock.calls.findIndex((call) =>
        call.slice(1).includes('stores:biz:1234567890'),
      );
      expect(lockCall).toBeGreaterThanOrEqual(0);
      const lockedAt: number =
        tx.$executeRaw.mock.invocationCallOrder[lockCall];
      expect(lockedAt).toBeLessThan(firstCall(tx.storeBusinessProfile.count));
    });

    describe('재인증', () => {
      const verified = storeRow({
        businessProfile: {
          bizRegistrationNumber: '1234567890',
          bizCeoName: '김대표',
          bizOpenDate: new Date('2020-03-02T00:00:00Z'),
          bizVerifiedAt: new Date('2026-10-01T00:00:00Z'),
          bizTradeName: null,
          bizCeoPhone: null,
          bizZipCode: null,
          bizAddress: null,
          bizAddressDetail: null,
          bizCategory: null,
          bizItem: null,
        },
      });

      it('개업일자만 달라도 400 이고 국세청에 묻지 않는다', async () => {
        prisma.store.findFirst.mockResolvedValue(verified);
        await expect(
          service.update(
            BM,
            11,
            updateDto({
              businessVerification: { ...identity, openDate: '2021-01-01' },
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(verifier!.verify).not.toHaveBeenCalled();
      });

      it('대표자명이 같은 재인증은 인증일시만 바꾸고 이력을 남기지 않는다', async () => {
        prisma.store.findFirst.mockResolvedValue(verified);
        await service.update(
          BM,
          11,
          updateDto({ businessVerification: identity }),
        );
        const { update } = prisma.storeBusinessProfile.upsert.mock.calls[0][0];
        expect(update.bizVerifiedAt.getTime()).toBeGreaterThan(
          new Date('2026-10-01T00:00:00Z').getTime(),
        );
        expect(historyRows()).toEqual([]);
      });

      it('국세청 정보와 맞지 않으면 400 이고 아무것도 쓰지 않는다', async () => {
        verifier!.verify.mockResolvedValue(false);
        await expect(
          service.update(BM, 11, updateDto({ businessVerification: identity })),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.store.updateMany).not.toHaveBeenCalled();
      });
    });

    it('주소 · 위도 · 경도 이력은 한 줄 표기다', async () => {
      await service.update(
        BM,
        11,
        updateDto({
          zipCode: '06612',
          address: '서울특별시 서초구 서초대로 2',
          addressDetail: null,
          latitude: 37.5,
          longitude: 127.1,
        }),
      );
      const byField = Object.fromEntries(
        historyRows().map((h) => [h.field, [h.beforeValue, h.afterValue]]),
      );
      expect(byField['주소']).toEqual([
        '(06611) 서울특별시 서초구 서초대로 1 1층',
        '(06612) 서울특별시 서초구 서초대로 2',
      ]);
      expect(byField['위도 · 경도']).toEqual([
        '37.491234, 127.012345',
        '37.5, 127.1',
      ]);
    });

    it('삭제를 잠근 뒤 보니 그사이 지워졌으면 404', async () => {
      tx.$queryRaw.mockResolvedValue([
        { storeStatusCode: 'NOT_OPERATING', isDeleted: true },
      ]);
      await expect(service.remove(BM, 11)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.store.updateMany).not.toHaveBeenCalled();
    });

    it('폐점한 점포는 다시 폐점으로 저장할 수도 없다 — 상태 규칙이 스스로 막는다', () => {
      expect(canTransition('CLOSED', 'CLOSED')).toBe(false);
    });

    it('점포 등록 트랜잭션이 시간을 넘기면(P2028) 500 이 아니라 503 이다', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('timeout', {
          code: 'P2028',
          clientVersion: 'test',
        }),
      );
      await expect(service.create(BM, createDto)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('P2002 가 아닌 Prisma 오류는 409 로 바꾸지 않는다', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      const failure = new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test',
      });
      prisma.store.create.mockRejectedValue(failure);
      await expect(service.create(BM, createDto)).rejects.toBe(failure);
    });
  });

  describe('리뷰 반영 — 원인을 남긴다', () => {
    let error: jest.SpyInstance;
    let warn: jest.SpyInstance;
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = { buffer: PNG, size: 8, originalname: 'a.png' };

    beforeEach(() => {
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });
    afterEach(() => {
      error.mockRestore();
      warn.mockRestore();
    });

    it('서명 주소를 못 만들면 null 로 두되 저장소 키와 원인을 warn 으로 남긴다', async () => {
      const key = 'stores/11/00000000-0000-4000-8000-000000000000.jpg';
      prisma.store.findFirst.mockResolvedValue(
        storeRow({
          imageFiles: [
            {
              fileId: 1,
              fileName: 'a.jpg',
              fileType: 'JPG',
              sizeBytes: 1,
              storageKey: key,
            },
          ],
        }),
      );
      storage!.downloadUrl.mockRejectedValue(new Error('no credentials'));
      expect((await service.detail(BM, 11)).image?.url).toBeNull();
      expect(warn.mock.calls[0][0]).toContain(key);
      expect(String(warn.mock.calls[0][1])).toContain('no credentials');
    });

    it('S3 올리기 실패는 503 으로 바꾸기 전에 원인을 error 로 남긴다', async () => {
      storage!.put.mockRejectedValue(new Error('AccessDenied'));
      await expect(service.putImage(BM, 11, upload)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(error.mock.calls[0][0]).toContain('storeId=11');
      expect(String(error.mock.calls[0][1])).toContain('AccessDenied');
    });

    it('올린 파일을 지우지 못하면 그 키를 error 로 남기고, 원래 오류를 낸다', async () => {
      const failure = new Error('db down');
      prisma.storeImageFile.create.mockRejectedValue(failure);
      storage!.delete.mockRejectedValue(new Error('delete denied'));
      await expect(service.putImage(BM, 11, upload)).rejects.toBe(failure);
      const key = storage!.put.mock.calls[0][0] as string;
      const logged = error.mock.calls.find(([m]) => String(m).includes(key));
      expect(logged).toBeDefined();
      expect(String(logged![1])).toContain('delete denied');
    });

    it('진위확인 연동 오류는 503 전에 사업자번호와 원인을 남긴다 — 대표자명은 남기지 않는다', async () => {
      verifier!.verify.mockRejectedValue(new Error('quota exceeded'));
      await expect(
        service.verifyBusiness(BM, {
          bizRegistrationNumber: '1234567890',
          ceoName: '김대표',
          openDate: '2020-03-02',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(error.mock.calls[0][0]).toContain('1234567890');
      expect(error.mock.calls[0][0]).not.toContain('김대표');
      expect(String(error.mock.calls[0][1])).toContain('quota exceeded');
    });

    it('진위확인 연동이 없으면 기동할 때 warn 으로 알린다', async () => {
      verifier = null;
      await build();
      service.onModuleInit();
      expect(warn.mock.calls[0][0]).toContain('진위확인');
    });

    it('연동 · 저장소가 다 있으면 기동 경고를 남기지 않는다', () => {
      service.onModuleInit();
      expect(warn).not.toHaveBeenCalled();
    });

    it('저장소 설정이 없으면 기동할 때 warn 으로 알린다 — 조회의 이미지가 조용히 사라지지 않게', async () => {
      storage = null;
      await build();
      service.onModuleInit();
      expect(warn.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
        '저장소',
      );
    });

    it('목록에서 서명이 여러 건 실패해도 warn 은 한 줄이다 — 몇 건인지와 첫 원인', async () => {
      const row = (storeId: number) => ({
        storeId,
        storeCode: `ST0000${storeId}`,
        name: '서초점',
        storeTypeCode: 'DIRECT',
        storeStatusCode: 'OPERATING',
        bpCodeId: 3,
        phone: null,
        address: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        bpCode: { tradeName: '모리커피' },
        businessProfile: null,
        imageFiles: [
          {
            fileId: storeId,
            fileName: 'a.jpg',
            fileType: 'JPG',
            sizeBytes: 1,
            storageKey: `stores/${storeId}/00000000-0000-4000-8000-000000000000.jpg`,
          },
        ],
      });
      prisma.store.findMany.mockResolvedValue([row(11), row(12)]);
      storage!.thumbnailUrl.mockRejectedValue(new Error('no credentials'));
      const { items } = await service.list(BM, { page: 1, pageSize: 20 });
      expect(items.map((i) => i.imageUrl)).toEqual([null, null]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('2/2');
      expect(String(warn.mock.calls[0][1])).toContain('no credentials');
    });

    it('DB 오류가 났어도 행이 이미 그 파일을 가리키면(커밋 뒤 연결 끊김) 파일을 지우지 않는다', async () => {
      const failure = new Error('connection lost after commit');
      prisma.storeImageFile.create.mockRejectedValue(failure);
      prisma.storeImageFile.count.mockResolvedValue(1);
      await expect(service.putImage(BM, 11, upload)).rejects.toBe(failure);
      expect(storage!.delete).not.toHaveBeenCalled();
    });

    it('엑셀을 만들다 서버 오류가 나면 1분 제한은 그대로 걸린다 — 다시 눌러 DB 를 거듭 읽지 않게', async () => {
      prisma.store.findMany.mockRejectedValueOnce(new Error('db down'));
      await expect(service.excel(BM, {})).rejects.toThrow('db down');
      await expect(service.excel(BM, {})).rejects.toMatchObject({
        status: 429,
      });
    });
  });
});
