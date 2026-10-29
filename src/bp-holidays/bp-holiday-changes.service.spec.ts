/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import type { HolidayCaller } from './bp-holiday-access';
import { BpHolidayChangesService } from './bp-holiday-changes.service';
import type {
  SaveBpHolidayDto,
  UpdateBpHolidayDto,
} from './dto/save-bp-holiday.dto';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const today = d('2026-10-26');
const UPDATED_AT = '2026-10-02T00:00:00.000Z';
const RIGHTS = { create: true, update: true, delete: true };

const full: HolidayCaller = {
  adminAccountId: 1,
  bpCodeId: 7,
  manageAll: true,
  storeScope: null,
  rights: RIGHTS,
};
const limited: HolidayCaller = {
  ...full,
  manageAll: false,
  storeScope: new Set([10]),
};

const store = (storeId: number, name: string, status = 'OPERATING') => ({
  storeId,
  storeCode: `ST0000${storeId}`,
  name,
  storeTypeCode: 'DIRECT',
  storeStatusCode: status,
  closedDate: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  isDeleted: false,
});
const mapping = (id: number, storeId: number, name: string, start: string) => ({
  holidayStoreMappingId: id,
  storeId,
  effectiveStartDate: d(start),
  effectiveEndDate: null,
  store: store(storeId, name),
});

/** 9-21 부터 매주 · 진행 중 · 판교점(10) · 서초점(11, 오늘 더함) */
const weekly = (over: Record<string, unknown> = {}) => ({
  bpHolidayId: 3,
  name: '정기휴무',
  description: null,
  isAllStores: false,
  holidayTypeCode: 'REPEAT',
  startDate: d('2026-09-21'),
  endDate: null,
  holidayRepeatTypeCode: 'WEEKLY',
  repeatEndType: 'NONE',
  repeatEndDate: null,
  repeatCount: null,
  createdAt: new Date('2026-09-15T00:00:00.000Z'),
  createdBy: 1,
  updatedAt: new Date(UPDATED_AT),
  updatedBy: 1,
  storeMappings: [
    mapping(1, 10, '판교점', '2026-09-21'),
    mapping(2, 11, '서초점', '2026-10-26'),
  ],
  excludedStores: [],
  ...over,
});

const form = (over: Partial<UpdateBpHolidayDto> = {}): UpdateBpHolidayDto => ({
  name: '정기휴무',
  description: null,
  holidayTypeCode: 'REPEAT',
  startDate: '2026-09-21',
  holidayRepeatTypeCode: 'WEEKLY',
  repeatEndType: 'NONE',
  isAllStores: false,
  storeIds: [10, 11],
  updatedAt: UPDATED_AT,
  ...over,
});

