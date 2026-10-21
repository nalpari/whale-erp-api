// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApiMenuUrlsService } from './api-menu-urls.service';
import { PlatformMenusService } from './platform-menus.service';

/** 저장하는 플랫폼 관리자의 계정 id. */
const PM = 1;
const UPDATED_AT = '2026-10-16T01:00:00.000Z';
const AT = new Date(UPDATED_AT);

const SERVICES = [
  { itemCode: 'WHALE_ERP', label: 'Whale ERP', status: 'ACTIVE', sortOrder: 1 },
  {
    itemCode: 'PLATFORM',
    label: 'Whale ERP 플랫폼 관리',
    status: 'ACTIVE',
    sortOrder: 2,
  },
  { itemCode: 'POS', label: 'POS', status: 'INACTIVE', sortOrder: 3 },
];

/**
 * PLATFORM: 10 시스템관리 ─ 11 관리자 관리 · 12 권한 관리, 13 커뮤니티(사용중지) ─ 14 공지사항. POS(사용중지 서비스): 20.
 * 배열 순서를 sortOrder 순서와 다르게 둔다 — DB 가 주는 물리 순서에 기대지 않고 정렬하는지 보려고.
 */
function menu(
  menuId: number,
  parentMenuId: number | null,
  sortOrder: number,
  depth: number,
  extra: Record<string, unknown> = {},
) {
  return {
    menuId,
    menuCode: `MN${String(menuId).padStart(6, '0')}`,
    serviceCode: 'PLATFORM',
    parentMenuId,
    name: `메뉴${menuId}`,
    url: `/m${menuId}`,
    sortOrder,
    depth,
    status: 'ACTIVE',
    createdAt: AT,
    updatedAt: AT,
    creator: null,
    updater: { name: '정민재', loginId: 'platjung' },
    ...extra,
  };
}
/** API 권한 주소 — 경로 방식 @MenuPermission 컨트롤러의 경로. /m14 는 메뉴 14 가 들고 있고, /platform-admins 는 이 목록에 없다. */
const API_URLS = new Set(['/m14', '/platform-admins']);

const MENUS = [
  menu(13, null, 2, 1, { url: null, status: 'INACTIVE' }),
  menu(12, 10, 2, 2),
  menu(14, 13, 1, 2),
  menu(10, null, 1, 1, { url: null }),
  menu(11, 10, 1, 2),
  menu(20, null, 1, 1, { serviceCode: 'POS' }),
];

