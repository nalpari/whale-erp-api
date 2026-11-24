import { randomBytes } from 'node:crypto';
import {
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  encryptPersonalData,
  staffTaxProfileAad,
} from '../common/personal-data-cipher';
import { PERSONAL_DATA_KEY } from '../common/personal-data-key.provider';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_STAFF } from '../todos/todo-rules';
import { MyMembershipsService } from './my-memberships.service';

const KEY = randomBytes(32);
type Call = {
  where: unknown;
  orderBy?: unknown;
  select: Record<string, unknown>;
};
const firstArg = (mock: jest.Mock) => (mock.mock.calls[0] as [Call])[0];
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const COLLECTED_AT = new Date('2026-09-01T01:00:00Z');

const taxProfile = (staffMemberId: number, key = KEY) => ({
  rrnEncrypted: encryptPersonalData(
    key,
    '9803041234567',
    staffTaxProfileAad('rrn_encrypted', staffMemberId),
  ),
  bankCode: '088',
  payrollAccountNumberEncrypted: encryptPersonalData(
    key,
    '110123456789',
    staffTaxProfileAad('payroll_account_number_encrypted', staffMemberId),
  ),
  purpose: '취득 신고 · 원천징수 · 급여 이체',
  collectedAt: COLLECTED_AT,
});

const staffRow = (patch: Record<string, unknown> = {}) => ({
  staffMemberId: 31,
  employmentType: 'PART_TIME',
  jobTitle: '홀',
  hiredDate: d('2026-09-01'),
  retiredDate: null,
  employmentStatus: 'EMPLOYED',
  storeId: 5,
  ...patch,
});

/** 신고 정보 조회가 읽는 직원 레코드 — 기본은 재직 중 */
const taxRow = (patch: Record<string, unknown> = {}) => ({
  staffMemberId: 31,
  employmentStatus: 'EMPLOYED',
  retiredDate: null,
  staffTaxProfile: null,
  ...patch,
});

