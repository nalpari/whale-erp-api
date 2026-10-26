import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AttendanceKind,
  AttendanceReviewReason,
  Prisma,
} from '@prisma/client';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import {
  locationConsentOf,
  needsLocationReconsent,
} from '../my-profile/location-consent-state';
import { currentLocationTermsVersion } from '../my-profile/location-terms';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, kstDayStart, kstToday } from '../staff-members/kst-date';
import { ACTIVE_STAFF } from '../todos/todo-rules';
import { kstTimeOf } from '../work-schedules/work-schedule-rules';
import { contractCovers } from '../work-schedules/work-schedules.service';
import {
  DEFAULT_GEOFENCE_RADIUS_M,
  LOCATION_ACCESS_METHOD,
} from './attendance-rules';
import type {
  AttendanceConsentDto,
  AttendanceRecordResultDto,
  AttendanceStoreDto,
  CheckInBlockDto,
  CheckInDto,
  CheckOutDto,
  LocationReadDto,
  LocationReadResultDto,
  MyAttendanceResponseDto,
  OpenCheckInDto,
} from './dto/my-attendance.dto';

type Db = Prisma.TransactionClient;

const MEMBERSHIP_NOT_FOUND = '소속을 찾을 수 없습니다';

const rejection = (
  status: HttpStatus,
  error: string,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => ({ statusCode: status, error, code, message, ...extra });

/**
 * 직원 근무 앱 출퇴근 등록(WHALEERP-210 · 211 · 212 · 213). 위치 판정은 휴대전화 안에서 하고, 서버는 고른 근무지의 좌표 ·
 * 반경을 내려주고(210) 출근 · 퇴근과 확인 필요 사유만 받는다 — 좌표 · 거리 · 반경 안밖은 받지도 남기지도 않는다(ATT-05 ·
 * ATT-19). 근무지는 앱 전역에서 고른 소속 하나다(ATT-07) — 가장 가까운 곳을 고르지 않는다.
 *
 * 앱은 출근 · 퇴근 버튼을 누를 때만 위치를 읽고, 읽을 때마다 위치 읽음(`locationRead`)으로 확인자료(수집 · 이용)를 남긴다 —
 * 읽기나 등록의 성공 · 실패와 관계없다. 등록에 성공하면 그 읽음의 확인자료를 기록에 잇는다(ATT-22, 2026-10-26 재영).
 *
 * 등록은 계정 행을 잠근 채 판정하고 쓴다 — 같은 계정의 출근 · 퇴근 · 위치정보 동의 바꾸기가 한 줄로 서서, 두 기기에서 동시에
 * 눌러도 먼저 처리된 것만 남는다(211). 기록 시각은 서버가 요청을 받은 시각이다(209).
 */
@Injectable()
export class MyAttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  /** 출퇴근 화면 — 고른 근무지 · 동의 상태 · 출근을 막는 까닭 · 열린 출근 · 오늘 근무스케줄 */
  async get(
    accountId: number,
    staffMemberId: number,
  ): Promise<MyAttendanceResponseDto> {
    const db: Db = this.prisma;
    const member = await membershipOf(db, accountId, staffMemberId);
    const today = kstToday();
    const [store, locationConsent, checkInBlock, openCheckIn, schedules] =
      await Promise.all([
        storeOf(db, member.storeId),
        consentOf(db, accountId),
        checkInBlockOf(db, member, today),
        openCheckInOf(db, accountId),
        db.workSchedule.findMany({
          where: {
            staffMemberId,
            isDeleted: false,
            startAt: {
              gte: kstDayStart(today),
              lt: kstDayStart(addDays(today, 1)),
            },
          },
          orderBy: [{ startAt: 'asc' }, { workScheduleId: 'asc' }],
          select: { startAt: true, endAt: true, breakMinutes: true },
        }),
      ]);
    return {
      staffMemberId,
      store,
      locationConsent,
      checkInBlock,
      openCheckIn,
      todaySchedules: schedules.map((s) => ({
        ...s,
        startTime: kstTimeOf(s.startAt),
        endTime: kstTimeOf(s.endAt),
      })),
    };
  }

  /**
   * 위치 읽음(ATT-22) — 앱이 출근 · 퇴근 버튼을 눌러 휴대전화 위치를 읽을 때마다 부른다. 확인자료 둘(수집 · 이용)을 남기고 수집의
   * id 를 돌려준다. 위치 자체는 받지 않는다. 막는 것: 내 소속이 아님(404) · 위치를 보지 않는 근무지(400) · 위치정보 동의 없음 ·
   * 다시 동의 필요 · 일시 중지(403) — 이때는 앱이 위치를 읽지 않아야 한다.
   */
  locationRead(
    accountId: number,
    dto: LocationReadDto,
  ): Promise<LocationReadResultDto> {
    return this.locked(accountId, async (tx) => {
      const member = await membershipOf(tx, accountId, dto.staffMemberId);
      const store = await storeOf(tx, member.storeId);
      if (!store.isLocationApplied)
        throw new BadRequestException(
          '위치를 보지 않는 근무지는 위치를 읽지 않습니다',
        );
      await assertConsentUsable(tx, accountId);
      const occurredAt = new Date();
      const collect = await tx.locationAccessLog.create({
        data: {
          accountId,
          action: 'COLLECT',
          occurredAt,
          method: LOCATION_ACCESS_METHOD,
        },
        select: { locationAccessLogId: true },
      });
      await tx.locationAccessLog.create({
        data: {
          accountId,
          action: 'USE',
          occurredAt,
          method: LOCATION_ACCESS_METHOD,
        },
      });
      return { locationReadId: collect.locationAccessLogId };
    });
  }

  /**
   * 출근(211). 막는 것: 내 소속이 아님(404) · 위치정보 동의 없음 · 다시 동의 필요 · 일시 중지(403) · 오늘이 체결 완료 계약
   * 기간 밖(422, ATT-12) · 위치를 보는데 근무지 좌표가 없음(422, ATT-36) · 어느 소속에든 열린 출근이 있음(409). 반경 밖은 막지 않고 `OUT_OF_RADIUS_CHECKIN` 을 붙여 받는다
   * (ATT-11). 위치를 보는 점포는 이번에 읽은 위치 읽음이 있어야 한다(400). 위치를 보지 않는 점포(위치 적용 꺼짐)는 동의를 보지
   * 않고 사유 · 위치 읽음도 받지 않는다.
   */
  checkIn(
    accountId: number,
    dto: CheckInDto,
  ): Promise<AttendanceRecordResultDto> {
    return this.locked(accountId, async (tx) => {
      const member = await membershipOf(tx, accountId, dto.staffMemberId);
      const store = await storeOf(tx, member.storeId);
      // 위치를 보는데 근무지 좌표가 없으면 앱이 반경을 판정할 수 없다 — 직원 위치가 필요 없는 검사라 서버도 막는다(ATT-36)
      if (
        store.isLocationApplied &&
        (store.latitude === null || store.longitude === null)
      )
        throw new UnprocessableEntityException(
          rejection(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'Unprocessable Entity',
            'STORE_LOCATION_MISSING',
            '근무지 위치가 등록되지 않아 출근할 수 없습니다. 근무지 관리자에게 문의해 주세요',
          ),
        );
      const read = await this.assertLocationUsable(tx, accountId, store, dto);
      const block = await checkInBlockOf(tx, member, kstToday());
      if (block)
        throw new UnprocessableEntityException(
          rejection(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'Unprocessable Entity',
            block.reason,
            block.reason === 'CONTRACT_PENDING_SIGNATURE'
              ? '근로계약을 체결해야 출근할 수 있습니다'
              : '오늘은 근로계약 기간이 아니라 출근할 수 없습니다. 근무지 관리자에게 문의해 주세요',
            { contractId: block.contractId },
          ),
        );
      const open = await openCheckInOf(tx, accountId);
      if (open)
        throw new ConflictException(
          rejection(
            HttpStatus.CONFLICT,
            'Conflict',
            'ALREADY_CHECKED_IN',
            '이미 출근해 있습니다. 퇴근을 먼저 등록해 주세요',
            { openCheckIn: open },
          ),
        );
      return this.record(
        tx,
        accountId,
        member,
        store,
        'CHECK_IN',
        dto.reviewReason,
        null,
        read,
      );
    });
  }

  /**
   * 퇴근(212). 고른 소속에 열린 출근이 있어야 한다(없으면 409 — 다른 소속의 열린 출근이면 그것을 함께 돌려준다). 반경 밖 ·
   * 위치 조작 감지도 막지 않고 사유를 붙여 받는다(ATT-11 · ATT-21). 계약 기간은 보지 않는다 — 열린 출근을 닫지 못하면 기록이
   * 더 망가진다. 등록한 기록은 직원이 되돌리지 못한다(관리자 보정만).
   */
  checkOut(
    accountId: number,
    dto: CheckOutDto,
  ): Promise<AttendanceRecordResultDto> {
    return this.locked(accountId, async (tx) => {
      const member = await membershipOf(tx, accountId, dto.staffMemberId);
      const store = await storeOf(tx, member.storeId);
      const read = await this.assertLocationUsable(tx, accountId, store, dto);
      const open = await openCheckInOf(tx, accountId);
      if (!open || open.staffMemberId !== member.staffMemberId)
        throw new ConflictException(
          rejection(
            HttpStatus.CONFLICT,
            'Conflict',
            'NO_OPEN_CHECK_IN',
            open
              ? `${open.storeName}에 열린 출근이 있습니다. 그 근무지를 골라 퇴근해 주세요`
              : '출근 기록이 없어 퇴근을 등록할 수 없습니다. 근무지 관리자에게 문의해 주세요',
            { openCheckIn: open },
          ),
        );
      return this.record(
        tx,
        accountId,
        member,
        store,
        'CHECK_OUT',
        dto.reviewReason,
        open,
        read,
      );
    });
  }

  /**
   * 위치를 보는 점포면 위치정보 동의가 살아 있고(동의 · 지금 버전) 멈추지 않았어야 하고(ATT-06 · ATT-23 · ATT-26), 이번 등록에서
   * 읽은 위치 읽음(`locationReadId`, 아직 기록에 잇지 않은 내 것)이 있어야 한다(ATT-22) — 그 읽음을 돌려준다. 위치를 보지 않는
   * 점포는 앱이 위치를 읽지 않으므로 동의를 보지 않고, 확인 필요 사유 · 위치 읽음도 있을 수 없다(400).
   */
  private async assertLocationUsable(
    tx: Db,
    accountId: number,
    store: AttendanceStoreDto,
    dto: {
      reviewReason?: AttendanceReviewReason;
      locationReadId?: number;
    },
  ): Promise<{ occurredAt: Date; locationAccessLogId: number } | null> {
    if (!store.isLocationApplied) {
      if (dto.reviewReason)
        throw new BadRequestException(
          '위치를 보지 않는 근무지에는 확인 필요 사유를 보낼 수 없습니다',
        );
      if (dto.locationReadId !== undefined)
        throw new BadRequestException(
          '위치를 보지 않는 근무지에는 위치 읽음을 보낼 수 없습니다',
        );
      return null;
    }
    await assertConsentUsable(tx, accountId);
    const read =
      dto.locationReadId === undefined
        ? null
        : await tx.locationAccessLog.findFirst({
            where: {
              locationAccessLogId: dto.locationReadId,
              accountId,
              action: 'COLLECT',
              attendanceRecordId: null,
            },
            select: { locationAccessLogId: true, occurredAt: true },
          });
    if (!read)
      throw new BadRequestException(
        '위치를 확인한 기록이 없습니다. 위치를 다시 확인해 주세요',
      );
    return read;
  }

  /** 기록 한 줄. 위치를 본 등록이면 그 위치 읽음의 확인자료 둘(수집 · 이용, ATT-22)을 이 기록에 잇는다 — 위치 자체는 없다 */
  private async record(
    tx: Db,
    accountId: number,
    member: { staffMemberId: number; storeId: number },
    store: AttendanceStoreDto,
    kind: AttendanceKind,
    reviewReason: AttendanceReviewReason | undefined,
    checkIn: OpenCheckInDto | null,
    read: { occurredAt: Date; locationAccessLogId: number } | null,
  ): Promise<AttendanceRecordResultDto> {
    const now = new Date();
    const row = await tx.attendanceRecord.create({
      data: {
        staffMemberId: member.staffMemberId,
        storeId: member.storeId,
        kind,
        recordedAt: now,
        receivedAt: now,
        reviewReason: reviewReason ?? null,
        checkInAttendanceRecordId: checkIn?.attendanceRecordId ?? null,
      },
      select: { attendanceRecordId: true },
    });
    // 수집은 id 로, 같은 읽음의 이용은 같은 처리 일시로 찾는다 — 읽음은 계정 잠금 안에서 둘을 같은 시각으로 남긴다
    if (read)
      await tx.locationAccessLog.updateMany({
        where: {
          accountId,
          attendanceRecordId: null,
          OR: [
            { locationAccessLogId: read.locationAccessLogId },
            { action: 'USE', occurredAt: read.occurredAt },
          ],
        },
        data: { attendanceRecordId: row.attendanceRecordId },
      });
    return {
      attendanceRecordId: row.attendanceRecordId,
      kind,
      recordedAt: now,
      storeId: store.storeId,
      storeName: store.name,
      reviewReason: reviewReason ?? null,
      checkInRecordedAt: checkIn?.recordedAt ?? null,
    };
  }

  private locked<T>(
    accountId: number,
    work: (tx: Db) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      const account = await tx.account.findUnique({
        where: { accountId },
        select: { status: true },
      });
      if (!account || account.status === 'WITHDRAWN')
        throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
      return work(tx);
    });
  }
}

