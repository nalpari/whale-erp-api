import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MyAttendanceService } from './my-attendance.service';

const AGREED = {
  locationConsentId: 1,
  consentVersion: 'v1.2',
  agreedAt: new Date('2026-10-01T00:00:00Z'),
  pausedAt: null,
  withdrawnAt: null,
};
const STORE = {
  storeId: 7,
  name: '웨일카페 강남역점',
  address: '서울 강남구 테헤란로 1',
  addressDetail: '1층',
  latitude: new Prisma.Decimal('37.498095'),
  longitude: new Prisma.Decimal('127.027610'),
  isLocationApplied: true,
};
const READ = {
  locationAccessLogId: 900,
  occurredAt: new Date('2026-10-22T00:01:00Z'),
};

/** 받은 객체의 code */
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return {
      type: (e as Error).constructor,
      body: (e as { getResponse?: () => unknown }).getResponse?.(),
    };
  }
  throw new Error('거절되지 않았다');
};

describe('MyAttendanceService', () => {
  const mockDb = () => {
    const m = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
      account: {
        findUnique: jest.fn().mockResolvedValue({ status: 'JOINED' }),
      },
      staffMember: {
        findFirst: jest.fn().mockResolvedValue({
          staffMemberId: 30,
          storeId: 7,
          retiredDate: null,
        }),
      },
      store: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(STORE),
      },
      locationConsent: { findMany: jest.fn().mockResolvedValue([AGREED]) },
      termsVersion: {
        findFirst: jest.fn().mockResolvedValue({ version: 'v1.2' }),
      },
      contract: {
        findFirst: jest.fn().mockResolvedValue({ contractId: 11 }),
      },
      attendanceRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ attendanceRecordId: 500 }),
      },
      locationAccessLog: {
        create: jest.fn().mockResolvedValue({ locationAccessLogId: 900 }),
        findFirst: jest.fn().mockResolvedValue(READ),
        updateMany: jest.fn(),
      },
      workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
    };
    m.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(m));
    return m;
  };

  let db: ReturnType<typeof mockDb>;
  let service: MyAttendanceService;

  beforeEach(async () => {
    db = mockDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MyAttendanceService,
        { provide: PrismaService, useValue: db },
      ],
    }).compile();
    service = moduleRef.get(MyAttendanceService);
  });

  describe('get', () => {
    it('고른 근무지의 좌표(숫자) · 반경 100m · 위치 적용, 동의 상태, 오늘 근무스케줄', async () => {
      db.workSchedule.findMany.mockResolvedValue([
        {
          startAt: new Date('2026-10-22T00:00:00Z'),
          endAt: new Date('2026-10-22T09:00:00Z'),
          breakMinutes: 60,
        },
      ]);
      const res = await service.get(12, 30);
      expect(res.store).toEqual({
        storeId: 7,
        name: '웨일카페 강남역점',
        address: '서울 강남구 테헤란로 1 1층',
        latitude: 37.498095,
        longitude: 127.02761,
        radiusMeters: 100,
        isLocationApplied: true,
      });
      expect(res.locationConsent).toEqual({
        state: 'AGREED',
        needsReconsent: false,
        termsVersion: 'v1.2',
      });
      expect(res.checkInBlock).toBeNull();
      expect(res.openCheckIn).toBeNull();
      expect(res.todaySchedules).toEqual([
        expect.objectContaining({
          startTime: '09:00',
          endTime: '18:00',
          breakMinutes: 60,
        }),
      ]);
    });

    it('내 소속이 아니면 404 — 소속 규칙은 직원 앱과 같다(체결 완료 · 가입 완료 · 재직)', async () => {
      db.staffMember.findFirst.mockResolvedValue(null);
      await expect(service.get(12, 30)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(db.staffMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            staffMemberId: 30,
            accountId: 12,
            employmentStatus: 'EMPLOYED',
            joinStatus: 'JOINED',
          }) as unknown,
        }),
      );
    });
  });

  describe('locationRead', () => {
    it('계정 행을 잠그고 같은 처리 일시로 확인자료 수집 · 이용을 남긴 뒤 수집 id 를 돌려준다 — 기록에는 아직 잇지 않는다', async () => {
      const res = await service.locationRead(12, { staffMemberId: 30 });
      expect(db.$queryRaw).toHaveBeenCalled();
      const rows = db.locationAccessLog.create.mock.calls.map(
        (c) => (c as [{ data: Record<string, unknown> }])[0].data,
      );
      expect(rows).toEqual([
        {
          accountId: 12,
          action: 'COLLECT',
          occurredAt: expect.any(Date) as unknown,
          method: '기기 GPS · 휴대전화 안 판정',
        },
        {
          accountId: 12,
          action: 'USE',
          occurredAt: rows[0].occurredAt,
          method: '기기 GPS · 휴대전화 안 판정',
        },
      ]);
      expect(res).toEqual({ locationReadId: 900 });
    });

    it('위치를 보지 않는 근무지면 400, 동의가 없으면 403 — 남기지 않는다', async () => {
      db.store.findUniqueOrThrow.mockResolvedValueOnce({
        ...STORE,
        isLocationApplied: false,
      });
      await expect(
        service.locationRead(12, { staffMemberId: 30 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      db.locationConsent.findMany.mockResolvedValue([]);
      const r = await codeOf(service.locationRead(12, { staffMemberId: 30 }));
      expect(r.body).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });
      expect(db.locationAccessLog.create).not.toHaveBeenCalled();
    });
  });

  describe('checkIn', () => {
    it('계정 행을 잠그고, 서버 시각으로 출근 한 줄을 남기고 위치 읽음의 확인자료(수집 · 이용)를 잇는다 — 좌표는 없다', async () => {
      const res = await service.checkIn(12, {
        staffMemberId: 30,
        reviewReason: 'OUT_OF_RADIUS_CHECKIN',
        locationReadId: 900,
      });
      const sql = (
        db.$queryRaw.mock.calls[0] as [TemplateStringsArray]
      )[0].join('?');
      expect(sql).toContain('FROM accounts');
      expect(sql).toContain('FOR UPDATE');
      const { data } = (
        db.attendanceRecord.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0];
      expect(data).toEqual({
        staffMemberId: 30,
        storeId: 7,
        kind: 'CHECK_IN',
        recordedAt: expect.any(Date) as unknown,
        receivedAt: data.recordedAt,
        reviewReason: 'OUT_OF_RADIUS_CHECKIN',
        checkInAttendanceRecordId: null,
      });
      expect(db.locationAccessLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            locationAccessLogId: 900,
            accountId: 12,
            action: 'COLLECT',
            attendanceRecordId: null,
          },
        }),
      );
      expect(db.locationAccessLog.updateMany).toHaveBeenCalledWith({
        where: {
          accountId: 12,
          attendanceRecordId: null,
          OR: [
            { locationAccessLogId: 900 },
            { action: 'USE', occurredAt: READ.occurredAt },
          ],
        },
        data: { attendanceRecordId: 500 },
      });
      expect(res).toMatchObject({
        attendanceRecordId: 500,
        kind: 'CHECK_IN',
        storeName: '웨일카페 강남역점',
        reviewReason: 'OUT_OF_RADIUS_CHECKIN',
        checkInRecordedAt: null,
      });
    });

    it('일시 중지면 403 LOCATION_PAUSED', async () => {
      db.locationConsent.findMany.mockResolvedValue([
        { ...AGREED, pausedAt: new Date() },
      ]);
      const r = await codeOf(
        service.checkIn(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.type).toBe(ForbiddenException);
      expect(r.body).toMatchObject({ code: 'LOCATION_PAUSED' });
      expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    });

    it.each([
      ['미동의', []],
      ['철회', [{ ...AGREED, withdrawnAt: new Date() }]],
      ['약관 버전이 바뀜', [{ ...AGREED, consentVersion: 'v1.1' }]],
    ])('%s 이면 403 LOCATION_CONSENT_REQUIRED', async (_, rows) => {
      db.locationConsent.findMany.mockResolvedValue(rows);
      const r = await codeOf(
        service.checkIn(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.type).toBe(ForbiddenException);
      expect(r.body).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });
    });

    it.each([
      ['위치 읽음이 없으면', undefined],
      ['위치 읽음이 내 것이 아니거나 이미 썼으면', 901],
    ])('위치를 보는 근무지에 %s 400', async (_, locationReadId) => {
      db.locationAccessLog.findFirst.mockResolvedValue(null);
      await expect(
        service.checkIn(12, { staffMemberId: 30, locationReadId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    });

    it('위치를 보지 않는 근무지는 동의를 보지 않고 확인자료도 잇지 않는다 — 사유 · 위치 읽음이 오면 400', async () => {
      db.store.findUniqueOrThrow.mockResolvedValue({
        ...STORE,
        isLocationApplied: false,
      });
      db.locationConsent.findMany.mockResolvedValue([]);
      await service.checkIn(12, { staffMemberId: 30 });
      expect(db.locationAccessLog.updateMany).not.toHaveBeenCalled();
      for (const extra of [
        { reviewReason: 'OUT_OF_RADIUS_CHECKIN' as const },
        { locationReadId: 900 },
      ])
        await expect(
          service.checkIn(12, { staffMemberId: 30, ...extra }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('오늘을 덮는 계약이 없고 서명 대기 계약이 있으면 422 CONTRACT_PENDING_SIGNATURE 와 그 계약 (ATT-12)', async () => {
      db.contract.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ contractId: 44 });
      const r = await codeOf(
        service.checkIn(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.type).toBe(UnprocessableEntityException);
      expect(r.body).toMatchObject({
        code: 'CONTRACT_PENDING_SIGNATURE',
        contractId: 44,
      });
      expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    });

    it('위치를 보는데 근무지 좌표가 없으면 422 STORE_LOCATION_MISSING — 남기지 않는다(ATT-36)', async () => {
      db.store.findUniqueOrThrow.mockResolvedValue({
        ...STORE,
        latitude: null,
      });
      const r = await codeOf(
        service.checkIn(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.type).toBe(UnprocessableEntityException);
      expect(r.body).toMatchObject({ code: 'STORE_LOCATION_MISSING' });
      expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    });

    it('계약도 서명 대기도 없으면 422 NO_CONTRACT', async () => {
      db.contract.findFirst.mockResolvedValue(null);
      const r = await codeOf(
        service.checkIn(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.body).toMatchObject({ code: 'NO_CONTRACT', contractId: null });
    });

    it('퇴직일이 지났으면 계약을 보지 않고 422 NO_CONTRACT', async () => {
      db.staffMember.findFirst.mockResolvedValue({
        staffMemberId: 30,
        storeId: 7,
        retiredDate: new Date('2000-01-01T00:00:00Z'),
      });
      const r = await codeOf(
        service.checkIn(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.body).toMatchObject({ code: 'NO_CONTRACT' });
      expect(db.contract.findFirst).not.toHaveBeenCalled();
    });

    it('어느 소속에든 열린 출근이 있으면 409 ALREADY_CHECKED_IN 과 그 출근', async () => {
      const recordedAt = new Date('2026-10-22T00:02:00Z');
      db.attendanceRecord.findFirst.mockResolvedValue({
        attendanceRecordId: 400,
        staffMemberId: 31,
        storeId: 8,
        recordedAt,
      });
      db.store.findUniqueOrThrow
        .mockResolvedValueOnce(STORE)
        .mockResolvedValueOnce({ name: '웨일카페 역삼점' });
      const r = await codeOf(
        service.checkIn(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.type).toBe(ConflictException);
      expect(r.body).toMatchObject({
        code: 'ALREADY_CHECKED_IN',
        openCheckIn: {
          attendanceRecordId: 400,
          staffMemberId: 31,
          storeName: '웨일카페 역삼점',
          recordedAt,
        },
      });
      // 열린 출근은 짝 퇴근이 없는 출근 — 계정의 모든 소속에서
      expect(db.attendanceRecord.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            kind: 'CHECK_IN',
            staffMember: { accountId: 12 },
            attendanceRecordsAsCheckIn: { none: {} },
          },
        }),
      );
    });
  });

  describe('checkOut', () => {
    const open = {
      attendanceRecordId: 400,
      staffMemberId: 30,
      storeId: 7,
      recordedAt: new Date('2026-10-22T00:02:00Z'),
    };

    it('고른 소속의 열린 출근에 짝을 지어 퇴근 — 위치 조작 감지도 사유를 붙여 받는다 (ATT-21)', async () => {
      db.attendanceRecord.findFirst.mockResolvedValue(open);
      const res = await service.checkOut(12, {
        staffMemberId: 30,
        reviewReason: 'MOCK_LOCATION',
        locationReadId: 900,
      });
      const { data } = (
        db.attendanceRecord.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0];
      expect(data).toMatchObject({
        kind: 'CHECK_OUT',
        reviewReason: 'MOCK_LOCATION',
        checkInAttendanceRecordId: 400,
      });
      expect(res.checkInRecordedAt).toEqual(open.recordedAt);
    });

    it('계약 기간은 보지 않는다 — 열린 출근을 닫지 못하면 기록이 더 망가진다', async () => {
      db.attendanceRecord.findFirst.mockResolvedValue(open);
      db.contract.findFirst.mockResolvedValue(null);
      await service.checkOut(12, { staffMemberId: 30, locationReadId: 900 });
      expect(db.contract.findFirst).not.toHaveBeenCalled();
      expect(db.attendanceRecord.create).toHaveBeenCalled();
    });

    it('열린 출근이 없으면 409 NO_OPEN_CHECK_IN', async () => {
      const r = await codeOf(
        service.checkOut(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.type).toBe(ConflictException);
      expect(r.body).toMatchObject({
        code: 'NO_OPEN_CHECK_IN',
        openCheckIn: null,
      });
    });

    it('다른 소속에 열린 출근이 있으면 409 와 그 출근 — 이 소속으로 닫지 않는다', async () => {
      db.attendanceRecord.findFirst.mockResolvedValue({
        ...open,
        staffMemberId: 31,
        storeId: 8,
      });
      db.store.findUniqueOrThrow
        .mockResolvedValueOnce(STORE)
        .mockResolvedValueOnce({ name: '웨일카페 역삼점' });
      const r = await codeOf(
        service.checkOut(12, { staffMemberId: 30, locationReadId: 900 }),
      );
      expect(r.body).toMatchObject({
        code: 'NO_OPEN_CHECK_IN',
        openCheckIn: { staffMemberId: 31, storeName: '웨일카페 역삼점' },
      });
      expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    });
  });
});
