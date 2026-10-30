import type { EmploymentType, Weekday } from '@prisma/client';
import { DB_ENUMS } from '../enums/db-enums.generated';
import { probationWageOf } from './minimum-wage';
import {
  dayMinutesOf,
  weeklyMinutesOf,
  type contractTermsOf,
} from './contract-terms';

// 근로계약서 조항 템플릿(WHALEERP-131). 직원 앱 화면(상세 `articles`)과 보낸 원본 · 처리 완료본 PDF 가 같은 조항을 쓴다.
// 문구는 직원 앱이 그리던 원안(whale-erp-staff contracts/_components/contract-document.tsx)을 옮긴 것이다 — 휴일 · 연차유급휴가 ·
// 연장 · 야간 · 휴일 가산 문구는 노무사 검토(PAY-5) 전이라 원안 그대로 둔다. 문구를 바꾸면 이미 만든 PDF 는 그대로지만, 앱 화면은
// 이 템플릿으로 다시 그리므로 체결한 계약의 본문도 바뀌어 보인다.

export type ContractTerms = ReturnType<typeof contractTermsOf>;

export type ContractTemplateInput = ContractTerms & {
  employmentType: EmploymentType | null;
  /** 근무 장소를 적지 않았을 때 제2조에 쓰는 점포명 */
  storeName: string;
  workLocation: string | null;
  jobTitle: string | null;
};

export type ContractBlock =
  | { type: 'TEXT'; text: string }
  | {
      type: 'TABLE';
      header: string[];
      tableRows: { cells: string[]; off: boolean }[];
    }
  | { type: 'VALUES'; values: { label: string; value: string }[] };

export interface ContractArticle {
  title: string;
  /** 첫 TEXT 는 제목 뒤에 잇는 문장이다(직원 앱 · PDF 같은 규칙) */
  blocks: ContractBlock[];
}

const WEEKDAYS: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

const label = (enumName: string, value: string) =>
  DB_ENUMS[enumName]?.find(([v]) => v === value)?.[1] ?? value;

