import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import {
  locationConsentOf,
  needsLocationReconsent,
} from '../my-profile/location-consent-state';
import { currentLocationTermsVersion } from '../my-profile/location-terms';
import { PrismaService } from '../prisma/prisma.service';
import { addMonths, kstDayStart, kstToday } from '../staff-members/kst-date';
import { kstTimeOf } from '../work-schedules/work-schedule-rules';
import { contractCovers } from '../work-schedules/work-schedules.service';
import type {
  AttendanceEditResultDto,
  AttendanceHistoryEntryDto,
  AttendanceHistoryResponseDto,
  CorrectAttendanceDto,
  ProxyAttendanceDto,
  ProxyStaffResponseDto,
} from './dto/attendance-edit.dto';
import type { AttendanceStoresQueryDto } from './dto/attendance-records.dto';

type Tx = Prisma.TransactionClient;

const RECORD_NOT_FOUND = '출퇴근 기록을 찾을 수 없습니다';
const STAFF_NOT_FOUND = '직원을 찾을 수 없습니다';
const TOO_OLD = '최근 3개월 안의 기록만 고칠 수 있습니다';
/** 보정 · 대신 등록할 수 있는 기간 — 최근 3개월(ATT-20 · WHALEERP-218) */
const EDITABLE_MONTHS = 3;
const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
/** 그날(한국) HH:mm 의 순간 */
const at = (day: Date, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(kstDayStart(day).getTime() + (h * 60 + m) * 60_000);
};
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
/** 그날 출근 · 퇴근 순간. 퇴근이 출근보다 이르거나 같으면 다음 날 퇴근(밤샘)이다 */
function shiftOf(day: Date, checkIn?: string, checkOut?: string) {
  const inAt = checkIn ? at(day, checkIn) : null;
  let outAt = checkOut ? at(day, checkOut) : null;
  if (outAt && checkIn && checkOut && minutes(checkOut) <= minutes(checkIn))
    outAt = new Date(outAt.getTime() + 24 * 60 * 60_000);
  return { inAt, outAt };
}
/** 아직 오지 않은 시각은 받지 않는다 — 오늘 출근을 미리 넣거나, 오늘 출근의 다음 날 퇴근을 미리 넣는 것 */
function assertNotFuture(...times: (Date | null)[]) {
  const now = Date.now();
  if (times.some((t) => t && t.getTime() > now))
    throw new BadRequestException(
      '아직 오지 않은 시각은 등록할 수 없습니다. 퇴근이 출근보다 이르면 다음 날 퇴근입니다',
    );
}
const rejection = (
  status: HttpStatus,
  error: string,
  code: string,
  message: string,
) => ({
  statusCode: status,
  error,
  code,
  message,
});

const RECORD_SELECT = {
  attendanceRecordId: true,
  staffMemberId: true,
  storeId: true,
  kind: true,
  recordedAt: true,
  reviewReason: true,
  checkInAttendanceRecordId: true,
} as const satisfies Prisma.AttendanceRecordSelect;
type RecordRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof RECORD_SELECT;
}>;

/**
 * 관리자 웹 출퇴근 기록 보정 · 「이상 없음」 · 대신 등록 · 이력(WHALEERP-218 · 220, 데모 「보정이 필요한 기록」). 대상은 출근 기록과 그 짝
 * 퇴근(출근 없는 퇴근이면 퇴근 하나)이다 — 어느 쪽 ID 로 불러도 같은 짝을 본다. 업무 범위 밖 · 본사에게 가려지는 직원(ATT-30)은
 * 없는 것과 같은 404. 고칠 수 있는 것은 최근 3개월(그 짝의 날 기준)이다.
 */
