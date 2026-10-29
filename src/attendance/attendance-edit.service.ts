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
import { ACTIVE_STAFF } from '../todos/todo-rules';
import { PrismaService } from '../prisma/prisma.service';
import {
  addDays,
  addMonths,
  kstDayStart,
  kstToday,
} from '../staff-members/kst-date';
import { kstTimeOf } from '../work-schedules/work-schedule-rules';
import { EDITABLE_MONTHS, editableStart } from './attendance-rules';
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

/**
 * 그 직원의 다른 기록과 시간이 겹치면 409 ATTENDANCE_OVERLAP — 겹친 시간이 급여 근무 분에 두 번 들어가지 않게(대신 등록 · 보정으로
 * 채우기 · 보정). 열린 출근(이미 있는 것 · 지금 출근만 넣는 것 `outAt` null)은 지금까지 근무 중으로 본다 — 닫힐 때 그 사이 기록과 같은
 * 시간이 두 번 들어가므로. 다만 고칠 수 있는 기간(3개월)보다 오래 열린 출근은 그 시각만 본다 — 보정할 수 없어 영영 막히지 않게. 출근
 * 없는 퇴근도 그 시각 한 점으로 본다. 맞닿기만 한 짝(10–15 · 15–18)은 받는다. `exclude` 는 고치는 짝 자신의 기록이다.
 */