/** 「YYYY-MM-DD」 → 「2026년 9월 15일」 */
export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}년 ${m}월 ${d}일`;
}

/** 하루 근로시간(시간) — 저장 검사와 같은 계산(contract-terms) */
const dayHours = (d: ContractTerms['workDays'][number]) => dayMinutesOf(d) / 60;

/** 「5시간」 · 「7.5시간」 — 소수 한 자리, 끝의 0 은 지운다 */
const hoursText = (hours: number) => `${Number(hours.toFixed(1))}시간`;

const wonText = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;

const text = (t: string): ContractBlock => ({ type: 'TEXT', text: t });

/** 값이 빈 줄은 뺀다(직원 앱 Values 와 같다) */
const values = (rows: [string, string | null][]): ContractBlock => ({
  type: 'VALUES',
  values: rows
    .filter((r): r is [string, string] => r[1] !== null && r[1] !== '')
    .map(([l, value]) => ({ label: l, value })),
});

export const contractHeading = (employmentType: EmploymentType | null) =>
  employmentType
    ? `근로계약서 · ${label('EmploymentType', employmentType)}`
    : '근로계약서';

function periodText(c: ContractTemplateInput): string {
  if (!c.startDate) return '-';
  return c.endDate
    ? `${dateLabel(c.startDate)}부터 ${dateLabel(c.endDate)}까지로 한다.`
    : `${dateLabel(c.startDate)}부터 기간의 정함이 없는 것으로 한다.`;
}

/** 제3조 표 — 월요일부터 일요일까지 일곱 줄. 근무하지 않는 날은 「—」와 휴무, 주휴일이면 주휴일 */
function weekdayTable(c: ContractTemplateInput): ContractBlock {
  return {
    type: 'TABLE',
    header: ['요일', '시업', '종업', '휴게', '근로'],
    tableRows: WEEKDAYS.map((weekday) => {
      const day = label('Weekday', weekday);
      const d = c.workDays.find((w) => w.weekday === weekday);
      if (!d)
        return {
          cells: [
            day,
            '—',
            '—',
            '—',
            weekday === c.weeklyHoliday ? '주휴일' : '휴무',
          ],
          off: true,
        };
      const rest =
        d.breakStartTime && d.breakEndTime
          ? `${d.breakStartTime}–${d.breakEndTime}`
          : '없음';
      return {
        cells: [day, d.startTime, d.endTime, rest, hoursText(dayHours(d))],
        off: false,
      };
    }),
  };
}

function workHourBlocks(c: ContractTemplateInput): ContractBlock[] {
  if (c.workDays.length === 0) return [text('근무 요일이 정해지지 않았다.')];
  const weekly = weeklyMinutesOf(c.workDays) / 60;
  // 기본시간 중 휴일 · 월 추가 휴일은 관리자 작성 화면이 받지 않아 넣지 않는다(직원 앱 monthlyHourRows 와 같다)
  const monthly: [string, number | null][] = [
    ['월 기본 근로', c.baseHours],
    ['월 연장 근로', c.monthlyOvertimeHours],
    ['기본 근로 중 야간', c.baseNightHours],
  ];
  return [
    text('요일별 근로시간은 아래와 같다.'),
    weekdayTable(c),
    values([
      ['주 소정근로시간', hoursText(weekly)],
      ...monthly.map(([l, h]): [string, string | null] => [
        l,
        h === null ? null : hoursText(h),
      ]),
    ]),
    text('세부 근무일정은 근무스케줄로 정한다.'),
  ];
}

function payDayText(c: ContractTemplateInput): string | null {
  if (!c.payMonth || c.payDay === null) return null;
  return `${label('PayMonth', c.payMonth)} ${c.payDay === 31 ? '말일' : `${c.payDay}일`}`;
}

function probationText(c: ContractTemplateInput): string | null {
  const { probationMonths: months, probationWageReductionRate: rate } = c;
  if (months === null || rate === null) return null;
  if (rate === 0) return `${months}개월 · 감액 없음`;
  const during =
    c.wageAmount === null
      ? ''
      : `(수습 중 시급 ${wonText(probationWageOf(c.wageAmount, rate))})`;
  return `${months}개월 · 시급의 ${rate}% 감액${during}`;
}

const insuredText = (v: boolean | null) =>
  v === null ? '-' : v ? '가입' : '가입하지 않음';

/** 근로계약서 조항 열 가지(CTR-21) — 정직원 · 파트타이머가 같은 구성이고 값만 다르다 */
export function contractArticles(c: ContractTemplateInput): ContractArticle[] {
  const hasHoliday = c.weeklyHoliday !== null;
  const allowances: [string, number | null][] = [
    ['식대', c.mealAllowanceAmount],
    ['자가운전보조금', c.carAllowanceAmount],
    ['육아수당', c.childcareAllowanceAmount],
  ];
  return [
    { title: '제1조(근로계약기간)', blocks: [text(periodText(c))] },
    {
      title: '제2조(근무장소와 업무)',
      blocks: [
        text(
          // 직무가 빈 옛 계약은 「-」 — 원안은 빈칸으로 그려 「…에서  업무를 한다」가 됐다
          `${c.workLocation ?? c.storeName}에서 ${c.jobTitle ?? '-'} 업무를 한다.`,
        ),
      ],
    },
    { title: '제3조(소정근로시간)', blocks: workHourBlocks(c) },
    {
      title: '제4조(휴일)',
      blocks: [
        text(
          hasHoliday
            ? `주휴일은 매주 ${label('Weekday', c.weeklyHoliday!)}요일로 한다.`
            : // 15시간 이상인데 비어 있는 옛 계약(저장 검사 전)은 「15시간 미만」이라 적지 않는다 — 같은 문서 제3조와 어긋난다
              weeklyMinutesOf(c.workDays) >= 15 * 60
              ? '주휴일이 정해지지 않았다.'
              : '1주 소정근로시간이 15시간 미만이라 주휴일을 두지 않는다.',
        ),
      ],
    },
    {
      title: '제5조(임금)',
      blocks: [
        text('임금은 아래와 같이 지급한다.'),
        values([
          ['시급', c.wageAmount === null ? null : wonText(c.wageAmount)],
          ...allowances.map(([l, v]): [string, string | null] => [
            l,
            v ? `월 ${wonText(v)}` : null,
          ]),
          ['지급일', payDayText(c)],
          ['지급 방법', c.payMethod && label('PayMethod', c.payMethod)],
          ['수습', probationText(c)],
        ]),
        ...(hasHoliday
          ? [
              text(
                '1주 소정근로시간이 15시간 이상이고 그 주 소정근로일을 개근하면 주휴수당을 지급한다.',
              ),
            ]
          : []),
      ],
    },
    {
      title: '제6조(연장·야간·휴일 가산)',
      blocks: [
        text(
          '연장·야간·휴일근로에 대해서는 근로기준법에서 정한 바에 따라 가산하여 지급한다.',
        ),
      ],
    },
    {
      title: '제7조(연차유급휴가)',
      blocks: [
        text(
          c.annualLeaveTerms ??
            '근로기준법에서 정한 바에 따라 연차유급휴가를 준다.',
        ),
      ],
    },
    {
      title: '제8조(사회보험)',
      blocks: [
        text('사회보험 가입은 다음과 같다.'),
        values([
          ['국민연금 · 건강보험', insuredText(c.isHealthPensionInsured)],
          ['고용보험 · 산재보험', insuredText(c.isEmploymentInjuryInsured)],
        ]),
      ],
    },
    {
      title: '제9조(계약서 교부)',
      blocks: [
        text('사용자는 계약을 체결하면 곧바로 계약서를 근로자에게 교부한다.'),
      ],
    },
    {
      // 퇴직금 문구는 원안 본문에 자리가 없어 기타에 둔다(직원 앱 원안과 같다)
      title: '제10조(기타)',
      blocks: [
        text(
          `${c.severancePayTerms ? `퇴직금 — ${c.severancePayTerms.replace(/\.$/, '')}. ` : ''}이 계약에 정하지 않은 사항은 근로기준법령에 따른다.`,
        ),
      ],
    },
  ];
}
