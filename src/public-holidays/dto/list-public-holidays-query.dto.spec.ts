// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListPublicHolidaysQueryDto } from './list-public-holidays-query.dto';

const errorsOf = (query: Record<string, string>) =>
  validateSync(plainToInstance(ListPublicHolidaysQueryDto, query)).flatMap(
    (e) => Object.values(e.constraints ?? {}),
  );

describe('ListPublicHolidaysQueryDto', () => {
  it.each([
    [{ year: '2000' }],
    [{ year: '2100' }],
    [{ year: '2026', month: '1' }],
    [{ year: '2026', month: '12' }],
  ])('%j 는 받는다', (query) => {
    expect(errorsOf(query)).toEqual([]);
  });

  it('쿼리 문자열을 숫자로 바꾼다', () => {
    const dto = plainToInstance(ListPublicHolidaysQueryDto, {
      year: '2026',
      month: '9',
    });
    expect(dto).toMatchObject({ year: 2026, month: 9 });
  });

  it.each([
    [{}],
    [{ year: '1999' }],
    [{ year: '2101' }],
    [{ year: '2026.5' }],
    [{ year: 'abc' }],
  ])('연도 %j 는 거부한다', (query) => {
    expect(errorsOf(query)).toContain('연도는 2000~2100 사이로 보내 주세요');
  });

  // 빈 값(`month=`)은 생략이 아니라 0 으로 바뀌어 거부된다 — 목록(그 해 전체)은 month 를 빼고 보낸다.
  it.each([['0'], ['13'], ['1.5'], ['x'], ['']])(
    '월 %j 는 거부한다',
    (month) => {
      expect(errorsOf({ year: '2026', month })).toContain(
        '월은 1~12 사이로 보내 주세요',
      );
    },
  );
});
