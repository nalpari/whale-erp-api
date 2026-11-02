import {
  type ContractTemplateInput,
  contractArticles,
  contractHeading,
} from './contract-template';

const base: ContractTemplateInput = {
  employmentType: 'PART_TIME',
  storeName: '강남점',
  jobTitle: '홀 서빙',
  workLocation: null,
  startDate: '2026-11-01',
  endDate: '2027-04-30',
  weeklyHoliday: 'SUN',
  wageAmount: 10320,
  mealAllowanceAmount: 100000,
  carAllowanceAmount: null,
  childcareAllowanceAmount: 0,
  baseHours: 87,
  monthlyOvertimeHours: null,
  baseNightHours: 4.5,
  baseHolidayHours: null,
  monthlyExtraHolidayHours: null,
  annualLeaveTerms: null,
  severancePayTerms: '1년 이상 근무하면 퇴직금을 지급한다.',
  payMonth: 'NEXT_MONTH',
  payDay: 31,
  payMethod: 'ACCOUNT',
  probationMonths: null,
  probationWageReductionRate: null,
  isHealthPensionInsured: true,
  isEmploymentInjuryInsured: false,
  workDays: [
    {
      weekday: 'MON',
      startTime: '09:00',
      endTime: '14:20',
      breakStartTime: '12:00',
      breakEndTime: '12:30',
    },
    {
      weekday: 'WED',
      startTime: '09:00',
      endTime: '13:00',
      breakStartTime: null,
      breakEndTime: null,
    },
  ],
};

const article = (input: ContractTemplateInput, n: number) =>
  contractArticles(input)[n - 1];

