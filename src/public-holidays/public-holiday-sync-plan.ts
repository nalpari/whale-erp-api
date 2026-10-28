import type { PublicHolidaySource } from '@prisma/client';
import type { ApiHoliday } from './holiday-api.client';

/** 테이블의 공식 휴일 한 줄 — 동기화가 비교하는 칸만 */
export type StoredHoliday = {
  publicHolidayId: number;
  holidayDate: Date;
  name: string;
  note: string | null;
  source: PublicHolidaySource;
  sourceRef: string | null;
};

export type PublicHolidaySyncPlan = {
  /** API 에만 있는 날 */
  create: { holidayDate: Date; name: string; sourceRef: string }[];
  /** 이름 · 비고 · 출처 · 원본 식별자 중 하나라도 달라 API 값으로 고칠 줄(비고는 비운다) */
  update: { publicHolidayId: number; name: string; sourceRef: string }[];
  /** API 값과 같아 동기화 시각만 새로 적을 줄 */
  refresh: number[];
  /** API 가 그 해를 돌려주었는데 테이블에만 남은 줄 — 출처와 관계없이 */
  remove: number[];
  /** 반영하지 않은 원본 항목과 그 사유 */
  errors: string[];
};

const NAME_MAX = 100;

/**
 * 한 해의 공식 휴일을 공휴일 API 결과에 맞추는 계획(WHALEERP-543). 날짜로 비교하고 API 값이 이긴다.
 * - 주말에 걸린 공휴일도 평일과 같이 다룬다(사용자 결정, 2026-10-28) — 명세의 「주말은 만들지 않는다」는
 *   일반 토 · 일요일을 휴일로 만들지 않는다는 뜻이다.
 * - 이름은 API 원문 그대로 쓰고 비고는 비운다(사용자 결정, 2026-10-28 — 「대체공휴일(삼일절)」).
 * - 유효한 항목이 하나도 없으면(0건 = 미발표, 또는 전부 오류) 아무것도 지우지 않는다.
 * - 무효 항목이 하나라도 있으면 그 해는 지우지 않는다 — 날짜를 알아볼 수 없는 항목이 가리키던 실제 휴일을
 *   「API 에 없는 날」로 지우지 않게. 추가 · 수정은 하고, 오류는 이력에 남는다(코드 리뷰 반영, 2026-10-28).
 * - 같은 날 두 휴일은 seq 순으로 이름을 「 · 」로 묶어 한 줄로 둔다(테이블의 날짜 고유 인덱스, 기존 관례).
 */
export function planPublicHolidaySync(
  year: number,
  stored: readonly StoredHoliday[],
  fetched: readonly ApiHoliday[],
): PublicHolidaySyncPlan {
  const errors: string[] = [];
  const byDate = new Map<string, { name: string; seq: string }[]>();
  for (const item of fetched) {
    const reason = invalidReason(year, item);
    if (reason) {
      errors.push(`${item.locdate} ${item.dateName.trim()}: ${reason}`);
      continue;
    }
    const list = byDate.get(item.locdate) ?? [];
    list.push({ name: item.dateName.trim(), seq: item.seq });
    byDate.set(item.locdate, list);
  }

  const wanted = new Map(
    [...byDate].map(([locdate, list]) => {
      const sorted = [...list].sort((a, b) => Number(a.seq) - Number(b.seq));
      return [
        isoDate(locdate),
        {
          locdate,
          name: [...new Set(sorted.map((x) => x.name))].join(' · '),
          sourceRef: [
            ...new Set(sorted.map((x) => `${locdate}-${x.seq}`)),
          ].join(','),
        },
      ] as const;
    }),
  );

  const plan: PublicHolidaySyncPlan = {
    create: [],
    update: [],
    refresh: [],
    remove: [],
    errors,
  };
  if (!wanted.size) return plan;

  const storedByDate = new Map(
    stored.map((row) => [row.holidayDate.toISOString().slice(0, 10), row]),
  );
  for (const [date, want] of wanted) {
    const row = storedByDate.get(date);
    if (!row) {
      plan.create.push({
        holidayDate: new Date(`${date}T00:00:00.000Z`),
        name: want.name,
        sourceRef: want.sourceRef,
      });
    } else if (
      row.name !== want.name ||
      row.note !== null ||
      row.source !== 'PUBLIC_API' ||
      row.sourceRef !== want.sourceRef
    ) {
      plan.update.push({
        publicHolidayId: row.publicHolidayId,
        name: want.name,
        sourceRef: want.sourceRef,
      });
    } else {
      plan.refresh.push(row.publicHolidayId);
    }
  }
  if (!errors.length)
    for (const [date, row] of storedByDate)
      if (!wanted.has(date)) plan.remove.push(row.publicHolidayId);
  return plan;
}

function invalidReason(year: number, item: ApiHoliday): string | null {
  if (!/^\d{8}$/.test(item.locdate)) return '날짜 형식이 YYYYMMDD 가 아니다';
  // 같은 날 두 휴일을 seq 순으로 묶고 원본 식별자에 쓴다 — 숫자가 아니면 순서도 식별자도 정해지지 않는다.
  if (!/^\d+$/.test(item.seq)) return '순번(seq)이 숫자가 아니다';
  const date = new Date(`${isoDate(item.locdate)}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== isoDate(item.locdate)
  )
    return '없는 날짜다';
  if (date.getUTCFullYear() !== year) return `${year}년이 아니다`;
  const name = item.dateName.trim();
  if (!name) return '휴일명이 비었다';
  if (name.length > NAME_MAX) return `휴일명이 ${NAME_MAX}자를 넘는다`;
  return null;
}

/** 20260101 → 2026-01-01 */
function isoDate(locdate: string): string {
  return `${locdate.slice(0, 4)}-${locdate.slice(4, 6)}-${locdate.slice(6, 8)}`;
}