async function assertNoOverlap(
  tx: Tx,
  staffMemberId: number,
  inAt: Date,
  outAt: Date | null,
  now: Date,
  exclude: number[] = [],
) {
  const end = outAt ?? now;
  const editable = editableStart();
  const notMine = { attendanceRecordId: { notIn: exclude } };
  const [nearby, lonelyOut] = await Promise.all([
    tx.attendanceRecord.findMany({
      where: {
        staffMemberId,
        kind: 'CHECK_IN',
        recordedAt: { lt: end },
        ...notMine,
        OR: [
          { attendanceRecordsAsCheckIn: { none: {} } },
          {
            attendanceRecordsAsCheckIn: { some: { recordedAt: { gt: inAt } } },
          },
        ],
      },
      select: {
        recordedAt: true,
        attendanceRecordsAsCheckIn: { select: { recordedAt: true } },
      },
    }),
    tx.attendanceRecord.findFirst({
      where: {
        staffMemberId,
        kind: 'CHECK_OUT',
        checkInAttendanceRecordId: null,
        recordedAt: { gte: inAt, lt: end },
        ...notMine,
      },
      select: { recordedAt: true },
    }),
  ]);
  const clash = nearby.find((r) => {
    const out = r.attendanceRecordsAsCheckIn[0]?.recordedAt;
    if (out) return inAt < out;
    const until =
      r.recordedAt >= editable
        ? now
        : new Date(r.recordedAt.getTime() + 60_000);
    return inAt < until;
  });
  if (!clash && !lonelyOut) return;
  const at = (clash ?? lonelyOut)!.recordedAt;
  const md = kstToday(at).toISOString().slice(5, 10).replace('-', '/');
  throw new ConflictException(
    rejection(
      HttpStatus.CONFLICT,
      'Conflict',
      'ATTENDANCE_OVERLAP',
      clash && !clash.attendanceRecordsAsCheckIn.length
        ? `${md} ${kstTimeOf(at)} 퇴근 미등록 출근이 있어 그 뒤 시간은 등록할 수 없습니다. 그 기록을 먼저 보정해 주세요`
        : `${md} 출퇴근 기록과 시간이 겹칩니다. 보정이 필요한 기록에서 그 줄을 보정해 주세요`,
    ),
  );
}

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
   * 새로 만드는 쪽도 「대신 등록」이 아니라 이 보정 한 건으로 본다(2026-10-26 재영 — 대신 등록은 위치정보 동의가 없거나 멈춘 직원의
   * 대체 수단뿐, ATT-20). 등록 방식은 직원 등록(SELF) 그대로 두고, 관리자가 넣은 값이라는 것은 보정 이력이 말한다.
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

      let { inAt, outAt } = shiftOf(day, dto.checkInTime, dto.checkOutTime);
      // 출근 없는 퇴근에 출근을 채울 때 출근이 퇴근보다 늦으면 전날 밤 출근이다 — 그 짝의 날은 퇴근한 날이라 퇴근은 그날 그대로 둔다
      if (
        !pair.checkIn &&
        dto.checkInTime &&
        dto.checkOutTime &&
        minutes(dto.checkOutTime) <= minutes(dto.checkInTime)
      ) {
        inAt = at(addDays(day, -1), dto.checkInTime);
        outAt = at(day, dto.checkOutTime);
      }
      // 화면이 퇴근 날(출근한 날 · 다음 날)을 보내면 그대로 따른다 — 짐작하지 않는다(PR #159 리뷰)
      if (
        pair.checkIn &&
        inAt &&
        dto.checkOutTime &&
        dto.checkOutNextDay !== undefined
      ) {
        outAt = at(
          dto.checkOutNextDay ? addDays(day, 1) : day,
          dto.checkOutTime,
        );
        if (outAt <= inAt)
          throw new BadRequestException(
            '퇴근이 출근보다 이르거나 같습니다. 다음 날 퇴근이면 「다음 날 퇴근」을 골라 주세요',
          );
      }
      // 24시간 넘는 짝(09:00 → 다음 날 10:00 — 퇴근을 출근 다음 날까지 받아 생긴다)은 시각만으로 나타낼 수 없다. 퇴근 시각을 그대로
      // 두면 원래 퇴근 순간을 지킨다 — 다시 만들면 같은 날로 당겨져 근무가 사라진다(PR #159 리뷰). 퇴근 시각을 바꾸거나 24시간 안의
      // 짝(보통 밤샘 22:00 → 06:00)이면 늘 하던 대로 시각으로 다시 만든다 — 그 짝은 시각만으로 나타낼 수 있어 짐작할 일이 없다
      else if (
        pair.checkIn &&
        pair.checkOut &&
        inAt &&
        pair.checkOut.recordedAt.getTime() - pair.checkIn.recordedAt.getTime() >
          24 * 60 * 60_000 &&
        dto.checkOutTime === kstTimeOf(pair.checkOut.recordedAt) &&
        pair.checkOut.recordedAt > inAt
      )
        outAt = pair.checkOut.recordedAt;
      assertNotFuture(inAt, outAt);
      // 짝은 출근한 날의 것이다(급여 · 목록 모두) — 출근을 전날로 옮겼으면 그날로 기간 · 명세서 확정을 본다
      const pairDay = inAt ? kstToday(inAt) : day;
      assertEditable(pairDay);
      const before = summaryOf(
        pair.checkIn?.recordedAt ?? null,
        pair.checkOut?.recordedAt ?? null,
      );
      const after = summaryOf(inAt, outAt);
      if (before === after && !pair.hasReason)
        throw new BadRequestException('바뀐 값이 없습니다');

      const now = new Date();
      // 고친 짝이 그 직원의 다른 기록과 겹치면 막는다 — 겹친 시간이 급여에 두 번 들어가지 않게(자기 짝은 빼고 본다)
      if (inAt)
        await assertNoOverlap(
          tx,
          pair.staffMemberId,
          inAt,
          outAt,
          now,
          pair.ids,
        );
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
        isPayslipConfirmed:
          (await payslipConfirmed(tx, pair.staffMemberId, pairDay)) ||
          (pairDay.getTime() !== day.getTime() &&
            (await payslipConfirmed(tx, pair.staffMemberId, day))),
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
   * 직원. 그날을 덮는 체결 완료 계약이 있고 퇴직일 전이어야 한다(근무스케줄과 같은 판정). 최근 3개월 · 오늘까지. 위치 판정도
   * 확인 필요도 없다. 퇴근 없이 출근만 넣을 때 그 계정(계정이 없으면 그 직원)에 열린 출근이 이미 있으면 409, 그 직원의 기록과
   * 시간이 겹치면 409 `ATTENDANCE_OVERLAP`(같은 짝을 두 번 넣지 않게).
   *
   * 그 밖의 직원(위치정보에 동의함 · 위치를 보지 않는 점포)은 그날 출근 · 퇴근을 모두 안 찍었을 때만 같은 조건으로 두 시각을 채우고, 대신 등록이 아니라
   * 보정 한 건(이력 · 직원 앱 연필)으로 남긴다(2026-10-26 재영). 그날 기록이 있으면 그 줄을 보정하라고 409, 앞날 밤샘 짝 · 열린
   * 출근과 시간이 겹치면 대신 등록과 같은 409 `ATTENDANCE_OVERLAP`.
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
      // 계정을 먼저 잠근다 — 동의 상태(대신 등록 · 보정 갈림)와 열린 출근을 잠근 뒤에 본다
      if (staff.accountId)
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${staff.accountId} FOR UPDATE`;
      // 계정이 없으면(가입 전) 직원 행을 잠근다 — 같은 직원의 대신 등록끼리 줄을 세운다
      else
        await tx.$queryRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${staff.staffMemberId} FOR UPDATE`;
      const isProxy = await proxyAllowed(tx, staff.accountId, staff.storeId);
      if (!isProxy && !dto.checkOutTime)
        throw new BadRequestException(
          '대신 등록 대상이 아닌 직원은 출근 · 퇴근을 함께 넣어 보정합니다. 퇴근 시각을 입력해 주세요',
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
      if (!dto.checkOutTime) {
        // 계정이 있으면 계정의 쓸 수 있는 소속 전체(ATT-35, 직원 앱과 같은 판정), 없으면 이 직원 레코드에서 찾는다
        const open = await tx.attendanceRecord.findFirst({
          where: {
            kind: 'CHECK_IN',
            // 대상 직원 레코드의 것은 늘(퇴직했어도 — 그 소속에 열린 출근을 하나 더 만들지 않게), 계정이 있으면 계정의 쓸 수 있는 소속 것도
            staffMember: {
              OR: [
                { staffMemberId: staff.staffMemberId },
                ...(staff.accountId
                  ? [{ accountId: staff.accountId, ...ACTIVE_STAFF }]
                  : []),
              ],
            },
            attendanceRecordsAsCheckIn: { none: {} },
            // 보정할 수 없게 오래된 열린 출근은 막지 않는다(직원 앱 출근과 같다)
            recordedAt: { gte: editableStart() },
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
      if (!isProxy) {
        const from = kstDayStart(day);
        const to = kstDayStart(addDays(day, 1));
        const recorded = await tx.attendanceRecord.findFirst({
          where: {
            staffMemberId: staff.staffMemberId,
            recordedAt: { gte: from, lt: to },
            OR: [
              { kind: 'CHECK_IN' },
              { kind: 'CHECK_OUT', checkInAttendanceRecordId: null },
            ],
          },
          select: { attendanceRecordId: true },
        });
        if (recorded)
          throw new ConflictException(
            rejection(
              HttpStatus.CONFLICT,
              'Conflict',
              'ATTENDANCE_EXISTS',
              '그날 출퇴근 기록이 있습니다. 보정이 필요한 기록에서 그 줄을 보정해 주세요',
            ),
          );
      }
      // 이 직원의 기록과 시간이 겹치면 막는다(대신 등록 · 보정으로 채우기 모두) — 결과를 모르는 실패 뒤 다시 누르기 · 두 관리자의
      // 같은 등록이 같은 짝을 두 벌 만들지 않게
      const now = new Date();
      await assertNoOverlap(tx, staff.staffMemberId, inAt!, outAt, now);
      if (!isProxy)
        return this.fillByCorrection(tx, adminAccountId, staff, day, {
          inAt: inAt!,
          outAt: outAt!,
          reason: dto.reason,
        });
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

  /** 기록 없는 날을 보정으로 채운다 — 출근 · 짝 퇴근을 직원 등록으로 만들고 「없음 → 출근 · 퇴근」 보정 이력 한 건을 남긴다 */
  private async fillByCorrection(
    tx: Tx,
    adminAccountId: number,
    staff: { staffMemberId: number; storeId: number },
    day: Date,
    v: { inAt: Date; outAt: Date; reason: string },
  ): Promise<AttendanceEditResultDto> {
    const now = new Date();
    const base = {
      staffMemberId: staff.staffMemberId,
      storeId: staff.storeId,
      receivedAt: now,
      reviewedBy: adminAccountId,
      reviewedAt: now,
    };
    const checkIn = await tx.attendanceRecord.create({
      data: { ...base, kind: 'CHECK_IN', recordedAt: v.inAt },
      select: { attendanceRecordId: true },
    });
    await tx.attendanceRecord.create({
      data: {
        ...base,
        kind: 'CHECK_OUT',
        recordedAt: v.outAt,
        checkInAttendanceRecordId: checkIn.attendanceRecordId,
      },
    });
    await tx.attendanceCorrection.create({
      data: {
        attendanceRecordId: checkIn.attendanceRecordId,
        beforeValue: valueOf(null, null),
        afterValue: valueOf(v.inAt, v.outAt),
        reason: v.reason,
        correctedBy: adminAccountId,
        correctedAt: now,
      },
    });
    return {
      isPayslipConfirmed: await payslipConfirmed(tx, staff.staffMemberId, day),
    };
  }

  /**
   * 대신 등록 선택지 — 점포 조건 안에서 그날 체결 완료 계약이 있는 직원(STAFF-29), 점포 · 이름순. `isProxy` 가 아니면(위치정보
   * 동의함 · 위치를 보지 않는 점포) 기록 없는 날을 보정으로 채우는 직원이다(ATT-20 · 26, 2026-10-26).
   */
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
          stores.storeTypes.some(
            (t) => t === access.storeOf.get(id)?.storeTypeCode,
          )),
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
      items.push({
        isProxy: await proxyAllowed(this.prisma, c.accountId, c.storeId),
        staffMemberId: c.staffMemberId,
        name: c.name,
        storeId: c.storeId,
        storeName: storeNameOf.get(c.storeId) ?? '',
        isPayslipConfirmed: await payslipConfirmed(
          this.prisma,
          c.staffMemberId,
          day,
        ),
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
    const storeOf = new Map(manageable.stores.map((s) => [s.storeId, s]));
    return {
      storeIds: [...storeOf.keys()],
      storeOf,
      hides: (storeId: number, consented: boolean) =>
        hidesPersonalData(
          manageable.roleTypeCode,
          storeOf.get(storeId),
          consented,
        ),
    };
  }

  /** 짝을 찾고 계정 · 행을 잠근다 — 같은 기록을 동시에 고치면 뒤의 요청이 앞의 결과를 보고 409 가 된다 */
  private async lockedPair(
    tx: Tx,
    access: Awaited<ReturnType<AttendanceEditService['access']>>,
    recordId: number,
  ) {
    const pair = await this.pairOf(tx, access, recordId);
    // 직원 출퇴근(계정 행 잠금)과 같은 순서로 계정부터 잠근다 — 보정이 퇴근을 새로 만드는 사이 직원이 같은 출근에 퇴근해 짝 퇴근이
    // 둘이 되지 않게
    const { accountId } = await tx.staffMember.findUniqueOrThrow({
      where: { staffMemberId: pair.staffMemberId },
      select: { accountId: true },
    });
    if (accountId)
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
    // 계정이 없으면(가입 전) 직원 행을 잠근다 — 대신 등록과 같은 자물쇠라, 겹침 판정끼리 줄을 서 둘 다 통과해 겹치는 일이 없게
    else
      await tx.$queryRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${pair.staffMemberId} FOR UPDATE`;
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
        // 보정 이력과 같은 글자 — 다음 날 퇴근이면 「(다음날)」이 붙는다
        after: (() => {
          const inRec = group.find((p) => p.kind === 'CHECK_IN');
          const outRec = group.find((p) => p.kind === 'CHECK_OUT');
          return inRec && outRec
            ? summaryOf(inRec.recordedAt, outRec.recordedAt)
            : group
                .map(
                  (p) =>
                    `${p.kind === 'CHECK_IN' ? '출근' : '퇴근'} ${kstTimeOf(p.recordedAt)}`,
                )
                .join(' · ');
        })(),
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
/**
 * 이력 · 「바뀐 값이 없습니다」 비교의 한 줄. 퇴근이 출근한 날 뒤면 날을 붙인다 — 「퇴근 02:00(다음날)」 · 「퇴근 10:00(+2일)」. 시각만 보면
 * 날이 바뀐 보정이 「10:00 → 10:00」으로 보인다. 직원 앱은 「퇴근 값」을 띄어쓰기로 나눠 읽으므로 값에 띄어쓰기를 넣지 않는다
 */
const summaryOf = (checkIn: Date | null, checkOut: Date | null) => {
  const days =
    checkIn && checkOut
      ? Math.round(
          (kstToday(checkOut).getTime() - kstToday(checkIn).getTime()) /
            (24 * 60 * 60_000),
        )
      : 0;
  const later = days === 1 ? '(다음날)' : days > 1 ? `(+${days}일)` : '';
  return `출근 ${checkIn ? kstTimeOf(checkIn) : '없음'} · 퇴근 ${checkOut ? kstTimeOf(checkOut) + later : '없음'}`;
};
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
