import { randomBytes } from 'node:crypto';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
  storeId: 5,
  ...patch,
});

describe('MyMembershipsService', () => {
  let findMany: jest.Mock;
  let findFirst: jest.Mock;
  let findStores: jest.Mock;

  const build = async (key: Buffer | null = KEY) => {
    findMany = jest.fn().mockResolvedValue([staffRow()]);
    findFirst = jest
      .fn()
      .mockResolvedValue({ staffMemberId: 31, staffTaxProfile: null });
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
            staffMember: { findMany, findFirst },
            store: { findMany: findStores },
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

    it('소속이 없으면(연결 보류 · 모두 퇴직) 빈 목록, 점포를 읽지 않는다', async () => {
      const service = await build();
      findMany.mockResolvedValue([]);
      expect(await service.list(12)).toEqual({ items: [], total: 0 });
      expect(findStores).not.toHaveBeenCalled();
    });
  });

  describe('taxProfile', () => {
    it('내 재직 직원 레코드인지 같은 조건으로 확인한다 — 경로의 id 만으로 남의 레코드를 열 수 없다', async () => {
      const service = await build();
      await service.taxProfile(12, 31);
      expect(firstArg(findFirst).where).toEqual({
        staffMemberId: 31,
        accountId: 12,
        ...ACTIVE_STAFF,
      });
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
        taxProfile: null,
      });
    });

    it('가린 주민등록번호 · 계좌번호와 은행 · 수집 목적 · 일시만 — 원문은 응답에 없다', async () => {
      const service = await build();
      findFirst.mockResolvedValue({
        staffMemberId: 31,
        staffTaxProfile: taxProfile(31),
      });
      const res = await service.taxProfile(12, 31);
      expect(res).toEqual({
        staffMemberId: 31,
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

    it('다른 행의 암호문이면 풀지 못하고 던진다 — 남의 주민등록번호를 내 것처럼 보이지 않는다', async () => {
      const service = await build();
      findFirst.mockResolvedValue({
        staffMemberId: 31,
        staffTaxProfile: taxProfile(99),
      });
      await expect(service.taxProfile(12, 31)).rejects.toThrow();
    });

    it('신고 정보가 있는데 키가 없으면 503', async () => {
      const service = await build(null);
      findFirst.mockResolvedValue({
        staffMemberId: 31,
        staffTaxProfile: taxProfile(31),
      });
      await expect(service.taxProfile(12, 31)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('키가 없어도 신고 정보가 없으면 200', async () => {
      const service = await build(null);
      expect((await service.taxProfile(12, 31)).taxProfile).toBeNull();
    });
  });
});