describe('MyMembershipsService', () => {
  let findMany: jest.Mock;
  let findFirst: jest.Mock;
  let findStores: jest.Mock;
  let findStaffUnique: jest.Mock;
  let findStoreUnique: jest.Mock;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => logError.mockRestore());

  const build = async (key: Buffer | null = KEY) => {
    findMany = jest.fn().mockResolvedValue([staffRow()]);
    findFirst = jest.fn().mockResolvedValue(taxRow({ staffTaxProfile: null }));
    // 신고 정보의 지운 점포 확인(WHALEERP-765) — 기본은 살아 있는 점포
    findStaffUnique = jest.fn().mockResolvedValue({ storeId: 5 });
    findStoreUnique = jest.fn().mockResolvedValue({ isDeleted: false });
    findStores = jest.fn().mockResolvedValue([
      { storeId: 5, name: '강남점', storeTypeCode: 'FRANCHISE' },
      { storeId: 6, name: '본점', storeTypeCode: 'DIRECT' },
    ]);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MyMembershipsService,
        {
          provide: PrismaService,
          useValue: {
            staffMember: { findMany, findFirst, findUnique: findStaffUnique },
            store: { findMany: findStores, findUnique: findStoreUnique },
          },
        },
        { provide: PERSONAL_DATA_KEY, useValue: key },
      ],
    }).compile();
    return moduleRef.get(MyMembershipsService);
  };

  describe('list', () => {
    it('내 재직 직원 레코드(ACTIVE_STAFF)만, 입사일(없으면 뒤) · id 순', async () => {
      const service = await build();
      await service.list(12);
      const arg = firstArg(findMany);
      expect(arg.where).toEqual({ accountId: 12, ...ACTIVE_STAFF });
      expect(arg.orderBy).toEqual([
        { hiredDate: { sort: 'asc', nulls: 'last' } },
        { staffMemberId: 'asc' },
      ]);
    });

    it('신고 정보 · 동의 칸은 읽지 않는다 — 목록에서 복호화하지 않는다', async () => {
      const service = await build();
      await service.list(12);
      const { select } = firstArg(findMany);
      expect(select).not.toHaveProperty('staffTaxProfile');
      expect(select).not.toHaveProperty('isHqSharingConsented');
    });

    it('점포는 3팀 · 1팀 경계라 관계가 없어 storeId 로 한 번에 따로 읽는다', async () => {
      const service = await build();
      findMany.mockResolvedValue([
        staffRow(),
        staffRow({ staffMemberId: 32, storeId: 6 }),
        staffRow({ staffMemberId: 33, storeId: 6 }),
      ]);
      await service.list(12);
      expect(findStores).toHaveBeenCalledTimes(1);
      expect(firstArg(findStores).where).toEqual({ storeId: { in: [5, 6] } });
    });

    it('지운 점포(삭제 표시)의 소속은 뺀다 — 퇴직 포함이면 모두 퇴직한 뒤 지운 점포가 걸린다', async () => {
      const service = await build();
      findStores.mockResolvedValue([
        {
          storeId: 5,
          name: '강남점',
          storeTypeCode: 'FRANCHISE',
          isDeleted: true,
        },
        { storeId: 6, name: '본점', storeTypeCode: 'DIRECT', isDeleted: false },
      ]);
      findMany.mockResolvedValue([
        staffRow({ employmentStatus: 'RETIRED', retiredDate: d('2026-09-30') }),
        staffRow({ staffMemberId: 32, storeId: 6 }),
      ]);
      const res = await service.list(12, true);
      expect(res.items.map((i) => i.staffMemberId)).toEqual([32]);
      expect(res.total).toBe(1);
      expect(firstArg(findStores).select).toHaveProperty('isDeleted', true);
    });

    it('소속마다 점포 · 고용 형태 · 직무 · 입사일 · 퇴직일, { items, total }', async () => {
      const service = await build();
      findMany.mockResolvedValue([
        staffRow(),
        staffRow({
          staffMemberId: 32,
          storeId: 6,
          employmentType: 'FULL_TIME',
          hiredDate: null,
          retiredDate: d('2026-10-31'),
        }),
      ]);
      expect(await service.list(12)).toEqual({
        items: [
          {
            staffMemberId: 31,
            store: {
              storeId: 5,
              storeName: '강남점',
              storeTypeCode: 'FRANCHISE',
            },
            employmentType: 'PART_TIME',
            jobTitle: '홀',
            hiredDate: '2026-09-01',
            retiredDate: null,
          },
          {
            staffMemberId: 32,
            store: { storeId: 6, storeName: '본점', storeTypeCode: 'DIRECT' },
            employmentType: 'FULL_TIME',
            jobTitle: '홀',
            hiredDate: null,
            retiredDate: '2026-10-31',
          },
        ],
        total: 2,
      });
    });

    it('퇴직 포함(includeRetired)이면 퇴직한 레코드도 — 나머지 조건(체결 · 가입 완료)과 정렬 기준은 같다', async () => {
      const service = await build();
      await service.list(12, true);
      const arg = firstArg(findMany);
      // 재직 조건만 빠진다 — 체결 완료 · 가입 완료는 그대로
      expect(arg.where).toEqual({
        accountId: 12,
        joinStatus: ACTIVE_STAFF.joinStatus,
        contracts: ACTIVE_STAFF.contracts,
      });
      expect(arg.orderBy).toEqual([
        { hiredDate: { sort: 'asc', nulls: 'last' } },
        { staffMemberId: 'asc' },
      ]);
    });

    it('퇴직 포함이면 지금 소속(입사일 · id 순) 뒤에 퇴직한 소속을 퇴직일 최근 순으로', async () => {
      const service = await build();
      const retired = (staffMemberId: number, retiredDate: string) =>
        staffRow({
          staffMemberId,
          employmentStatus: 'RETIRED',
          retiredDate: d(retiredDate),
        });
      findMany.mockResolvedValue([
        retired(40, '2026-08-31'),
        staffRow({ staffMemberId: 31 }),
        retired(41, '2026-09-30'),
        staffRow({ staffMemberId: 32, retiredDate: d('2026-12-31') }),
        retired(42, '2026-08-31'),
      ]);
      const { items, total } = await service.list(12, true);
      expect(items.map((m) => m.staffMemberId)).toEqual([31, 32, 41, 40, 42]);
      expect(total).toBe(5);
      expect(items[2]).not.toHaveProperty('employmentStatus');
      expect(items[2].retiredDate).toBe('2026-09-30');
    });

    it('기본(퇴직 포함 아님)은 읽은 순서 그대로', async () => {
      const service = await build();
      findMany.mockResolvedValue([
        staffRow({ staffMemberId: 33 }),
        staffRow({ staffMemberId: 31 }),
      ]);
      const { items } = await service.list(12);
      expect(items.map((m) => m.staffMemberId)).toEqual([33, 31]);
    });

    it('소속이 없으면(연결 보류 · 모두 퇴직) 빈 목록, 점포를 읽지 않는다', async () => {
      const service = await build();
      findMany.mockResolvedValue([]);
      expect(await service.list(12)).toEqual({ items: [], total: 0 });
      expect(findStores).not.toHaveBeenCalled();
    });
  });

  describe('taxProfile', () => {
    it('내 소속인지 퇴직 포함 목록과 같은 조건으로 확인한다 — 경로의 id 만으로 남의 레코드를 열 수 없다', async () => {
      const service = await build();
      await service.taxProfile(12, 31);
      expect(firstArg(findFirst).where).toEqual({
        staffMemberId: 31,
        accountId: 12,
        joinStatus: ACTIVE_STAFF.joinStatus,
        contracts: ACTIVE_STAFF.contracts,
      });
    });

    it('지운 점포의 소속이면 404 — 목록과 같이 id 로도 열리지 않는다(WHALEERP-765, 재영 결정)', async () => {
      const service = await build();
      findStoreUnique.mockResolvedValue({ isDeleted: true });
      await expect(service.taxProfile(12, 31)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('재직 중이면 editable: true', async () => {
      const service = await build();
      expect((await service.taxProfile(12, 31)).editable).toBe(true);
    });

    it('퇴직한 내 소속도 가린 값으로 보인다 — 조회만(editable: false)', async () => {
      // 보존 기간(퇴직 + 3년) 안으로 시계를 고정한다 — 실제 시계면 2029-10-01 부터 파기 판정으로 바뀐다(PR #313 pr-agent)
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-10-20T03:00:00Z')); // 한국 2026-10-20 12:00
      try {
        const service = await build();
        findFirst.mockResolvedValue(
          taxRow({
            employmentStatus: 'RETIRED',
            retiredDate: d('2026-09-30'),
            staffTaxProfile: taxProfile(31),
          }),
        );
        const res = await service.taxProfile(12, 31);
        expect(res.editable).toBe(false);
        expect(res.taxProfile).toMatchObject({
          rrnMasked: '980304-1******',
          payrollAccountNumberMasked: '********6789',
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('보존 기간(퇴직 + 3년)이 지난 퇴직 레코드는 파기 배치 전이어도 신고 정보를 풀지 않는다 — 당일까지는 보인다', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-10-20T03:00:00Z')); // 한국 2026-10-20 12:00
      try {
        const service = await build();
        // 퇴직 + 3년 당일(2026-10-20)까지 남는다
        findFirst.mockResolvedValue(
          taxRow({
            employmentStatus: 'RETIRED',
            retiredDate: d('2023-10-20'),
            staffTaxProfile: taxProfile(31),
          }),
        );
        expect((await service.taxProfile(12, 31)).taxProfile).not.toBeNull();
        // 그 전날 퇴직이면 기한이 지났다 — 배치가 아직 지우지 않았어도 null
        findFirst.mockResolvedValue(
          taxRow({
            employmentStatus: 'RETIRED',
            retiredDate: d('2023-10-19'),
            staffTaxProfile: taxProfile(31),
          }),
        );
        const res = await service.taxProfile(12, 31);
        expect(res.taxProfile).toBeNull();
        expect(res.editable).toBe(false);
        // 퇴직 상태 배치가 반영되지 않은(재직 상태로 남은) 레코드도 퇴직일로 판정한다
        findFirst.mockResolvedValue(
          taxRow({
            retiredDate: d('2023-10-19'),
            staffTaxProfile: taxProfile(31),
          }),
        );
        expect((await service.taxProfile(12, 31)).taxProfile).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('퇴직일이 지났는데 배치 전(재직 상태)이어도 조회만 — 근로계약 날인과 같은 판정', async () => {
      const service = await build();
      findFirst.mockResolvedValue(taxRow({ retiredDate: d('2020-01-31') }));
      expect((await service.taxProfile(12, 31)).editable).toBe(false);
    });

    it('오늘은 한국 날짜로 센다 — UTC 로는 10-20 이어도 한국이 10-21 이면 10-20 퇴직은 퇴직, 10-21 은 퇴직 예정', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-10-20T15:30:00Z')); // 한국 2026-10-21 00:30
      try {
        const service = await build();
        findFirst.mockResolvedValue(taxRow({ retiredDate: d('2026-10-20') }));
        expect((await service.taxProfile(12, 31)).editable).toBe(false);
        findFirst.mockResolvedValue(taxRow({ retiredDate: d('2026-10-21') }));
        expect((await service.taxProfile(12, 31)).editable).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('퇴직 예정(퇴직일이 오늘 · 뒤)은 고칠 수 있다', async () => {
      const service = await build();
      findFirst.mockResolvedValue(taxRow({ retiredDate: d('2999-12-31') }));
      expect((await service.taxProfile(12, 31)).editable).toBe(true);
    });

    it('내 소속이 아니면 404', async () => {
      const service = await build();
      findFirst.mockResolvedValue(null);
      await expect(service.taxProfile(12, 99)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('아직 내지 않았으면 taxProfile: null', async () => {
      const service = await build();
      expect(await service.taxProfile(12, 31)).toEqual({
        staffMemberId: 31,
        editable: true,
        taxProfile: null,
      });
    });

    it('가린 주민등록번호 · 계좌번호와 은행 · 수집 목적 · 일시만 — 원문은 응답에 없다', async () => {
      const service = await build();
      findFirst.mockResolvedValue(taxRow({ staffTaxProfile: taxProfile(31) }));
      const res = await service.taxProfile(12, 31);
      expect(res).toEqual({
        staffMemberId: 31,
        editable: true,
        taxProfile: {
          rrnMasked: '980304-1******',
          bankCode: '088',
          payrollAccountNumberMasked: '********6789',
          purpose: '취득 신고 · 원천징수 · 급여 이체',
          collectedAt: COLLECTED_AT,
        },
      });
      const json = JSON.stringify(res);
      expect(json).not.toContain('9803041234567');
      expect(json).not.toContain('110123456789');
    });

    it.each([
      ['다른 행의 암호문(AAD 다름)', () => taxProfile(99)],
      ['다른 키로 잠근 값', () => taxProfile(31, randomBytes(32))],
    ])(
      '%s 이면 500 — 남의 주민등록번호를 내 것처럼 보이지 않고, 레코드 · 칸을 로그에 남긴다',
      async (_, row) => {
        const service = await build();
        findFirst.mockResolvedValue({
          staffMemberId: 31,
          staffTaxProfile: row(),
        });
        await expect(service.taxProfile(12, 31)).rejects.toThrow(
          InternalServerErrorException,
        );
        const [message] = logError.mock.calls[0] as [string];
        expect(message).toContain('staffMemberId=31');
        expect(message).toContain('rrn_encrypted');
      },
    );

    it('풀었는데 형식이 깨졌으면 500, 로그에 원문이 없다', async () => {
      const service = await build();
      findFirst.mockResolvedValue({
        staffMemberId: 31,
        staffTaxProfile: {
          ...taxProfile(31),
          rrnEncrypted: encryptPersonalData(
            KEY,
            '98030412',
            staffTaxProfileAad('rrn_encrypted', 31),
          ),
        },
      });
      await expect(service.taxProfile(12, 31)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(JSON.stringify(logError.mock.calls)).not.toContain('98030412');
    });

    it('신고 정보가 있는데 키가 없으면 503 — 내부 설정은 응답에 싣지 않고 로그에 남긴다', async () => {
      const service = await build(null);
      findFirst.mockResolvedValue({
        staffMemberId: 31,
        staffTaxProfile: taxProfile(31),
      });
      const err = (await service
        .taxProfile(12, 31)
        .catch((e: unknown) => e)) as ServiceUnavailableException;
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.message).not.toMatch(/키|설정/);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('PERSONAL_DATA_ENCRYPTION_KEY'),
      );
    });

    it('키가 없어도 신고 정보가 없으면 200', async () => {
      const service = await build(null);
      expect((await service.taxProfile(12, 31)).taxProfile).toBeNull();
    });
  });
});