describe('contractArticles (근로계약서 조항 템플릿, WHALEERP-131)', () => {
  it('조항은 열 가지이고 제목은 직원 앱 원안 그대로다', () => {
    expect(contractArticles(base).map((a) => a.title)).toEqual([
      '제1조(근로계약기간)',
      '제2조(근무장소와 업무)',
      '제3조(소정근로시간)',
      '제4조(휴일)',
      '제5조(임금)',
      '제6조(연장·야간·휴일 가산)',
      '제7조(연차유급휴가)',
      '제8조(사회보험)',
      '제9조(계약서 교부)',
      '제10조(기타)',
    ]);
  });

  it('머리는 고용 형태 한글을 붙인다(없으면 근로계약서만)', () => {
    expect(contractHeading('FULL_TIME')).toBe('근로계약서 · 정직원');
    expect(contractHeading(null)).toBe('근로계약서');
  });

  it('제1조 — 종료일이 있으면 기간, 없으면 기간의 정함 없음, 시작일이 없으면 -', () => {
    expect(article(base, 1).blocks).toEqual([
      {
        type: 'TEXT',
        text: '2026년 11월 1일부터 2027년 4월 30일까지로 한다.',
      },
    ]);
    expect(article({ ...base, endDate: null }, 1).blocks[0]).toEqual({
      type: 'TEXT',
      text: '2026년 11월 1일부터 기간의 정함이 없는 것으로 한다.',
    });
    expect(article({ ...base, startDate: null }, 1).blocks[0]).toEqual({
      type: 'TEXT',
      text: '-',
    });
  });

  it('제2조 — 근무 장소를 적지 않았으면 점포명', () => {
    expect(article(base, 2).blocks[0]).toEqual({
      type: 'TEXT',
      text: '강남점에서 홀 서빙 업무를 한다.',
    });
    expect(article({ ...base, workLocation: '2층 주방' }, 2).blocks[0]).toEqual(
      { type: 'TEXT', text: '2층 주방에서 홀 서빙 업무를 한다.' },
    );
  });

  it('제3조 — 요일별 일곱 줄 표, 근무하지 않는 날은 휴무 · 주휴일, 주 · 월 근로시간 줄', () => {
    const [body, table, values, tail] = article(base, 3).blocks;
    expect(body).toEqual({
      type: 'TEXT',
      text: '요일별 근로시간은 아래와 같다.',
    });
    expect(table).toEqual({
      type: 'TABLE',
      header: ['요일', '시업', '종업', '휴게', '근로'],
      tableRows: [
        {
          cells: ['월', '09:00', '14:20', '12:00–12:30', '4.8시간'],
          off: false,
        },
        { cells: ['화', '—', '—', '—', '휴무'], off: true },
        { cells: ['수', '09:00', '13:00', '없음', '4시간'], off: false },
        { cells: ['목', '—', '—', '—', '휴무'], off: true },
        { cells: ['금', '—', '—', '—', '휴무'], off: true },
        { cells: ['토', '—', '—', '—', '휴무'], off: true },
        { cells: ['일', '—', '—', '—', '주휴일'], off: true },
      ],
    });
    expect(values).toEqual({
      type: 'VALUES',
      values: [
        { label: '주 소정근로시간', value: '8.8시간' },
        { label: '월 기본 근로', value: '87시간' },
        { label: '기본 근로 중 야간', value: '4.5시간' },
      ],
    });
    expect(tail).toEqual({
      type: 'TEXT',
      text: '세부 근무일정은 근무스케줄로 정한다.',
    });
  });

  it('제3조 — 근무 요일이 없으면 문장 하나', () => {
    expect(article({ ...base, workDays: [] }, 3).blocks).toEqual([
      { type: 'TEXT', text: '근무 요일이 정해지지 않았다.' },
    ]);
  });

  it('제4조 — 주휴일이 없으면 15시간 미만 문장', () => {
    expect(article(base, 4).blocks[0]).toEqual({
      type: 'TEXT',
      text: '주휴일은 매주 일요일로 한다.',
    });
    expect(article({ ...base, weeklyHoliday: null }, 4).blocks[0]).toEqual({
      type: 'TEXT',
      text: '1주 소정근로시간이 15시간 미만이라 주휴일을 두지 않는다.',
    });
  });

  it('제4조 — 주휴일이 비었는데 주 15시간 이상인 옛 계약은 「15시간 미만」이라 적지 않는다', () => {
    const fullWeek = ['MON', 'TUE', 'WED', 'THU', 'FRI'].map((weekday) => ({
      weekday: weekday as 'MON',
      startTime: '09:00',
      endTime: '18:00',
      breakStartTime: '12:00',
      breakEndTime: '13:00',
    }));
    expect(
      article({ ...base, weeklyHoliday: null, workDays: fullWeek }, 4)
        .blocks[0],
    ).toEqual({ type: 'TEXT', text: '주휴일이 정해지지 않았다.' });
  });

  it('제5조 — 값이 있는 줄만, 수당은 월, 31일은 말일, 주휴일이 있으면 주휴수당 문장', () => {
    expect(article(base, 5).blocks).toEqual([
      { type: 'TEXT', text: '임금은 아래와 같이 지급한다.' },
      {
        type: 'VALUES',
        values: [
          { label: '시급', value: '10,320원' },
          { label: '식대', value: '월 100,000원' },
          { label: '지급일', value: '익월 말일' },
          { label: '지급 방법', value: '계좌' },
        ],
      },
      {
        type: 'TEXT',
        text: '1주 소정근로시간이 15시간 이상이고 그 주 소정근로일을 개근하면 주휴수당을 지급한다.',
      },
    ]);
  });

  it('제5조 — 수습은 감액률과 수습 중 시급, 감액 0 이면 감액 없음', () => {
    const values = (rate: number) =>
      article(
        {
          ...base,
          weeklyHoliday: null,
          probationMonths: 3,
          probationWageReductionRate: rate,
        },
        5,
      ).blocks[1];
    expect(values(10)).toMatchObject({
      values: expect.arrayContaining([
        {
          label: '수습',
          value: '3개월 · 시급의 10% 감액(수습 중 시급 9,288원)',
        },
      ]) as unknown,
    });
    expect(values(0)).toMatchObject({
      values: expect.arrayContaining([
        { label: '수습', value: '3개월 · 감액 없음' },
      ]) as unknown,
    });
  });

  // 수습 중 시급은 저장 검사 · 관리자 웹과 같은 정수 셈(WHALEERP-595) — 부동소수 셈이면 14,650원 · 7% 가 13,624원이 된다
  it('제5조 — 수습 중 시급은 정수 셈으로 원 미만 반올림', () => {
    expect(
      article(
        {
          ...base,
          wageAmount: 14650,
          weeklyHoliday: null,
          probationMonths: 3,
          probationWageReductionRate: 7,
        },
        5,
      ).blocks[1],
    ).toMatchObject({
      values: expect.arrayContaining([
        {
          label: '수습',
          value: '3개월 · 시급의 7% 감액(수습 중 시급 13,625원)',
        },
      ]) as unknown,
    });
  });

  it('제7조 — 관리자가 고친 연차 문구, 없으면 원안', () => {
    expect(article(base, 7).blocks[0]).toEqual({
      type: 'TEXT',
      text: '근로기준법에서 정한 바에 따라 연차유급휴가를 준다.',
    });
    expect(
      article({ ...base, annualLeaveTerms: '입사 1년 뒤 15일.' }, 7).blocks[0],
    ).toEqual({ type: 'TEXT', text: '입사 1년 뒤 15일.' });
  });

  it('제8조 — 가입 · 가입하지 않음 · 정하지 않음(-)', () => {
    expect(
      article({ ...base, isEmploymentInjuryInsured: null }, 8).blocks[1],
    ).toEqual({
      type: 'VALUES',
      values: [
        { label: '국민연금 · 건강보험', value: '가입' },
        { label: '고용보험 · 산재보험', value: '-' },
      ],
    });
  });

  it('제10조 — 퇴직금 문구를 앞에 붙이고 끝 마침표는 하나만', () => {
    expect(article(base, 10).blocks[0]).toEqual({
      type: 'TEXT',
      text: '퇴직금 — 1년 이상 근무하면 퇴직금을 지급한다. 이 계약에 정하지 않은 사항은 근로기준법령에 따른다.',
    });
    expect(article({ ...base, severancePayTerms: null }, 10).blocks[0]).toEqual(
      {
        type: 'TEXT',
        text: '이 계약에 정하지 않은 사항은 근로기준법령에 따른다.',
      },
    );
  });
});