/** 내 소속 — 직원 앱의 소속 규칙(ACTIVE_STAFF, `GET /me/memberships`)과 같다. 아니면 모두 같은 404 */
async function membershipOf(db: Db, accountId: number, staffMemberId: number) {
  const member = await db.staffMember.findFirst({
    where: { staffMemberId, accountId, ...ACTIVE_STAFF },
    select: { staffMemberId: true, storeId: true, retiredDate: true },
  });
  if (!member) throw new NotFoundException(MEMBERSHIP_NOT_FOUND);
  return member;
}

async function storeOf(db: Db, storeId: number): Promise<AttendanceStoreDto> {
  const store = await db.store.findUniqueOrThrow({
    where: { storeId },
    select: {
      storeId: true,
      name: true,
      address: true,
      addressDetail: true,
      latitude: true,
      longitude: true,
      isLocationApplied: true,
    },
  });
  return {
    storeId: store.storeId,
    name: store.name,
    address:
      [store.address, store.addressDetail].filter(Boolean).join(' ') || null,
    latitude: store.latitude === null ? null : Number(store.latitude),
    longitude: store.longitude === null ? null : Number(store.longitude),
    radiusMeters: DEFAULT_GEOFENCE_RADIUS_M,
    isLocationApplied: store.isLocationApplied,
  };
}

