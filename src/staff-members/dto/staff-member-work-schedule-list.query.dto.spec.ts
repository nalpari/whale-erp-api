// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StaffMemberWorkScheduleListQueryDto } from './staff-member-work-schedule-list.query.dto';

// 전역 ValidationPipe(app.module.ts)와 같은 옵션 — 쿼리 문자열은 문자열로 온다
const errorsOf = async (query: Record<string, string>) =>
  (
    await validate(
      plainToInstance(StaffMemberWorkScheduleListQueryDto, query),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
      },
    )
  ).map((e) => e.property);

describe('StaffMemberWorkScheduleListQueryDto', () => {
  it('아무 값도 없으면 통과 — 기본값(이번 주 · 1쪽 · 20건)은 서비스가 정한다', async () => {
    expect(await errorsOf({})).toEqual([]);
  });

  it.each(['THIS_WEEK', 'LAST_4_WEEKS', 'LAST_3_MONTHS', 'LAST_1_YEAR', 'ALL'])(
    'period %s 는 통과',
    async (period) => {
      expect(await errorsOf({ period })).toEqual([]);
    },
  );

  it.each(['BAD', 'this_week', ''])('period %p 는 오류', async (period) => {
    expect(await errorsOf({ period })).toEqual(['period']);
  });

  it.each(['30', '0'])('pageSize %s 는 오류', async (pageSize) => {
    expect(await errorsOf({ pageSize })).toEqual(['pageSize']);
  });

  it.each(['20', '50', '100'])('pageSize %s 는 통과', async (pageSize) => {
    expect(await errorsOf({ pageSize })).toEqual([]);
  });

  it.each(['0', 'abc', '1.5', '1000001'])('page %s 는 오류', async (page) => {
    expect(await errorsOf({ page })).toEqual(['page']);
  });

  it.each(['1', '1000000'])('page %s 는 통과', async (page) => {
    expect(await errorsOf({ page })).toEqual([]);
  });

  it('모르는 쿼리는 오류(forbidNonWhitelisted)', async () => {
    expect(await errorsOf({ weekStart: '2026-10-21' })).toEqual(['weekStart']);
  });
});