describe('PlatformMenusService', () => {
  let service: PlatformMenusService;
  let prisma: Record<string, any>;
  let tx: Record<string, any>;

  const menusFind = ({ where }: { where: Record<string, any> }) =>
    Promise.resolve(
      MENUS.filter(
        (m) =>
          (where.serviceCode === undefined ||
            m.serviceCode === where.serviceCode) &&
          (where.status === undefined || m.status === where.status),
      ),
    );
  const menuFirst = ({ where }: { where: Record<string, any> }) =>
    Promise.resolve(MENUS.find((m) => m.menuId === where.menuId) ?? null);

  beforeEach(async () => {
    prisma = {
      codeItem: {
        findMany: jest.fn().mockResolvedValue(SERVICES),
        findFirst: jest
          .fn()
          .mockImplementation(({ where }) =>
            Promise.resolve(
              SERVICES.find((s) => s.itemCode === where.itemCode) ?? null,
            ),
          ),
      },
      menu: {
        findMany: jest.fn().mockImplementation(menusFind),
        findFirst: jest.fn().mockImplementation(menuFirst),
      },
    };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      codeItem: { findFirst: prisma.codeItem.findFirst },
      menu: {
        findMany: jest.fn().mockImplementation(menusFind),
        findFirst: jest.fn().mockImplementation(menuFirst),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ menuId: 99, menuCode: data.menuCode }),
          ),
        aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 2 } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      roleGroup: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 1 }),
      },
      roleGroupMenu: { create: jest.fn().mockResolvedValue({}) },
    };
    // 채번용 「가장 큰 코드」 조회 — orderBy 가 있는 findFirst
    tx.menu.findFirst.mockImplementation(({ where, orderBy }) =>
      orderBy
        ? Promise.resolve({ menuCode: 'MN000222' })
        : menuFirst({ where }),
    );
    prisma.$transaction = jest.fn((fn: (t: unknown) => unknown) => fn(tx));
    const module = await Test.createTestingModule({
      providers: [
        PlatformMenusService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ApiMenuUrlsService,
          useValue: { has: (url: string) => API_URLS.has(url) },
        },
      ],
    }).compile();
    service = module.get(PlatformMenusService);
  });

  describe('services', () => {
    it('공통코드 SERVICE 전부(사용중지 포함)를 순서대로, 메뉴 수 · 사용 · 미사용 수와 함께 준다', async () => {
      const result = await service.services();
      expect(prisma.codeItem.findMany.mock.calls[0][0].where).toEqual({
        groupCode: 'SERVICE',
        bpCode: 'BP000000',
        isDeleted: false,
      });
      expect(result.total).toBe(3);
      expect(result.items).toEqual([
        {
          serviceCode: 'WHALE_ERP',
          name: 'Whale ERP',
          status: 'ACTIVE',
          menuCount: 0,
          activeMenuCount: 0,
          inactiveMenuCount: 0,
        },
        {
          serviceCode: 'PLATFORM',
          name: 'Whale ERP 플랫폼 관리',
          status: 'ACTIVE',
          menuCount: 5,
          activeMenuCount: 4,
          inactiveMenuCount: 1,
        },
        {
          serviceCode: 'POS',
          name: 'POS',
          status: 'INACTIVE',
          menuCount: 1,
          activeMenuCount: 1,
          inactiveMenuCount: 0,
        },
      ]);
      expect(prisma.menu.findMany.mock.calls[0][0].where).toEqual({
        isDeleted: false,
      });
    });
  });

  describe('tree', () => {
    it('서비스의 지우지 않은 메뉴를 순서대로 중첩해 주고, 사용중지 상위 아래는 숨김으로 표시한다', async () => {
      const result = await service.tree('PLATFORM');
      expect(prisma.menu.findMany.mock.calls[0][0].where).toEqual({
        serviceCode: 'PLATFORM',
        isDeleted: false,
      });
      expect(result.total).toBe(5);
      expect(result.service).toEqual({
        serviceCode: 'PLATFORM',
        name: 'Whale ERP 플랫폼 관리',
        status: 'ACTIVE',
      });
      expect(result.items.map((m) => m.menuId)).toEqual([10, 13]);
      expect(result.items[0].children.map((m) => m.menuId)).toEqual([11, 12]);
      expect(result.items[0]).toMatchObject({
        isGroup: true,
        isHidden: false,
        url: null,
      });
      expect(result.items[1].children[0]).toMatchObject({
        menuId: 14,
        status: 'ACTIVE',
        isHidden: true,
        isGroup: false,
        children: [],
      });
    });

    it('사용중지 서비스도 트리를 준다 — 메뉴가 사용이어도 모두 숨김', async () => {
      const result = await service.tree('POS');
      expect(result.service.status).toBe('INACTIVE');
      expect(result.items).toEqual([
        expect.objectContaining({
          menuId: 20,
          status: 'ACTIVE',
          isHidden: true,
        }),
      ]);
    });

    it('없는 서비스는 404', async () => {
      await expect(service.tree('NOPE')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('detail', () => {
    it('상위 · 경로 · 묶음 여부 · 숨김과 등록자 · 수정자를 준다', async () => {
      const result = await service.detail(12);
      expect(result).toMatchObject({
        menuId: 12,
        menuCode: 'MN000012',
        serviceCode: 'PLATFORM',
        serviceName: 'Whale ERP 플랫폼 관리',
        parent: { menuId: 10, menuCode: 'MN000010', name: '메뉴10' },
        path: ['메뉴10', '메뉴12'],
        isGroup: false,
        isHidden: false,
        createdBy: null,
        updatedBy: { name: '정민재', loginId: 'platjung' },
        updatedAt: AT,
      });
      // 상위는 parent 로만 준다 — 응답 스키마에 없는 칸을 싣지 않는다.
      expect(result).not.toHaveProperty('parentMenuId');
    });

    it('최상위는 parent 가 null', async () => {
      expect((await service.detail(10)).parent).toBeNull();
    });

    it('사용중지 서비스의 메뉴는 숨김', async () => {
      expect((await service.detail(20)).isHidden).toBe(true);
    });

    it('메뉴의 서비스가 공통코드에 없으면 데이터 오류라 500 — 숨김 · 서비스명을 지어 주지 않는다', async () => {
      prisma.codeItem.findFirst.mockResolvedValue(null);
      await expect(service.detail(12)).rejects.toThrow(
        new InternalServerErrorException(
          '메뉴의 서비스(PLATFORM)가 공통코드 SERVICE 에 없습니다',
        ),
      );
    });

    it('없거나 지운 메뉴는 404 — 지운 것은 조회 조건에서 빠진다', async () => {
      await expect(service.detail(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.menu.findFirst.mock.calls[0][0].where).toEqual({
        menuId: 999,
        isDeleted: false,
      });
    });
  });

  describe('create', () => {
    const body = {
      serviceCode: 'PLATFORM',
      parentMenuId: 10,
      name: '메뉴 관리',
      url: '/menus2',
    };

    it('잠금 뒤 채번(전체 최대 +1)하고 고른 상위의 맨 끝에 사용으로 만들며, PM000001 권한 행을 함께 넣는다', async () => {
      const result = await service.create(PM, body);
      expect(result).toEqual({ menuId: 99, menuCode: 'MN000223' });
      // 잠금은 읽기(서비스 · 상위 · 채번) 전에 — 읽고 판단하고 쓰기 전체를 줄 세운다.
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        Math.min(
          tx.codeItem.findFirst.mock.invocationCallOrder[0],
          tx.menu.findFirst.mock.invocationCallOrder[0],
        ),
      );
      // 지운 메뉴까지 포함한 가장 큰 코드 — isDeleted 조건이 없다.
      const codeQuery = tx.menu.findFirst.mock.calls.find(
        ([a]) => a.orderBy,
      )[0];
      expect(codeQuery).toEqual({
        orderBy: { menuCode: 'desc' },
        select: { menuCode: true },
      });
      expect(tx.menu.aggregate.mock.calls[0][0].where).toEqual({
        parentMenuId: 10,
        isDeleted: false,
      });
      expect(tx.menu.create.mock.calls[0][0].data).toEqual({
        menuCode: 'MN000223',
        serviceCode: 'PLATFORM',
        parentMenuId: 10,
        name: '메뉴 관리',
        url: '/menus2',
        sortOrder: 3,
        depth: 2,
        status: 'ACTIVE',
        createdBy: PM,
        updatedBy: PM,
      });
      expect(tx.roleGroup.findFirst.mock.calls[0][0].where).toEqual({
        roleCode: 'PM000001',
        isDeleted: false,
      });
      expect(tx.roleGroupMenu.create).toHaveBeenCalledWith({
        data: {
          roleGroupId: 1,
          menuId: 99,
          isReadable: true,
          isCreatable: true,
          isUpdatable: true,
          isDeletable: true,
          createdBy: PM,
          updatedBy: PM,
        },
      });
    });

    it('최상위로 — 상위가 없으면 1단계, 형제가 없으면 순서 1', async () => {
      tx.menu.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      await service.create(PM, { serviceCode: 'POS', name: '첫 메뉴' });
      expect(tx.menu.create.mock.calls[0][0].data).toMatchObject({
        serviceCode: 'POS',
        parentMenuId: null,
        url: null,
        sortOrder: 1,
        depth: 1,
      });
      expect(tx.menu.aggregate.mock.calls[0][0].where).toEqual({
        serviceCode: 'POS',
        parentMenuId: null,
        isDeleted: false,
      });
    });

    it('사용중지 상위 아래에도 만든다', async () => {
      await service.create(PM, { ...body, parentMenuId: 13, url: '/x' });
      expect(tx.menu.create.mock.calls[0][0].data).toMatchObject({
        parentMenuId: 13,
        depth: 2,
      });
    });

    it.each([
      ['없는 서비스', { serviceCode: 'NOPE' }, '서비스를 찾을 수 없습니다'],
      [
        '없는 상위',
        { parentMenuId: 999 },
        '상위 메뉴로 고를 수 없는 메뉴입니다',
      ],
      [
        '다른 서비스의 상위',
        { serviceCode: 'WHALE_ERP' },
        '같은 서비스의 메뉴만 상위로 고를 수 있습니다',
      ],
    ])('%s 는 400', async (_, patch, message) => {
      await expect(service.create(PM, { ...body, ...patch })).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(tx.menu.create).not.toHaveBeenCalled();
    });

    it('여러 구간 URL 로는 등록하지 않는다 — 새 URL 은 1뎁스만', async () => {
      await expect(
        service.create(PM, { ...body, url: '/staff/content' }),
      ).rejects.toThrow(
        new BadRequestException(
          "메뉴 URL 은 '/' 하나로 시작하는 1뎁스 경로만 됩니다 — 소문자 · 숫자 · '-' 로, 구간은 '-' 로 잇습니다(예: /staff-content)",
        ),
      );
      expect(tx.menu.create).not.toHaveBeenCalled();
    });

    it('3단계 메뉴 아래에는 만들 수 없다', async () => {
      tx.menu.findFirst.mockImplementation(({ orderBy }) =>
        Promise.resolve(
          orderBy ? { menuCode: 'MN000222' } : menu(20, 11, 1, 3),
        ),
      );
      await expect(
        service.create(PM, { ...body, parentMenuId: 20 }),
      ).rejects.toThrow(
        new BadRequestException('메뉴는 최대 3단계까지만 둘 수 있습니다'),
      );
    });

    it('사용 중 메뉴와 URL 이 겹치면 409 — 겹치는 메뉴 코드를 알려 준다', async () => {
      await expect(
        service.create(PM, { ...body, url: '/m11' }),
      ).rejects.toThrow(
        new ConflictException(
          '같거나 겹치는 URL 을 쓰는 사용 중 메뉴가 있습니다(MN000011)',
        ),
      );
      const query = tx.menu.findMany.mock.calls[0][0];
      expect(query.where).toEqual({
        isDeleted: false,
        status: 'ACTIVE',
        url: { not: null },
      });
      expect(tx.menu.create).not.toHaveBeenCalled();
    });

    it('미사용으로 만들거나 URL 이 없으면 겹침을 보지 않는다', async () => {
      await service.create(PM, { ...body, url: '/m11', status: 'INACTIVE' });
      await service.create(PM, { ...body, url: null });
      expect(tx.menu.findMany).not.toHaveBeenCalled();
    });

    // 메뉴 URL 은 API 권한 키다 — 새 메뉴가 API 권한 주소를 가지면 그 API 가 새 메뉴의 권한으로도 열린다(권한 상승).
    // 미사용으로 만들어도 막는다: 원래 메뉴를 끈 뒤 켜면 같은 일이 된다.
    it.each(['ACTIVE', 'INACTIVE'] as const)(
      'API 권한 주소로는 등록하지 않는다(%s) — 409',
      async (status) => {
        await expect(
          service.create(PM, { ...body, url: '/platform-admins', status }),
        ).rejects.toThrow(
          new ConflictException(
            '다른 메뉴가 API 권한 주소를 가져갈 수 없습니다: /platform-admins',
          ),
        );
        expect(tx.$executeRaw).toHaveBeenCalled();
        expect(tx.menu.create).not.toHaveBeenCalled();
      },
    );

    it('PM000001 이 없으면 원인을 적은 500 — 권한 행 없는 메뉴를 만들지 않는다', async () => {
      tx.roleGroup.findFirst.mockResolvedValue(null);
      await expect(service.create(PM, body)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(tx.menu.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const body = {
      name: '새 이름',
      url: '/new',
      status: 'ACTIVE' as const,
      updatedAt: UPDATED_AT,
    };

    it('같은 ms 의 updatedAt 일 때만 이름 · URL · 상태를 고친다', async () => {
      await service.update(PM, 11, body);
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.menu.findFirst.mock.invocationCallOrder[0],
      );
      expect(tx.menu.updateMany).toHaveBeenCalledWith({
        where: {
          menuId: 11,
          isDeleted: false,
          updatedAt: { gte: AT, lt: new Date(AT.getTime() + 1) },
        },
        data: {
          name: '새 이름',
          url: '/new',
          status: 'ACTIVE',
          updatedBy: PM,
        },
      });
    });

    it('URL 을 빼면 비운다(null)', async () => {
      await service.update(PM, 11, {
        name: 'a',
        status: 'ACTIVE',
        updatedAt: UPDATED_AT,
      });
      expect(tx.menu.updateMany.mock.calls[0][0].data.url).toBeNull();
    });

    it('여러 구간 URL 로 바꾸면 400, 그대로 둔 여러 구간 URL 로는 이름 · 상태를 고친다', async () => {
      await expect(
        service.update(PM, 11, { ...body, url: '/m11/detail' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.menu.updateMany).not.toHaveBeenCalled();
      tx.menu.findFirst.mockImplementation(({ where, orderBy }) =>
        orderBy
          ? Promise.resolve({ menuCode: 'MN000222' })
          : where.menuId === 11
            ? Promise.resolve(
                menu(11, 10, 1, 2, { url: '/platform/system/admins' }),
              )
            : menuFirst({ where }),
      );
      await service.update(PM, 11, { ...body, url: '/platform/system/admins' });
      expect(tx.menu.updateMany).toHaveBeenCalled();
    });

    it('자기 자신과는 겹침을 보지 않는다', async () => {
      await service.update(PM, 11, { ...body, url: '/m11' });
      expect(tx.menu.updateMany).toHaveBeenCalled();
    });

    it('다른 사용 중 메뉴와 겹치면 409', async () => {
      await expect(
        service.update(PM, 11, { ...body, url: '/m12' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.menu.updateMany).not.toHaveBeenCalled();
    });

    // 메뉴 URL 은 API 권한 키이기도 하다(MenuPermission 이 컨트롤러 경로로 메뉴를 찾는다). 미사용일 때 들고 있던
    // URL 을 다시 사용으로 켜면 두 메뉴가 한 API 를 다투게 되므로 켤 때도 같은 검사를 건다.
    it('미사용 메뉴를 사용으로 켤 때 그 URL 을 다른 사용 중 메뉴가 쓰면 409', async () => {
      tx.menu.findFirst.mockImplementation(({ where, orderBy }) =>
        orderBy
          ? Promise.resolve({ menuCode: 'MN000222' })
          : where.menuId === 11
            ? Promise.resolve(
                menu(11, 10, 1, 2, { url: '/m12', status: 'INACTIVE' }),
              )
            : menuFirst({ where }),
      );
      await expect(
        service.update(PM, 11, { ...body, url: '/m12', status: 'ACTIVE' }),
      ).rejects.toThrow(
        new ConflictException(
          '같거나 겹치는 URL 을 쓰는 사용 중 메뉴가 있습니다(MN000012)',
        ),
      );
      expect(tx.menu.updateMany).not.toHaveBeenCalled();
    });

    it('미사용으로 저장하면 겹침을 보지 않는다 — 자기 메뉴(MN000215)도 막지 않는다', async () => {
      await service.update(PM, 11, {
        ...body,
        url: '/m12',
        status: 'INACTIVE',
      });
      expect(tx.menu.updateMany).toHaveBeenCalled();
    });

    describe('API 권한 주소', () => {
      // 메뉴 14 가 API 권한 주소 /m14 를 들고 있다. 바꾸면 그 API 가 다른 메뉴로 판정되거나(권한 상승) 모두 403(잠김).
      it.each([
        ['다른 값으로', '/m14-new'],
        ['빈 값(null)으로', undefined],
      ])(
        '그 메뉴의 URL 을 %s 바꾸면 409 — 고치지 않는다',
        async (_label, url) => {
          await expect(
            service.update(PM, 14, { ...body, url }),
          ).rejects.toThrow(
            new ConflictException(
              'API 권한에 쓰이는 메뉴 주소라 바꿀 수 없습니다: /m14',
            ),
          );
          expect(tx.menu.updateMany).not.toHaveBeenCalled();
        },
      );

      it('URL 은 그대로 두고 이름 · 상태(사용중지 포함)는 고친다', async () => {
        await service.update(PM, 14, {
          ...body,
          url: '/m14',
          status: 'INACTIVE',
        });
        expect(tx.menu.updateMany.mock.calls[0][0].data).toEqual({
          name: '새 이름',
          url: '/m14',
          status: 'INACTIVE',
          updatedBy: PM,
        });
      });

      it.each(['ACTIVE', 'INACTIVE'] as const)(
        '다른 메뉴가 API 권한 주소를 가져가면(%s) 409',
        async (status) => {
          await expect(
            service.update(PM, 11, {
              ...body,
              url: '/platform-admins',
              status,
            }),
          ).rejects.toThrow(
            new ConflictException(
              '다른 메뉴가 API 권한 주소를 가져갈 수 없습니다: /platform-admins',
            ),
          );
          expect(tx.menu.updateMany).not.toHaveBeenCalled();
        },
      );

      it('API 권한 주소가 아닌 메뉴의 URL 은 바꾼다', async () => {
        await service.update(PM, 11, { ...body, url: '/m11-new' });
        expect(tx.menu.updateMany.mock.calls[0][0].data.url).toBe('/m11-new');
      });
    });

    it('그 사이 다른 사람이 고쳤으면 409, 지워졌으면 404', async () => {
      tx.menu.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(PM, 11, body)).rejects.toThrow(
        new ConflictException(
          '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요',
        ),
      );
      tx.menu.findFirst
        .mockImplementationOnce(menuFirst)
        .mockResolvedValueOnce(null);
      await expect(service.update(PM, 11, body)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('없는 메뉴는 404', async () => {
      await expect(service.update(PM, 999, body)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('move', () => {
    it('잠금 뒤 그 서비스의 메뉴로 계획을 세워 바뀐 행만 고친다 — 수정 버전(updatedAt) · 수정자는 그대로', async () => {
      await service.move(11, { parentMenuId: null, index: 0 });
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.menu.findFirst.mock.invocationCallOrder[0],
      );
      expect(tx.menu.findMany.mock.calls[0][0]).toMatchObject({
        where: { serviceCode: 'PLATFORM', isDeleted: false },
        select: { updatedAt: true },
      });
      const updates = tx.menu.update.mock.calls
        .map(([a]) => [a.where.menuId, a.data])
        .sort(([a], [b]) => a - b);
      // 위치는 수정 화면의 버전에 들지 않는다 — updatedAt 을 원래 값으로 적어 @updatedAt 이 올리지 않게 하고, 순서만
      // 밀린 형제의 수정자를 옮긴 사람으로 덮지 않는다. 그래서 열어 둔 상세가 옮기기 때문에 409 를 받지 않는다.
      expect(updates).toEqual([
        [10, { parentMenuId: null, sortOrder: 2, depth: 1, updatedAt: AT }],
        [11, { parentMenuId: null, sortOrder: 1, depth: 1, updatedAt: AT }],
        [12, { parentMenuId: 10, sortOrder: 1, depth: 2, updatedAt: AT }],
        [13, { parentMenuId: null, sortOrder: 3, depth: 1, updatedAt: AT }],
      ]);
    });

    it('다른 서비스의 상위로는 400 — 아무것도 고치지 않는다', async () => {
      await expect(
        service.move(11, { parentMenuId: 20, index: 0 }),
      ).rejects.toThrow(
        new BadRequestException('같은 서비스 안에서만 옮길 수 있습니다'),
      );
      expect(tx.menu.update).not.toHaveBeenCalled();
    });

    it('없는 메뉴는 404', async () => {
      await expect(
        service.move(999, { parentMenuId: null, index: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // 쓰기는 모두 한 잠금에 줄을 서고, 잠금을 기다리는 시간도 트랜잭션 시간에 든다.
  describe('쓰기 트랜잭션', () => {
    const writes: [string, (s: PlatformMenusService) => Promise<unknown>][] = [
      [
        'create',
        (s) => s.create(PM, { serviceCode: 'PLATFORM', name: '새 메뉴' }),
      ],
      [
        'update',
        (s) =>
          s.update(PM, 11, {
            name: '이름',
            status: 'ACTIVE',
            updatedAt: UPDATED_AT,
          }),
      ],
      ['move', (s) => s.move(11, { parentMenuId: null, index: 0 })],
    ];

    it.each(writes)(
      '%s 는 기본값(대기 2초 · 실행 5초)보다 넉넉한 시간을 준다',
      async (_name, write) => {
        await write(service);
        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
          maxWait: 5_000,
          timeout: 15_000,
        });
      },
    );

    it.each(writes)(
      '%s 가 시간을 넘기면(P2028) 500 이 아니라 503 이다',
      async (_name, write) => {
        prisma.$transaction.mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('timeout', {
            code: 'P2028',
            clientVersion: 'test',
          }),
        );
        await expect(write(service)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      },
    );

    it.each(writes)(
      '%s 의 다른 Prisma 오류는 그대로 던진다',
      async (_name, write) => {
        const failure = new Prisma.PrismaClientKnownRequestError('fk', {
          code: 'P2003',
          clientVersion: 'test',
        });
        prisma.$transaction.mockRejectedValueOnce(failure);
        await expect(write(service)).rejects.toBe(failure);
      },
    );
  });
});