@Injectable()
export class AttendanceEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /**
   * 보정 — 짝의 출근 · 퇴근 시각을 고치고(비었던 쪽은 새로 만든다), 원본과 떼어 보정 이력(전후 값 · 사유 · 보정자)을 남기며,
   * 확인 필요 사유를 지운다(ATT-19). 그사이 다른 관리자가 고쳤으면 409 ATTENDANCE_CHANGED — 화면은 최신 기록을 다시 받는다.
   * 새로 만드는 쪽은 관리자가 만든 기록이라 「대신 등록」(사유 = 보정 사유)으로 둔다.
   */
  async correct(
    adminAccountId: number,
    recordId: number,
    dto: CorrectAttendanceDto,
  ): Promise<AttendanceEditResultDto> {
    const access = await this.access(adminAccountId);
    return this.prisma.$transaction(async (tx) => {
      const pair = await this.lockedPair(tx, access, recordId);
      const day = pair.day;
      if (pair.checkIn && !dto.checkInTime)
        throw new BadRequestException('출근 시각을 입력해 주세요');
      if (pair.checkOut && !dto.checkOutTime)
        throw new BadRequestException('퇴근 시각을 입력해 주세요');
      if (
        (pair.checkIn?.recordedAt.toISOString() ?? null) !==
          (dto.expectedCheckInAt
            ? new Date(dto.expectedCheckInAt).toISOString()
            : null) ||
        (pair.checkOut?.recordedAt.toISOString() ?? null) !==
          (dto.expectedCheckOutAt
            ? new Date(dto.expectedCheckOutAt).toISOString()
            : null)
      )
        throw new ConflictException(
          rejection(
            HttpStatus.CONFLICT,
            'Conflict',
            'ATTENDANCE_CHANGED',
            '그사이 다른 관리자가 이 기록을 고쳤습니다. 최신 기록을 다시 불러왔습니다',
          ),
        );

      const { inAt, outAt } = shiftOf(day, dto.checkInTime, dto.checkOutTime);
      assertNotFuture(inAt, outAt);
      const before = summaryOf(
        pair.checkIn?.recordedAt ?? null,
        pair.checkOut?.recordedAt ?? null,
      );
      const after = summaryOf(inAt, outAt);
      if (before === after && !pair.hasReason)
        throw new BadRequestException('바뀐 값이 없습니다');

      const now = new Date();
      const reviewed = {
        reviewReason: null,
        reviewedBy: adminAccountId,
        reviewedAt: now,
      };
      let checkInId = pair.checkIn?.attendanceRecordId ?? null;
      if (pair.checkIn && inAt)
        await tx.attendanceRecord.update({
          where: { attendanceRecordId: pair.checkIn.attendanceRecordId },
          data: { recordedAt: inAt, ...reviewed },
        });
      else if (inAt) {
        const created = await tx.attendanceRecord.create({
          data: {
            staffMemberId: pair.staffMemberId,
            storeId: pair.storeId,
            kind: 'CHECK_IN',
            recordedAt: inAt,
            receivedAt: now,
            entryMethod: 'PROXY',
            proxyBy: adminAccountId,
            proxyReason: dto.reason,
            reviewedBy: adminAccountId,
            reviewedAt: now,
          },
          select: { attendanceRecordId: true },
        });
        checkInId = created.attendanceRecordId;
      }
      if (pair.checkOut && outAt)
        await tx.attendanceRecord.update({
          where: { attendanceRecordId: pair.checkOut.attendanceRecordId },
          data: {
            recordedAt: outAt,
            checkInAttendanceRecordId: checkInId,
            ...reviewed,
          },
        });
      else if (outAt && checkInId)
        await tx.attendanceRecord.create({
          data: {
            staffMemberId: pair.staffMemberId,
            storeId: pair.storeId,
            kind: 'CHECK_OUT',
            recordedAt: outAt,
            receivedAt: now,
            checkInAttendanceRecordId: checkInId,
            entryMethod: 'PROXY',
            proxyBy: adminAccountId,
            proxyReason: dto.reason,
            reviewedBy: adminAccountId,
            reviewedAt: now,
          },
        });
      // 이력은 짝의 원래 기록(출근, 없으면 퇴근)에 남긴다 — 기록 하나가 이력을 여럿 가진다
      await tx.attendanceCorrection.create({
        data: {
          attendanceRecordId:
            pair.checkIn?.attendanceRecordId ??
            pair.checkOut!.attendanceRecordId,
          beforeValue: valueOf(
            pair.checkIn?.recordedAt ?? null,
            pair.checkOut?.recordedAt ?? null,
          ),
          afterValue: valueOf(inAt, outAt),
          reason: dto.reason,
          correctedBy: adminAccountId,
          correctedAt: now,
        },
      });
      return {
        isPayslipConfirmed: await payslipConfirmed(tx, pair.staffMemberId, day),
      };
    });
  }

  /** 「이상 없음」(ATT-19) — 기록 값은 그대로 두고 짝의 확인 필요 사유만 지운다. 보정 이력은 남기지 않고 검토자 · 검토 시각만 */
  async review(
    adminAccountId: number,
    recordId: number,
  ): Promise<AttendanceEditResultDto> {
    const access = await this.access(adminAccountId);
    return this.prisma.$transaction(async (tx) => {
      const pair = await this.lockedPair(tx, access, recordId);
      if (!pair.hasReason)
        throw new ConflictException(
          rejection(
            HttpStatus.CONFLICT,
            'Conflict',
            'ATTENDANCE_CHANGED',
            '확인 필요 사유가 없는 기록입니다. 최신 기록을 다시 불러왔습니다',
          ),
        );
      await tx.attendanceRecord.updateMany({
        where: {
          attendanceRecordId: { in: pair.ids },
          reviewReason: { not: null },
        },
        data: {
          reviewReason: null,
          reviewedBy: adminAccountId,
          reviewedAt: new Date(),
        },
      });
      return {
        isPayslipConfirmed: await payslipConfirmed(
          tx,
          pair.staffMemberId,
          pair.day,
        ),
      };
    });
  }

  /**
   * 출퇴근 대신 등록(운영 정책 ATT-20 · 26) — 위치를 보는 점포에서 위치정보 동의가 없거나(미동의 · 철회 · 약관 바뀜) 일시 중지한
   * 직원만. 그날을 덮는 체결 완료 계약이 있고 퇴직일 전이어야 한다(근무스케줄과 같은 판정). 최근 3개월 · 오늘까지. 위치 판정도
   * 확인 필요도 없다. 퇴근 없이 출근만 넣을 때 그 계정에 열린 출근이 이미 있으면 409.
   */
  async proxy(
    adminAccountId: number,
    dto: ProxyAttendanceDto,
  ): Promise<AttendanceEditResultDto> {
    const access = await this.access(adminAccountId);
    const day = toDate(dto.date);
    assertEditable(day);
    if (day.getTime() > kstToday().getTime())
      throw new BadRequestException('오늘 이후 날짜는 등록할 수 없습니다');
    const { inAt, outAt } = shiftOf(day, dto.checkInTime, dto.checkOutTime);
    assertNotFuture(inAt, outAt);
    return this.prisma.$transaction(async (tx) => {
      const staff = await tx.staffMember.findFirst({
        where: {
          staffMemberId: dto.staffMemberId,
          storeId: { in: access.storeIds },
        },
        select: {
          staffMemberId: true,
          storeId: true,
          accountId: true,
          retiredDate: true,
          ...HQ_SHARING_SELECT,
        },
      });
      if (!staff || access.hides(staff.storeId, hqSharingConsentedOf(staff)))
        throw new NotFoundException(STAFF_NOT_FOUND);
      if (!(await proxyAllowed(tx, staff.accountId, staff.storeId)))
        throw new UnprocessableEntityException(
          rejection(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'Unprocessable Entity',
            'PROXY_NOT_ALLOWED',
            '대신 등록은 위치정보 동의를 하지 않았거나 일시 중지한 직원만 할 수 있습니다. 그 밖의 기록은 보정해 주세요',
          ),
        );
      const covered = await tx.contract.findFirst({
        where: { staffMemberId: staff.staffMemberId, ...contractCovers(day) },
        select: { contractId: true },
      });
      if (!covered || (staff.retiredDate && staff.retiredDate < day))
        throw new UnprocessableEntityException(
          rejection(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'Unprocessable Entity',
            'NO_CONTRACT',
            '그날은 체결 완료 근로계약 기간이 아니라 등록할 수 없습니다',
          ),
        );
      if (staff.accountId)
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${staff.accountId} FOR UPDATE`;
      if (!dto.checkOutTime && staff.accountId) {
        const open = await tx.attendanceRecord.findFirst({
          where: {
            kind: 'CHECK_IN',
            staffMember: { accountId: staff.accountId },
            attendanceRecordsAsCheckIn: { none: {} },
          },
          select: {
            staffMember: { select: { storeId: true, ...HQ_SHARING_SELECT } },
          },
        });
        // 열린 출근은 계정에 하나(ATT-35)라 다른 근무지의 것도 막는다. 그 근무지가 이 관리자의 범위 밖이거나 가려지면 보정을
        // 권하지 않고 다른 근무지라고만 알린다 — 점포 · 시각은 내보내지 않는다
        if (open) {
          const own =
            access.storeIds.includes(open.staffMember.storeId) &&
            !access.hides(
              open.staffMember.storeId,
              hqSharingConsentedOf(open.staffMember),
            );
          throw new ConflictException(
            rejection(
              HttpStatus.CONFLICT,
              'Conflict',
              'ALREADY_CHECKED_IN',
              own
                ? '이 직원은 퇴근하지 않은 출근이 있습니다. 퇴근까지 함께 등록하거나 그 기록을 먼저 보정해 주세요'
                : '이 직원은 다른 근무지에 퇴근하지 않은 출근이 있어 대신 등록할 수 없습니다. 그 근무지에서 퇴근이 등록된 뒤 다시 해 주세요',
            ),
          );
        }
      }
      const now = new Date();
      const proxy = {
        staffMemberId: staff.staffMemberId,
        storeId: staff.storeId,
        receivedAt: now,
        entryMethod: 'PROXY' as const,
        proxyBy: adminAccountId,
        proxyReason: dto.reason,
      };
      const checkIn = await tx.attendanceRecord.create({
        data: { ...proxy, kind: 'CHECK_IN', recordedAt: inAt! },
        select: { attendanceRecordId: true },
      });
      if (outAt) {
        await tx.attendanceRecord.create({
          data: {
            ...proxy,
            kind: 'CHECK_OUT',
            recordedAt: outAt,
            checkInAttendanceRecordId: checkIn.attendanceRecordId,
          },
        });
      }
      return {
        isPayslipConfirmed: await payslipConfirmed(
          tx,
          staff.staffMemberId,
          day,
        ),
      };
    });
  }

  /** 대신 등록 선택지 — 점포 조건 안에서 그날 대신 등록할 수 있는 직원(ATT-20 · 26 · STAFF-29), 점포 · 이름순 */
  async proxyStaff(
    adminAccountId: number,
    stores: AttendanceStoresQueryDto,
    dateYmd: string,
  ): Promise<ProxyStaffResponseDto> {
    const access = await this.access(adminAccountId);
    const day = toDate(dateYmd);
    const storeIds = access.storeIds.filter(
      (id) =>
        (!stores.storeIds || stores.storeIds.includes(id)) &&
        (!stores.storeTypes ||
          stores.storeTypes.some((t) => t === access.typeOf.get(id))),
    );
    if (!storeIds.length) return { items: [] };
    const [candidates, storeRows] = await Promise.all([
      this.prisma.staffMember.findMany({
        where: {
          storeId: { in: storeIds },
          contracts: { some: contractCovers(day) },
          OR: [{ retiredDate: null }, { retiredDate: { gte: day } }],
        },
        select: {
          staffMemberId: true,
          name: true,
          storeId: true,
          accountId: true,
          ...HQ_SHARING_SELECT,
        },
      }),
      this.prisma.store.findMany({
        where: { storeId: { in: storeIds } },
        select: { storeId: true, name: true },
      }),
    ]);
    const storeNameOf = new Map(storeRows.map((s) => [s.storeId, s.name]));
    const items: ProxyStaffResponseDto['items'] = [];
    for (const c of candidates) {
      if (access.hides(c.storeId, hqSharingConsentedOf(c))) continue;
      if (!(await proxyAllowed(this.prisma, c.accountId, c.storeId))) continue;
      items.push({
        staffMemberId: c.staffMemberId,
        name: c.name,
        storeId: c.storeId,
        storeName: storeNameOf.get(c.storeId) ?? '',
      });
    }
    items.sort(
      (a, b) =>
        a.storeName.localeCompare(b.storeName) ||
        a.name.localeCompare(b.name) ||
        a.staffMemberId - b.staffMemberId,
    );
    return { items };
  }

  /** 이력(데모 「○○ 출퇴근 기록 이력」) — 짝의 보정 이력과 대신 등록, 새것부터 */
  async history(
    adminAccountId: number,
    recordId: number,
  ): Promise<AttendanceHistoryResponseDto> {
    const access = await this.access(adminAccountId);
    const pair = await this.pairOf(this.prisma, access, recordId);
    return { items: await editHistory(this.prisma, pair.ids) };
  }

  /** 관리 점포와 본사에게 가려지는지. 사용 중인 관리자 계정이 아니면 403 */
  private async access(adminAccountId: number) {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const typeOf = new Map(
      manageable.stores.map((s) => [s.storeId, s.storeTypeCode]),
    );
    return {
      storeIds: [...typeOf.keys()],
      typeOf,
      hides: (storeId: number, consented: boolean) =>
        hidesPersonalData(
          manageable.roleTypeCode,
          typeOf.get(storeId),
          consented,
        ),
    };
  }

  /** 짝을 찾고 행을 잠근다 — 같은 기록을 동시에 고치면 뒤의 요청이 앞의 결과를 보고 409 가 된다 */
  private async lockedPair(
    tx: Tx,
    access: Awaited<ReturnType<AttendanceEditService['access']>>,
    recordId: number,
  ) {
    const pair = await this.pairOf(tx, access, recordId);
    await tx.$queryRaw`SELECT 1 FROM attendance_records WHERE attendance_record_id = ANY(${pair.ids}) FOR UPDATE`;
    const fresh = await this.pairOf(tx, access, recordId);
    assertEditable(fresh.day);
    return fresh;
  }

  /** 기록 ID 로 짝(출근 + 짝 퇴근, 또는 출근 없는 퇴근)을 찾는다. 업무 범위 밖 · 가려지는 직원이면 404 */
  private async pairOf(
    db: Tx | PrismaService,
    access: Awaited<ReturnType<AttendanceEditService['access']>>,
    recordId: number,
  ) {
    const record = await db.attendanceRecord.findFirst({
      where: { attendanceRecordId: recordId, storeId: { in: access.storeIds } },
      select: { ...RECORD_SELECT, staffMember: { select: HQ_SHARING_SELECT } },
    });
    if (
      !record ||
      access.hides(record.storeId, hqSharingConsentedOf(record.staffMember))
    )
      throw new NotFoundException(RECORD_NOT_FOUND);
    let checkIn: RecordRow | null = null;
    let checkOut: RecordRow | null = null;
    if (record.kind === 'CHECK_IN') {
      checkIn = record;
      checkOut = await db.attendanceRecord.findFirst({
        where: { checkInAttendanceRecordId: record.attendanceRecordId },
        orderBy: { attendanceRecordId: 'asc' },
        select: RECORD_SELECT,
      });
    } else if (record.checkInAttendanceRecordId) {
      checkOut = record;
      checkIn = await db.attendanceRecord.findUnique({
        where: { attendanceRecordId: record.checkInAttendanceRecordId },
        select: RECORD_SELECT,
      });
    } else checkOut = record;
    const anchor = (checkIn ?? checkOut)!;
    return {
      staffMemberId: anchor.staffMemberId,
      storeId: anchor.storeId,
      /** 짝의 날 — 출근한 날(출근이 없으면 퇴근한 날), 한국 */
      day: kstToday(anchor.recordedAt),
      checkIn,
      checkOut,
      ids: [checkIn, checkOut].flatMap((r) =>
        r ? [r.attendanceRecordId] : [],
      ),
      hasReason: [checkIn, checkOut].some((r) => r?.reviewReason),
    };
  }
}

/**
 * 기록들의 보정 이력과 대신 등록(처리자 이름 · 일시 · 전후 값 · 사유), 새것부터 — 관리자 웹 이력 창과 직원 앱 연필 시트(HIST-1,
 * WHALEERP-222)가 같이 쓴다.
 */
export async function editHistory(
  db: Pick<Tx, 'attendanceCorrection' | 'attendanceRecord' | 'adminAccount'>,
  recordIds: number[],
  /** 직원 앱에 내리는 이력 — 이름이 없는 관리자를 로그인 아이디 대신 「관리자」로, 권한 그룹은 빼고(WHALEERP-223) */
  forStaff = false,
): Promise<AttendanceHistoryEntryDto[]> {
  const [corrections, proxies] = await Promise.all([
    db.attendanceCorrection.findMany({
      where: { attendanceRecordId: { in: recordIds } },
      orderBy: [{ correctedAt: 'desc' }, { attendanceCorrectionId: 'desc' }],
      select: {
        correctedAt: true,
        beforeValue: true,
        afterValue: true,
        reason: true,
        correctedBy: true,
      },
    }),
    db.attendanceRecord.findMany({
      where: { attendanceRecordId: { in: recordIds }, entryMethod: 'PROXY' },
      orderBy: { attendanceRecordId: 'asc' },
      select: {
        kind: true,
        recordedAt: true,
        receivedAt: true,
        proxyBy: true,
        proxyReason: true,
      },
    }),
  ]);
  const adminIds = [
    ...new Set([
      ...corrections.map((c) => c.correctedBy),
      ...proxies.flatMap((p) => (p.proxyBy ? [p.proxyBy] : [])),
    ]),
  ];
  const admins = await db.adminAccount.findMany({
    where: { adminAccountId: { in: adminIds } },
    select: {
      adminAccountId: true,
      name: true,
      loginId: true,
      roleGroup: { select: { name: true } },
    },
  });
  const adminOf = (id: number | null) =>
    admins.find((x) => x.adminAccountId === id);
  const who = (id: number | null) => {
    const a = adminOf(id);
    return {
      by: a ? (a.name ?? (forStaff ? '관리자' : a.loginId)) : '-',
      byRole: forStaff ? null : (a?.roleGroup.name ?? null),
    };
  };
  return [
    ...corrections.map((c) => ({
      at: c.correctedAt,
      kind: 'CORRECTION' as const,
      ...who(c.correctedBy),
      before: textOf(c.beforeValue),
      after: textOf(c.afterValue),
      reason: c.reason,
    })),
    // 대신 등록은 한 번에 출근 · 퇴근이 함께 생기므로 등록 시각으로 묶는다
    ...[...groupBy(proxies, (p) => p.receivedAt.toISOString()).values()].map(
      (group) => ({
        at: group[0].receivedAt,
        kind: 'PROXY' as const,
        ...who(group[0].proxyBy),
        before: null,
        after: group
          .map(
            (p) =>
              `${p.kind === 'CHECK_IN' ? '출근' : '퇴근'} ${kstTimeOf(p.recordedAt)}`,
          )
          .join(' · '),
        reason: group[0].proxyReason ?? '',
      }),
    ),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** 최근 3개월(한국 오늘 기준)이 지난 날이면 400 */
function assertEditable(day: Date) {
  if (day.getTime() < addMonths(kstToday(), -EDITABLE_MONTHS).getTime())
    throw new BadRequestException(TOO_OLD);
}

/**
 * 대신 등록할 수 있는 직원인가 — 위치를 보는 점포이고, 위치정보 동의가 없거나(미동의 · 철회 · 약관이 바뀌어 다시 받아야 함 ·
 * 가입 전이라 계정이 없음) 일시 중지했다(ATT-20 · 26). 위치를 보지 않는 점포는 앱으로 등록할 수 있어 대신 등록하지 않는다.
 */
async function proxyAllowed(
  db: Pick<Tx, 'store' | 'locationConsent' | 'termsVersion'>,
  accountId: number | null,
  storeId: number,
): Promise<boolean> {
  const store = await db.store.findUnique({
    where: { storeId },
    select: { isLocationApplied: true },
  });
  if (!store?.isLocationApplied) return false;
  if (accountId === null) return true;
  const [rows, version] = await Promise.all([
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
  return view.state !== 'AGREED' || needsLocationReconsent(view, version);
}

/** 그날이 확정 · 발송된 급여명세서 기간 안인가(218 「확정 뒤에도 고치되 경고」) */
async function payslipConfirmed(
  tx: Tx,
  staffMemberId: number,
  day: Date,
): Promise<boolean> {
  const found = await tx.payslip.findFirst({
    where: {
      staffMemberId,
      status: { in: ['CONFIRMED', 'SENT'] },
      periodStartDate: { lte: day },
      periodEndDate: { gte: day },
    },
    select: { payslipId: true },
  });
  return found !== null;
}

/** 보정 이력의 값 — 출근 · 퇴근 시각(ISO, 없으면 null) */
const valueOf = (checkIn: Date | null, checkOut: Date | null) => ({
  checkInAt: checkIn?.toISOString() ?? null,
  checkOutAt: checkOut?.toISOString() ?? null,
});
const summaryOf = (checkIn: Date | null, checkOut: Date | null) =>
  `출근 ${checkIn ? kstTimeOf(checkIn) : '없음'} · 퇴근 ${checkOut ? kstTimeOf(checkOut) : '없음'}`;
/** 이력 값 → 「출근 09:02 · 퇴근 없음」 */
function textOf(value: Prisma.JsonValue): string {
  const v = (value ?? {}) as {
    checkInAt?: string | null;
    checkOutAt?: string | null;
  };
  return summaryOf(
    v.checkInAt ? new Date(v.checkInAt) : null,
    v.checkOutAt ? new Date(v.checkOutAt) : null,
  );
}

function groupBy<T>(
  list: readonly T[],
  key: (t: T) => string,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of list)
    map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}
