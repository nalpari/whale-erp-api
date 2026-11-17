import { BadRequestException } from '@nestjs/common';
import {
  createHqStore,
  hqLocationInput,
  hqStatusOf,
  saveHqProfile,
  syncHqStatus,
} from './hq-store';

// 본사 점포(stores.is_hq) — BP 마다 하나, 직영, 점포 관리 밖에서 시스템이 만들고 상태를 맞춘다(2026-11-17).
/** 부분 일치 — lint(no-unsafe-assignment)가 any 로 보지 않게 unknown 으로 돌려준다. */
const like = (o: object): unknown => expect.objectContaining(o);
const likeList = (a: unknown[]): unknown => expect.arrayContaining(a);
/** 첫 호출의 data 인자 */
const dataOf = (m: jest.Mock): Record<string, unknown> =>
  (m.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

describe('hq-store', () => {
  const tx = () => ({
    $executeRaw: jest.fn().mockResolvedValue(1),
    store: {
      findFirst: jest.fn(),
      create: jest
        .fn()
        .mockResolvedValue({ storeId: 70, storeCode: 'ST000008' }),
      update: jest.fn().mockResolvedValue({}),
    },
    storeBusinessProfile: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    storeChangeHistory: { createMany: jest.fn().mockResolvedValue({}) },
  });

  describe('hqStatusOf — 일반 점포의 운영 조건과 같다(사업자 인증 · 좌표 · BP 사용)', () => {
    const base = {
      bizRegistrationNumber: '1234567890',
      latitude: 37.5,
      longitude: 127,
      bpAccountStatusCode: 'ACTIVE',
    };
    it('다 채우면 운영', () => {
      expect(hqStatusOf(base)).toBe('OPERATING');
    });
    it.each([
      ['사업자 인증 없음', { bizRegistrationNumber: null }],
      ['좌표 없음', { latitude: null }],
      ['BP 미사용', { bpAccountStatusCode: 'INACTIVE' }],
    ])('%s 이면 미운영', (_, patch) => {
      expect(hqStatusOf({ ...base, ...patch })).toBe('NOT_OPERATING');
    });
  });

  describe('createHqStore', () => {
    it('점포코드 잠금 뒤 다음 번호로 직영 본사 · 사업자정보 · 등록 이력을 만든다 — 좌표가 없으면 미운영', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValue({ storeCode: 'ST000007' });
      const result = await createHqStore(t as never, {
        bpCodeId: 3,
        bpAccountStatusCode: 'ACTIVE',
        tradeName: '고래상사',
        biz: { bizRegistrationNumber: '1234567890', bizCeoName: '홍길동' },
        by: 9,
      });
      expect(result).toEqual({ storeId: 70, storeCode: 'ST000008' });
      expect(t.$executeRaw).toHaveBeenCalled();
      expect(t.store.create).toHaveBeenCalledWith(
        like({
          data: like({
            storeCode: 'ST000008',
            bpCodeId: 3,
            storeTypeCode: 'DIRECT',
            name: '고래상사',
            isHq: true,
            storeStatusCode: 'NOT_OPERATING',
            createdBy: 9,
          }),
        }),
      );
      expect(t.storeBusinessProfile.create).toHaveBeenCalledWith({
        data: like({
          storeId: 70,
          bizTradeName: '고래상사',
          bizRegistrationNumber: '1234567890',
          bizCeoName: '홍길동',
          createdBy: 9,
        }),
      });
      expect(t.storeChangeHistory.createMany).toHaveBeenCalledWith({
        data: [
          like({
            storeId: 70,
            field: '등록',
            afterValue: '고래상사',
            changedBy: 9,
          }),
        ],
      });
    });

    it('점포명은 50자까지만 — 상호명이 길어도 저장된다', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValue(null);
      await createHqStore(t as never, {
        bpCodeId: 3,
        bpAccountStatusCode: 'ACTIVE',
        tradeName: '가'.repeat(60),
        biz: {},
        by: null,
      });
      const data = dataOf(t.store.create);
      expect(data.storeCode).toBe('ST000001');
      expect(data.name).toHaveLength(50);
    });

    it('사업장 주소 · 좌표를 함께 주면 본사 점포 주소 · 좌표도 채우고, 조건을 다 채우면 운영으로 만든다', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValue(null);
      await createHqStore(t as never, {
        bpCodeId: 3,
        bpAccountStatusCode: 'ACTIVE',
        tradeName: '고래상사',
        biz: {
          bizRegistrationNumber: '1234567890',
          bizZipCode: '06234',
          bizAddress: '서울 강남구 테헤란로 1',
          bizAddressDetail: '3층',
        },
        location: { latitude: 37.5, longitude: 127, isLocationApplied: true },
        by: 9,
      });
      expect(dataOf(t.store.create)).toEqual(
        like({
          zipCode: '06234',
          address: '서울 강남구 테헤란로 1',
          addressDetail: '3층',
          latitude: 37.5,
          longitude: 127,
          isLocationApplied: true,
          storeStatusCode: 'OPERATING',
        }),
      );
    });
  });

  describe('syncHqStatus', () => {
    const hq = (patch: Record<string, unknown> = {}) => ({
      storeId: 70,
      storeStatusCode: 'NOT_OPERATING',
      latitude: 37.5,
      longitude: 127,
      businessProfile: { bizRegistrationNumber: '1234567890' },
      bpCode: { accountStatusCode: 'ACTIVE' },
      ...patch,
    });

    it('조건이 바뀌면 상태를 바꾸고 「점포상태」 이력을 남긴다', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValue(hq());
      await syncHqStatus(t as never, 3, 9);
      expect(t.store.findFirst).toHaveBeenCalledWith(
        like({
          where: { bpCodeId: 3, isHq: true, isDeleted: false },
        }),
      );
      expect(t.store.update).toHaveBeenCalledWith({
        where: { storeId: 70 },
        data: { storeStatusCode: 'OPERATING', updatedBy: 9 },
      });
      expect(t.storeChangeHistory.createMany).toHaveBeenCalledWith({
        data: [
          like({
            field: '점포상태',
            beforeValue: '미운영',
            afterValue: '운영',
          }),
        ],
      });
    });

    it('운영 중에 사업자번호를 잃으면 미운영으로 내린다', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValue(
        hq({ storeStatusCode: 'OPERATING', businessProfile: null }),
      );
      await syncHqStatus(t as never, 3, 9);
      expect(t.store.update).toHaveBeenCalledWith({
        where: { storeId: 70 },
        data: { storeStatusCode: 'NOT_OPERATING', updatedBy: 9 },
      });
    });

    it('상태가 같으면 아무것도 쓰지 않는다', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValue(hq({ storeStatusCode: 'OPERATING' }));
      await syncHqStatus(t as never, 3, 9);
      expect(t.store.update).not.toHaveBeenCalled();
      expect(t.storeChangeHistory.createMany).not.toHaveBeenCalled();
    });

    it('폐점한 본사 · 본사가 없는 BP 는 건드리지 않는다', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValueOnce(
        hq({ storeStatusCode: 'CLOSED' }),
      );
      await syncHqStatus(t as never, 3, 9);
      t.store.findFirst.mockResolvedValueOnce(null);
      await syncHqStatus(t as never, 3, 9);
      expect(t.store.update).not.toHaveBeenCalled();
    });
  });

  describe('hqLocationInput', () => {
    it('위도 · 경도는 함께 넣거나 함께 비운다', () => {
      expect(() =>
        hqLocationInput({
          latitude: 37.5,
          longitude: null,
          isLocationApplied: true,
        }),
      ).toThrow(BadRequestException);
      expect(
        hqLocationInput({
          latitude: null,
          longitude: null,
          isLocationApplied: false,
        }),
      ).toEqual({ latitude: null, longitude: null, isLocationApplied: false });
      // 위치 적용을 빼면 그대로 둔다(undefined) — 좌표를 다시 보내며 빼먹어도 「사용 안 함」이 「사용」으로 바뀌지 않게
      expect(hqLocationInput({ latitude: 37.5, longitude: 127 })).toEqual({
        latitude: 37.5,
        longitude: 127,
        isLocationApplied: undefined,
      });
      // 둘 다 생략하면 그대로 둔다 — 좌표를 모르는 옛 화면이 저장해도 지워지지 않게
      expect(hqLocationInput({ isLocationApplied: true })).toBeUndefined();
    });
  });

  describe('saveHqProfile', () => {
    const before = {
      tradeName: '고래상사',
      bizRegistrationNumber: null,
      bizCeoName: null,
      bizOpenDate: null,
      bizCeoPhone: '0212345678',
      bizCeoEmail: null,
      bizZipCode: null,
      bizAddress: null,
      bizAddressDetail: null,
      bizCategory: null,
      bizItem: null,
      bizVerifiedAt: null,
      latitude: null,
      longitude: null,
      isLocationApplied: true,
    };

    it('본사 사업자정보 · 점포명 · 주소 · 좌표를 고치고, 바뀐 칸만 본사 점포 이력에 남긴 뒤 상태를 다시 정한다', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValue({
        storeId: 70,
        storeStatusCode: 'NOT_OPERATING',
        latitude: 37.5,
        longitude: 127,
        businessProfile: { bizRegistrationNumber: '1234567890' },
        bpCode: { accountStatusCode: 'ACTIVE' },
      });
      await saveHqProfile(t as never, {
        bpCodeId: 3,
        hqStoreId: 70,
        before,
        tradeName: '고래상사2',
        biz: {
          bizCeoPhone: '0212345678',
          bizZipCode: '06234',
          bizAddress: '서울 강남구 테헤란로 1',
          bizAddressDetail: null,
        },
        verified: {
          bizRegistrationNumber: '1234567890',
          bizCeoName: '홍길동',
          bizOpenDate: new Date('2020-03-02T00:00:00.000Z'),
          bizVerifiedAt: new Date('2026-11-17T00:00:00.000Z'),
        },
        location: { latitude: 37.5, longitude: 127, isLocationApplied: true },
        by: 9,
      });
      expect(t.storeBusinessProfile.update).toHaveBeenCalledWith({
        where: { storeId: 70 },
        data: like({
          bizTradeName: '고래상사2',
          bizZipCode: '06234',
          bizRegistrationNumber: '1234567890',
          bizCeoName: '홍길동',
          updatedBy: 9,
        }),
      });
      expect(t.store.update).toHaveBeenCalledWith({
        where: { storeId: 70 },
        data: {
          name: '고래상사2',
          zipCode: '06234',
          address: '서울 강남구 테헤란로 1',
          addressDetail: null,
          latitude: 37.5,
          longitude: 127,
          isLocationApplied: true,
          updatedBy: 9,
        },
      });
      const fields = (
        dataOf(t.storeChangeHistory.createMany) as unknown as {
          field: string;
        }[]
      ).map((r) => r.field);
      expect(fields).toEqual(
        likeList([
          '상호명',
          '사업장 우편번호',
          '사업장 기본주소',
          '사업자등록번호',
          '대표자명',
          '개업일자',
          '위도 · 경도',
        ]),
      );
      expect(fields).not.toContain('대표자 연락처');
      // 상태는 sync 가 다시 정한다 — 사업자번호 · 좌표 · BP 사용이 다 있어 운영
      expect(t.store.update).toHaveBeenCalledWith({
        where: { storeId: 70 },
        data: { storeStatusCode: 'OPERATING', updatedBy: 9 },
      });
    });

    it('location 을 주지 않으면 좌표는 그대로 둔다', async () => {
      const t = tx();
      t.store.findFirst.mockResolvedValue(null);
      await saveHqProfile(t as never, {
        bpCodeId: 3,
        hqStoreId: 70,
        before,
        tradeName: '고래상사',
        biz: {},
        by: 9,
      });
      const data = dataOf(t.store.update);
      expect(data).not.toHaveProperty('latitude');
      expect(t.storeChangeHistory.createMany).not.toHaveBeenCalled();
    });
  });
});