/** 위치정보 동의가 살아 있고(동의 · 지금 버전) 멈추지 않았다(ATT-06 · ATT-23 · ATT-26). 아니면 403 */
async function assertConsentUsable(db: Db, accountId: number): Promise<void> {
  const consent = await consentOf(db, accountId);
  if (consent.state === 'PAUSED')
    throw new ForbiddenException(
      rejection(
        HttpStatus.FORBIDDEN,
        'Forbidden',
        'LOCATION_PAUSED',
        '잠시 멈춘 동안에는 앱으로 출퇴근을 등록할 수 없습니다. 출퇴근 기록은 근무지 관리자에게 문의해 주세요.',
      ),
    );
  if (consent.state !== 'AGREED' || consent.needsReconsent)
    throw new ForbiddenException(
      rejection(
        HttpStatus.FORBIDDEN,
        'Forbidden',
        'LOCATION_CONSENT_REQUIRED',
        '위치정보 이용에 동의하지 않으면 앱으로 출퇴근을 등록할 수 없습니다. 출퇴근 기록은 근무지 관리자에게 문의해 주세요.',
      ),
    );
}

async function consentOf(
  db: Db,
  accountId: number,
): Promise<AttendanceConsentDto> {
  const [rows, termsVersion] = await Promise.all([
    db.locationConsent.findMany({
      where: { accountId },
      select: {
        locationConsentId: true,
        consentVersion: true,
        agreedAt: true,
        pausedAt: true,
        withdrawnAt: true,
      },
    }),
    currentLocationTermsVersion(db),
  ]);
  const view = locationConsentOf(rows);
  return {
    state: view.state,
    needsReconsent: needsLocationReconsent(view, termsVersion),
    termsVersion,
  };
}

