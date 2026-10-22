import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CodesService, PLATFORM_BP_CODE } from './codes.service';

describe('CodesService', () => {
  let service: CodesService;
  let prisma: {
    bpCode: { findFirst: jest.Mock };
    codeGroup: { findMany: jest.Mock };
    codeItem: { findMany: jest.Mock };
  };

  const group = (groupCode: string, over: Record<string, unknown> = {}) => ({
    groupCode,
    manageOwnerCode: 'PLATFORM_FIXED',
    isBpApplied: false,
    ...over,
  });
  const item = (
    groupCode: string,
    itemCode: string,
    bpCode: string,
    label = itemCode,
  ) => ({
    groupCode,
    itemCode,
    bpCode,
    label,
  });

  beforeEach(async () => {
    prisma = {
      bpCode: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ bpCodeId: 1, bpCode: 'BP000123' }),
      },
      codeGroup: { findMany: jest.fn().mockResolvedValue([]) },
      codeItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [CodesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(CodesService);
  });

  describe('forBp', () => {
    it('사용 중 · 미삭제 그룹과 상세를 표시 순서대로 읽는다', async () => {
      await service.forBp('BP000123');
      expect(prisma.codeGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isDeleted: false, status: 'ACTIVE' },
          orderBy: [{ sortOrder: 'asc' }, { groupCode: 'asc' }],
        }),
      );
      expect(prisma.codeItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            isDeleted: false,
            status: 'ACTIVE',
            groupCode: { in: [] },
            bpCode: { in: [PLATFORM_BP_CODE, 'BP000123'] },
          },
          orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
        }),
      );
    });

    it('플랫폼제공 그룹은 적용 여부와 관계없이 그 BP 행, 플랫폼고정 그룹은 플랫폼 원본 행', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([
        group('BANK'),
        group('INDUSTRY', {
          manageOwnerCode: 'PLATFORM_PROVIDED',
          isBpApplied: true,
        }),
        group('EMP_TYPE', {
          manageOwnerCode: 'PLATFORM_PROVIDED',
          isBpApplied: false,
        }),
      ]);
      prisma.codeItem.findMany.mockResolvedValue([
        item('BANK', 'KB', 'BP000000', '국민'),
        item('INDUSTRY', 'FOOD', 'BP000000', '원본 외식'),
        item('INDUSTRY', 'FOOD', 'BP000123', '우리 외식'),
        item('INDUSTRY', 'OWN', 'BP000123', 'BP전용'),
        item('EMP_TYPE', 'FULL', 'BP000000', '정규'),
        item('EMP_TYPE', 'FULL', 'BP000123', '복사본'),
      ]);

      await expect(service.forBp('BP000123')).resolves.toEqual({
        BANK: [{ value: 'KB', label: '국민', order: 1 }],
        INDUSTRY: [
          { value: 'FOOD', label: '우리 외식', order: 1 },
          { value: 'OWN', label: 'BP전용', order: 2 },
        ],
        EMP_TYPE: [{ value: 'FULL', label: '복사본', order: 1 }],
      });
    });

    // 아직 복사받지 않은 BP(이 기준 전에 가입하고 [BP에 적용]을 받지 못한 BP)는 빈 목록이다 — 플랫폼 원본으로 대신하지
    // 않는다(2026-10-22 결정, 배포 뒤 [BP에 적용]으로 채운다).
    it('플랫폼제공 그룹에 그 BP 행이 없으면 플랫폼 원본으로 대신하지 않고 빈 목록', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([
        group('EMP_TYPE', {
          manageOwnerCode: 'PLATFORM_PROVIDED',
          isBpApplied: false,
        }),
      ]);
      prisma.codeItem.findMany.mockResolvedValue([
        item('EMP_TYPE', 'FULL', 'BP000000', '정규'),
      ]);

      await expect(service.forBp('BP000123')).resolves.toEqual({
        EMP_TYPE: [],
      });
    });

    it('상세가 없는 그룹도 빈 목록으로 둔다', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([group('EMPTY')]);
      await expect(service.forBp('BP000123')).resolves.toEqual({ EMPTY: [] });
    });
  });

  describe('forPlatform', () => {
    it('플랫폼 BP 의 공통코드만 읽고 BP 를 따로 찾지 않는다', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([group('BANK')]);
      prisma.codeItem.findMany.mockResolvedValue([
        item('BANK', 'KB', PLATFORM_BP_CODE),
      ]);

      await expect(service.forPlatform()).resolves.toEqual({
        BANK: [{ value: 'KB', label: 'KB', order: 1 }],
      });
      const [{ where }] = prisma.codeItem.findMany.mock.calls[0] as [
        { where: { bpCode: unknown } },
      ];
      expect(where.bpCode).toEqual({ in: [PLATFORM_BP_CODE] });
      expect(prisma.bpCode.findFirst).not.toHaveBeenCalled();
    });

    it('그룹을 고르면 그 그룹만 읽고, 없거나 사용하지 않는 그룹은 빈 목록으로 둔다', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([group('BANK')]);
      prisma.codeItem.findMany.mockResolvedValue([
        item('BANK', 'KB', PLATFORM_BP_CODE),
      ]);

      await expect(service.forPlatform(['BANK', 'NOPE'])).resolves.toEqual({
        BANK: [{ value: 'KB', label: 'KB', order: 1 }],
        NOPE: [],
      });
      expect(prisma.codeGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            isDeleted: false,
            status: 'ACTIVE',
            groupCode: { in: ['BANK', 'NOPE'] },
          },
        }),
      );
    });
  });

  describe('forBpId', () => {
    it('지우지 않은 BP 면 그 BP 코드로 읽는다 — 플랫폼 BP 도, 탈퇴한 BP 도 막지 않는다', async () => {
      prisma.codeGroup.findMany.mockResolvedValue([group('BANK')]);
      prisma.codeItem.findMany.mockResolvedValue([
        item('BANK', 'KB', 'BP000000'),
      ]);

      await expect(service.forBpId(1, ['BANK', 'NOPE'])).resolves.toEqual({
        BANK: [{ value: 'KB', label: 'KB', order: 1 }],
        NOPE: [],
      });
      expect(prisma.bpCode.findFirst).toHaveBeenCalledWith({
        where: { bpCodeId: 1, isDeleted: false },
        select: { bpCode: true },
      });
      const [{ where }] = prisma.codeItem.findMany.mock.calls[0] as [
        { where: { bpCode: unknown } },
      ];
      expect(where.bpCode).toEqual({ in: [PLATFORM_BP_CODE, 'BP000123'] });
    });

    it('없거나 삭제된 BP 면 null 이고 공통코드를 읽지 않는다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(null);
      await expect(service.forBpId(1)).resolves.toBeNull();
      expect(prisma.codeGroup.findMany).not.toHaveBeenCalled();
    });
  });
});
