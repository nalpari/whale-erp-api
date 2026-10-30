import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dateOnly } from '../common/date-only';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import type { ListPublicHolidaysQueryDto } from './dto/list-public-holidays-query.dto';
import type { PublicHolidayListResponseDto } from './dto/public-holiday.response.dto';
import { syncYearsOf } from './public-holiday-years';

const LATEST_FIRST: Prisma.PublicHolidaySynchronizationLogOrderByWithRelationInput[] =
  [{ synchronizedAt: 'desc' }, { synchronizationId: 'desc' }];

/**
 * 플랫폼 휴일 관리(`/public-holidays`, MN000217) — 공식 휴일 조회 전용(WHALEERP-544).
 * 공식 휴일은 마이그레이션의 규칙 계산과 공공 API 동기화로만 바뀌므로 등록 · 수정 · 삭제는 없다.
 */
@Injectable()
export class PublicHolidaysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 고른 연도(와 월)의 공식 휴일을 날짜순으로, 동기화 상태와 함께. 동기화 상태는 성공한 마지막 동기화 시각과,
   * 올해 · 다음 해 중 마지막 동기화가 실패한 연도다. 올해는 한국 날짜로 정한다(`now` 는 테스트용).
   */
  async list(
    query: ListPublicHolidaysQueryDto,
    now: Date = new Date(),
  ): Promise<PublicHolidayListResponseDto> {
    const { year, month } = query;
    const where: Prisma.PublicHolidayWhereInput =
      month === undefined
        ? { year }
        : {
            year,
            holidayDate: {
              gte: new Date(Date.UTC(year, month - 1, 1)),
              lt: new Date(Date.UTC(year, month, 1)),
            },
          };
    const thisYear = kstToday(now).getUTCFullYear();
    const syncYears = syncYearsOf(thisYear);
    // 한 연결에서 차례로 읽는다 — 화면 하나에 연결을 넷씩 잡지 않게.
    const [rows, lastSucceeded, ...latest] = await this.prisma.$transaction([
      this.prisma.publicHoliday.findMany({
        where,
        orderBy: { holidayDate: 'asc' },
        select: {
          publicHolidayId: true,
          holidayDate: true,
          name: true,
          note: true,
        },
      }),
      this.prisma.publicHolidaySynchronizationLog.findFirst({
        where: { result: 'SUCCEEDED' },
        orderBy: LATEST_FIRST,
        select: { synchronizedAt: true },
      }),
      ...syncYears.map((y) =>
        this.prisma.publicHolidaySynchronizationLog.findFirst({
          where: { year: y },
          orderBy: LATEST_FIRST,
          select: { result: true },
        }),
      ),
    ]);
    return {
      year,
      month: month ?? null,
      items: rows.map((row) => ({
        ...row,
        holidayDate: dateOnly(row.holidayDate),
      })),
      total: rows.length,
      synchronization: {
        lastSynchronizedAt: lastSucceeded?.synchronizedAt.toISOString() ?? null,
        failedYears: syncYears.filter((_, i) => latest[i]?.result === 'FAILED'),
      },
    };
  }
}