/**
 * 오늘(근무일) 출근을 막는 까닭(ATT-12, 2026-10-08 재영) — 오늘을 덮는 체결 완료 근로계약이 없거나(근무스케줄과 같은
 * `contractCovers`), 퇴직일이 지났다. 서명 대기 계약이 있으면 그 계약으로 안내한다 — 날인하면 바로 출근할 수 있다.
 */
async function checkInBlockOf(
  db: Db,
  member: { staffMemberId: number; retiredDate: Date | null },
  today: Date,
): Promise<CheckInBlockDto | null> {
  const retired = member.retiredDate !== null && member.retiredDate < today;
  if (!retired) {
    const covered = await db.contract.findFirst({
      where: { staffMemberId: member.staffMemberId, ...contractCovers(today) },
      select: { contractId: true },
    });
    if (covered) return null;
  }
  const pending = retired
    ? null
    : await db.contract.findFirst({
        where: {
          staffMemberId: member.staffMemberId,
          status: 'PENDING_SIGNATURE',
        },
        orderBy: { contractId: 'desc' },
        select: { contractId: true },
      });
  return pending
    ? { reason: 'CONTRACT_PENDING_SIGNATURE', contractId: pending.contractId }
    : { reason: 'NO_CONTRACT', contractId: null };
}

/**
 * 열린 출근 — 계정의 모든 소속에서 짝 퇴근이 없는 출근, 가장 늦은 것. 대신 등록한 출근도 넣는다. 한 계정에 하나만 열리게
 * 출근이 이것을 보고 막는다(211).
 */
async function openCheckInOf(
  db: Db,
  accountId: number,
): Promise<OpenCheckInDto | null> {
  const row = await db.attendanceRecord.findFirst({
    where: {
      kind: 'CHECK_IN',
      staffMember: { accountId },
      attendanceRecordsAsCheckIn: { none: {} },
    },
    orderBy: [{ recordedAt: 'desc' }, { attendanceRecordId: 'desc' }],
    select: {
      attendanceRecordId: true,
      staffMemberId: true,
      storeId: true,
      recordedAt: true,
    },
  });
  if (!row) return null;
  const store = await db.store.findUniqueOrThrow({
    where: { storeId: row.storeId },
    select: { name: true },
  });
  return { ...row, storeName: store.name };
}
