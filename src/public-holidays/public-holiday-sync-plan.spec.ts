import type { ApiHoliday } from './holiday-api.client';
import {
  planPublicHolidaySync,
  type StoredHoliday,
} from './public-holiday-sync-plan';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const api = (locdate: string, dateName: string, seq = '1'): ApiHoliday => ({
  locdate,
  dateName,
  seq,
});
const stored = (
  publicHolidayId: number,
  date: string,
  name: string,
  over: Partial<StoredHoliday> = {},
): StoredHoliday => ({
  publicHolidayId,
  holidayDate: d(date),
  name,
  note: null,
  source: 'RULE',
  sourceRef: null,
  ...over,
});

describe('planPublicHolidaySync', () => {
  it('API 에만 있으면 추가, 이름 · 비고 · 출처가 다르면 API 값으로 수정, 같으면 동기화 시각만, 테이블에만 있으면 출처와 관계없이 삭제', () => {
    const plan = planPublicHolidaySync(
      2026,
      [
        stored(1, '2026-01-01', '신정'),
        stored(2, '2026-03-02', '삼일절', { note: '대체공휴일 — 삼일절' }),
        stored(3, '2026-03-01', '삼일절', {
          source: 'PUBLIC_API',
          sourceRef: '20260301-1',
        }),
        stored(4, '2026-04-05', '식목일'),
        stored(5, '2026-12-31', '임시공휴일', {
          source: 'PUBLIC_API',
          sourceRef: '20261231-1',
        }),
      ],
      [
        api('20260101', '1월1일'),
        // 일요일인 삼일절도 평일과 같이 다룬다
        api('20260301', '삼일절'),
        api('20260302', '대체공휴일(삼일절)'),
        api('20260501', '노동절', '2'),
      ],
    );
    expect(plan.create).toEqual([
      { holidayDate: d('2026-05-01'), name: '노동절', sourceRef: '20260501-2' },
    ]);
    expect(plan.update).toEqual([
      { publicHolidayId: 1, name: '1월1일', sourceRef: '20260101-1' },
      {
        publicHolidayId: 2,
        name: '대체공휴일(삼일절)',
        sourceRef: '20260302-1',
      },
    ]);
    expect(plan.refresh).toEqual([3]);
    expect(plan.remove).toEqual([4, 5]);
    expect(plan.errors).toEqual([]);
  });

  it('API 가 그 해 0건이면 미발표로 보고 아무것도 바꾸지 않는다', () => {
    const plan = planPublicHolidaySync(
      2027,
      [stored(1, '2027-01-01', '신정')],
      [],
    );
    expect(plan).toEqual({
      create: [],
      update: [],
      refresh: [],
      remove: [],
      errors: [],
    });
  });

  it('같은 날 두 휴일은 seq 순으로 이름을 「 · 」로 묶어 한 줄로 — 같은 이름은 한 번만', () => {
    const plan = planPublicHolidaySync(
      2025,
      [],
      [
        api('20250505', '부처님오신날', '2'),
        api('20250505', '어린이날', '1'),
        api('20250505', '어린이날', '1'),
      ],
    );
    expect(plan.create).toEqual([
      {
        holidayDate: d('2025-05-05'),
        name: '어린이날 · 부처님오신날',
        sourceRef: '20250505-1,20250505-2',
      },
    ]);
  });

  it('날짜 · 연도 · 이름이 유효하지 않은 항목은 반영하지 않고 오류로 남긴다', () => {
    const plan = planPublicHolidaySync(
      2026,
      [
        stored(1, '2026-01-01', '1월1일', {
          source: 'PUBLIC_API',
          sourceRef: '20260101-1',
        }),
      ],
      [
        api('20260101', '1월1일'),
        api('2026-05-05', '어린이날'),
        api('20260230', '없는 날'),
        api('20270101', '1월1일'),
        api('20260606', '   '),
        api('20260815', 'x'.repeat(101)),
        api('20261003', '개천절', ''),
        api('20261009', '한글날', '1a'),
      ],
    );
    expect(plan.create).toEqual([]);
    expect(plan.refresh).toEqual([1]);
    expect(plan.errors).toEqual([
      '2026-05-05 어린이날: 날짜 형식이 YYYYMMDD 가 아니다',
      '20260230 없는 날: 없는 날짜다',
      '20270101 1월1일: 2026년이 아니다',
      '20260606 : 휴일명이 비었다',
      `20260815 ${'x'.repeat(101)}: 휴일명이 100자를 넘는다`,
      '20261003 개천절: 순번(seq)이 숫자가 아니다',
      '20261009 한글날: 순번(seq)이 숫자가 아니다',
    ]);
  });

  it('무효 항목이 하나라도 있으면 그 해는 지우지 않는다 — 그 항목이 가리키던 날을 잘못 지우지 않게(추가 · 수정은 한다)', () => {
    const plan = planPublicHolidaySync(
      2026,
      [
        stored(1, '2026-01-01', '신정'),
        stored(2, '2026-08-15', '광복절'),
        stored(3, '2026-04-05', '식목일'),
      ],
      [
        api('20260101', '1월1일'),
        api('20260501', '노동절', '2'),
        // 광복절이 날짜를 알아볼 수 없게 왔다 — 테이블의 광복절을 「API 에 없는 날」로 보면 안 된다
        api('2026-08-15', '광복절'),
      ],
    );
    expect(plan.create.map((c) => c.name)).toEqual(['노동절']);
    expect(plan.update.map((u) => u.publicHolidayId)).toEqual([1]);
    expect(plan.remove).toEqual([]);
    expect(plan.errors).toHaveLength(1);
  });

  it('유효한 항목이 하나도 없으면 테이블의 휴일을 지우지 않는다', () => {
    const plan = planPublicHolidaySync(
      2026,
      [stored(1, '2026-01-01', '신정')],
      [api('2026-01-01', '1월1일')],
    );
    expect(plan.remove).toEqual([]);
    expect(plan.errors).toHaveLength(1);
  });

  it('이름은 앞뒤 공백을 떼고 쓴다', () => {
    const plan = planPublicHolidaySync(2026, [], [api('20260606', ' 현충일 ')]);
    expect(plan.create[0].name).toBe('현충일');
  });
});