describe('BpHolidayChangesService', () => {
  let service: BpHolidayChangesService;
  const tx = {
    $queryRaw: jest.fn(),
    bpHoliday: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    store: { findMany: jest.fn() },
    holidayStoreMapping: { createMany: jest.fn(), updateMany: jest.fn() },
    holidayExcludedStore: { createMany: jest.fn(), updateMany: jest.fn() },
    bpHolidayChangeHistory: { createMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const histories = () =>
    tx.bpHolidayChangeHistory.createMany.mock.calls.flatMap(
      ([arg]) => arg.data,
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ bp_holiday_id: 3 }]);
    tx.bpHoliday.findFirst.mockResolvedValue(weekly());
    tx.bpHoliday.create.mockResolvedValue({ bpHolidayId: 9 });
    tx.store.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        [
          store(10, '판교점'),
          store(11, '서초점'),
          store(12, '성수점'),
          store(13, '폐점점', 'CLOSED'),
          { ...store(14, '지운점'), isDeleted: true },
        ].filter((s) => where.storeId.in.includes(s.storeId)),
      ),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        BpHolidayChangesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(BpHolidayChangesService);
  });

  describe('create', () => {
    const dto: SaveBpHolidayDto = {
      name: '임시 휴무',
      holidayTypeCode: 'DAY',
      startDate: '2026-11-02',
      isAllStores: false,
      storeIds: [10],
    };

    it('대상 점포를 휴일 시작일부터 묶고 등록 이력을 남긴다', async () => {
      await expect(service.create(full, dto, today)).resolves.toEqual({
        bpHolidayId: 9,
      });
      expect(tx.bpHoliday.create.mock.calls[0][0].data).toMatchObject({
        bpCodeId: 7,
        name: '임시 휴무',
        endDate: d('2026-11-02'),
        createdBy: 1,
        storeMappings: {
          createMany: {
            data: [
              {
                storeId: 10,
                effectiveStartDate: d('2026-11-02'),
                createdBy: 1,
                updatedBy: 1,
              },
            ],
          },
        },
      });
      expect(histories()).toEqual([
        expect.objectContaining({
          bpHolidayId: 9,
          field: '등록',
          afterValue: '임시 휴무 · 판교점 · 하루 · 2026-11-02',
        }),
      ]);
    });

    it('일부 점포 사용자는 전체 점포 휴일을 등록하지 못한다', async () => {
      await expect(
        service.create(limited, { ...dto, isAllStores: true }, today),
      ).rejects.toThrow(ForbiddenException);
    });

    it('맡지 않은 점포는 403, 다른 BP · 지운 · 폐점한 점포는 사유와 점포 ID 를 담아 400', async () => {
      await expect(
        service.create(limited, { ...dto, storeIds: [11] }, today),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.create(full, { ...dto, storeIds: [10, 99] }, today),
      ).rejects.toThrow('이 BP 의 점포가 아닙니다: 99');
      await expect(
        service.create(full, { ...dto, storeIds: [14] }, today),
      ).rejects.toThrow('지운 점포입니다: 14');
      await expect(
        service.create(full, { ...dto, storeIds: [13] }, today),
      ).rejects.toThrow('폐점한 점포는 대상으로 더할 수 없습니다: 13');
    });

    it('폐점한 점포를 예외 점포로 두는 것은 막지 않는다 — 빼려는 것이라 해가 없다', async () => {
      await service.create(
        full,
        {
          ...dto,
          isAllStores: true,
          storeIds: undefined,
          excludedStoreIds: [13],
        },
        today,
      );
      expect(tx.bpHoliday.create.mock.calls[0][0].data).toMatchObject({
        isAllStores: true,
        excludedStores: {
          createMany: { data: [expect.objectContaining({ storeId: 13 })] },
        },
      });
    });

    it('특정 점포 휴일은 대상 점포가 하나 이상이어야 한다', async () => {
      await expect(
        service.create(full, { ...dto, storeIds: [] }, today),
      ).rejects.toThrow('대상 점포를 하나 이상 골라 주세요.');
    });
  });

  describe('update', () => {
    it('다른 사용자가 먼저 고쳤으면 409', async () => {
      await expect(
        service.update(
          full,
          3,
          form({ updatedAt: '2026-10-03T00:00:00.000Z' }),
          today,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('없거나 볼 수 없는 휴일은 404', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      await expect(service.update(full, 3, form(), today)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('끝난 휴일은 409', async () => {
      tx.bpHoliday.findFirst.mockResolvedValue(
        weekly({ repeatEndType: 'UNTIL_DATE', repeatEndDate: d('2026-10-19') }),
      );
      await expect(
        service.update(
          full,
          3,
          form({ repeatEndType: 'UNTIL_DATE', repeatEndDate: '2026-10-19' }),
          today,
        ),
      ).rejects.toThrow('끝난 휴일은 고칠 수 없습니다.');
    });

    it('진행 중인 휴일의 날짜 · 반복 · 적용 범위는 바꾸지 못한다(409)', async () => {
      await expect(
        service.update(
          full,
          3,
          form({ holidayRepeatTypeCode: 'DAILY' }),
          today,
        ),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.update(
          full,
          3,
          form({ isAllStores: true, excludedStoreIds: [] }),
          today,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('뺀 점포는 어제까지, 오늘 더한 점포는 지우고, 더한 점포는 오늘부터 — 이력도 남긴다', async () => {
      await service.update(full, 3, form({ storeIds: [12] }), today);
      expect(tx.holidayStoreMapping.updateMany).toHaveBeenCalledWith({
        where: { holidayStoreMappingId: { in: [1] } },
        data: { effectiveEndDate: d('2026-10-25'), updatedBy: 1 },
      });
      expect(tx.holidayStoreMapping.updateMany).toHaveBeenCalledWith({
        where: { holidayStoreMappingId: { in: [2] } },
        data: { isDeleted: true, updatedBy: 1 },
      });
      expect(tx.holidayStoreMapping.createMany).toHaveBeenCalledWith({
        data: [
          {
            bpHolidayId: 3,
            storeId: 12,
            effectiveStartDate: today,
            createdBy: 1,
            updatedBy: 1,
          },
        ],
      });
      expect(tx.bpHoliday.update.mock.calls[0][0]).toMatchObject({
        where: { bpHolidayId: 3 },
        data: { updatedBy: 1 },
      });
      expect(
        histories().map(
          (h: {
            field: string;
            beforeValue: string | null;
            afterValue: string | null;
          }) => [h.field, h.beforeValue, h.afterValue],
        ),
      ).toEqual([
        ['대상 점포', null, '성수점 추가(2026-10-26부터)'],
        ['대상 점포', '판교점', '판교점 빼기(2026-10-25까지)'],
        ['대상 점포', '서초점', '서초점 빼기'],
      ]);
    });

    it('범위 밖 점포가 묶인 휴일 — 일부 점포 사용자는 휴일명을 못 고치고, 맡은 점포만 뺀다', async () => {
      await expect(
        service.update(limited, 3, form({ name: '바꾼 이름' }), today),
      ).rejects.toThrow(ForbiddenException);
      // 범위 밖(11)을 빼려 하면 403
      await expect(
        service.update(limited, 3, form({ storeIds: [10] }), today),
      ).rejects.toThrow('맡지 않은 점포는 다룰 수 없습니다.');
      // 맡은 점포(10)만 빼는 것은 된다
      await service.update(limited, 3, form({ storeIds: [11] }), today);
      expect(tx.holidayStoreMapping.updateMany).toHaveBeenCalledWith({
        where: { holidayStoreMappingId: { in: [1] } },
        data: { effectiveEndDate: d('2026-10-25'), updatedBy: 1 },
      });
    });

    it('시작 전 휴일은 날짜를 바꿀 수 있고, 열린 점포 기간도 새 시작일로 옮긴다', async () => {
      tx.bpHoliday.findFirst.mockResolvedValue(
        weekly({
          startDate: d('2026-11-02'),
          storeMappings: [mapping(1, 10, '판교점', '2026-11-02')],
        }),
      );
      await service.update(
        full,
        3,
        form({ startDate: '2026-11-09', storeIds: [10] }),
        today,
      );
      expect(tx.bpHoliday.update.mock.calls[0][0].data).toMatchObject({
        startDate: d('2026-11-09'),
      });
      expect(tx.holidayStoreMapping.updateMany).toHaveBeenCalledWith({
        where: { bpHolidayId: 3, isDeleted: false, effectiveEndDate: null },
        data: { effectiveStartDate: d('2026-11-09'), updatedBy: 1 },
      });
      expect(histories()).toEqual([
        expect.objectContaining({
          field: '날짜',
          beforeValue: '매주 · 시작 2026-11-02 · 종료일 없음',
          afterValue: '매주 · 시작 2026-11-09 · 종료일 없음',
        }),
      ]);
    });

    it('아무것도 바뀌지 않은 저장은 휴일 행을 건드리지 않는다 — updatedAt 이 올라 다른 화면이 가짜 409 를 받지 않게', async () => {
      await service.update(full, 3, form(), today);
      expect(tx.bpHoliday.update).not.toHaveBeenCalled();
      expect(tx.bpHolidayChangeHistory.createMany).not.toHaveBeenCalled();
    });

    describe('시작 전 휴일의 적용 범위 전환', () => {
      const upcoming = () =>
        weekly({
          startDate: d('2026-11-02'),
          storeMappings: [mapping(1, 10, '판교점', '2026-11-02')],
        });

      it('일부 → 전체 점포: 대상 점포 기간을 지우고 예외 점포를 휴일 시작일부터 넣는다', async () => {
        tx.bpHoliday.findFirst.mockResolvedValue(upcoming());
        await service.update(
          full,
          3,
          form({
            startDate: '2026-11-02',
            isAllStores: true,
            storeIds: undefined,
            excludedStoreIds: [12],
          }),
          today,
        );
        expect(tx.holidayStoreMapping.updateMany).toHaveBeenCalledWith({
          where: { holidayStoreMappingId: { in: [1] } },
          data: { isDeleted: true, updatedBy: 1 },
        });
        expect(tx.holidayExcludedStore.createMany).toHaveBeenCalledWith({
          data: [
            {
              bpHolidayId: 3,
              storeId: 12,
              effectiveStartDate: d('2026-11-02'),
              createdBy: 1,
              updatedBy: 1,
            },
          ],
        });
        expect(tx.bpHoliday.update.mock.calls[0][0].data).toMatchObject({
          isAllStores: true,
        });
        expect(
          histories().map(
            (h: {
              field: string;
              beforeValue: string | null;
              afterValue: string | null;
            }) => [h.field, h.beforeValue, h.afterValue],
          ),
        ).toEqual([
          ['적용 범위', '일부 점포', '전체 점포'],
          ['대상 점포', '판교점', '판교점 빼기'],
          ['예외 점포', null, '성수점 추가(2026-11-02부터)'],
        ]);
      });

      it('전체 → 일부 점포: 예외 점포 기간을 지우고 대상 점포를 넣는다', async () => {
        tx.bpHoliday.findFirst.mockResolvedValue(
          weekly({
            startDate: d('2026-11-02'),
            isAllStores: true,
            storeMappings: [],
            excludedStores: [
              {
                holidayExcludedStoreId: 7,
                storeId: 11,
                effectiveStartDate: d('2026-11-02'),
                effectiveEndDate: null,
                store: store(11, '서초점'),
              },
            ],
          }),
        );
        await service.update(
          full,
          3,
          form({ startDate: '2026-11-02', isAllStores: false, storeIds: [10] }),
          today,
        );
        expect(tx.holidayExcludedStore.updateMany).toHaveBeenCalledWith({
          where: { holidayExcludedStoreId: { in: [7] } },
          data: { isDeleted: true, updatedBy: 1 },
        });
        expect(tx.holidayStoreMapping.createMany).toHaveBeenCalledWith({
          data: [
            expect.objectContaining({
              storeId: 10,
              effectiveStartDate: d('2026-11-02'),
            }),
          ],
        });
      });

      it('일부 점포 사용자는 적용 범위를 바꾸지 못한다(403)', async () => {
        tx.bpHoliday.findFirst.mockResolvedValue(upcoming());
        await expect(
          service.update(
            limited,
            3,
            form({
              startDate: '2026-11-02',
              isAllStores: true,
              storeIds: undefined,
              excludedStoreIds: [],
            }),
            today,
          ),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    it('일부 점포 사용자는 전체 점포 휴일의 예외 점포를 바꾸지 못한다(403)', async () => {
      tx.bpHoliday.findFirst.mockResolvedValue(
        weekly({ isAllStores: true, storeMappings: [] }),
      );
      const fa = { ...limited, storeScope: null };
      await expect(
        service.update(
          fa,
          3,
          form({
            isAllStores: true,
            storeIds: undefined,
            excludedStoreIds: [10],
          }),
          today,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('terminate — 강제 종료', () => {
    it('반복은 「특정 날짜까지 · 어제」로 바꾸고 횟수를 지운다', async () => {
      await service.terminate(full, 3, UPDATED_AT, today);
      expect(tx.bpHoliday.update.mock.calls[0][0].data).toEqual({
        repeatEndType: 'UNTIL_DATE',
        repeatEndDate: d('2026-10-25'),
        repeatCount: null,
        updatedBy: 1,
      });
      expect(histories()).toEqual([
        expect.objectContaining({
          field: '강제 종료',
          beforeValue: '매주 · 시작 2026-09-21 · 종료일 없음',
          afterValue: '매주 · 시작 2026-09-21 · 2026-10-25까지',
        }),
      ]);
    });

    it('기간은 종료일을 어제로', async () => {
      tx.bpHoliday.findFirst.mockResolvedValue(
        weekly({
          holidayTypeCode: 'PERIOD',
          endDate: d('2026-11-30'),
          holidayRepeatTypeCode: null,
          repeatEndType: null,
        }),
      );
      await service.terminate(full, 3, UPDATED_AT, today);
      expect(tx.bpHoliday.update.mock.calls[0][0].data).toEqual({
        endDate: d('2026-10-25'),
        updatedBy: 1,
      });
    });

    it('오늘 이후에 시작한 휴일은 409 — 삭제를 안내한다', async () => {
      tx.bpHoliday.findFirst.mockResolvedValue(weekly({ startDate: today }));
      await expect(
        service.terminate(full, 3, UPDATED_AT, today),
      ).rejects.toThrow(
        '어제 이전에 시작한 휴일만 강제 종료할 수 있습니다 — 오늘부터 시작하는 휴일은 삭제해 주세요.',
      );
    });

    it('범위 밖 점포가 묶인 휴일은 일부 점포 사용자가 끝내지 못한다', async () => {
      await expect(
        service.terminate(limited, 3, UPDATED_AT, today),
      ).rejects.toThrow(ForbiddenException);
    });

    it('다른 사용자가 먼저 고쳤으면 409', async () => {
      await expect(
        service.terminate(full, 3, '2026-10-03T00:00:00.000Z', today),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('remove — 삭제', () => {
    it('오늘 이후에 시작하는 휴일만 지운다', async () => {
      await expect(service.remove(full, 3, UPDATED_AT, today)).rejects.toThrow(
        '이미 지난 날짜가 있는 휴일은 지울 수 없습니다 — 강제 종료해 주세요.',
      );
      tx.bpHoliday.findFirst.mockResolvedValue(weekly({ startDate: today }));
      await service.remove(full, 3, UPDATED_AT, today);
      expect(tx.bpHoliday.update.mock.calls[0][0]).toEqual({
        where: { bpHolidayId: 3 },
        data: { isDeleted: true, updatedBy: 1 },
      });
      expect(histories()).toEqual([
        expect.objectContaining({ field: '삭제', beforeValue: '정기휴무' }),
      ]);
    });

    it('읽은 뒤 다른 사용자가 고쳤으면 지우지 않는다(409) — 지운 휴일은 되살릴 수 없다', async () => {
      tx.bpHoliday.findFirst.mockResolvedValue(weekly({ startDate: today }));
      await expect(
        service.remove(full, 3, '2026-10-03T00:00:00.000Z', today),
      ).rejects.toThrow(ConflictException);
      expect(tx.bpHoliday.update).not.toHaveBeenCalled();
    });
  });
});
