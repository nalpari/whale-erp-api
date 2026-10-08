// 날짜만 있는 값(@db.Date)은 Prisma 가 UTC 자정 Date 로 주고받는다. 이 파일의 「날짜」는 모두 그 모양이다.
// 업무의 하루는 한국 시간이다. 서버나 DB 가 UTC 로 돌면 0시~9시 사이에 날짜가 하루 어긋나므로, 오늘을
// 정할 때는 반드시 kstToday 를 쓴다.

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 한국 시간 기준 오늘 날짜. */
export function kstToday(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}

/** 그 날짜가 한국에서 시작하는 순간(한국 0시). 시각 칸(timestamptz)과 견줄 때 쓴다. */
export function kstDayStart(date: Date): Date {
  return new Date(date.getTime() - KST_OFFSET_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** 달을 옮긴다. 그 달에 같은 날이 없으면 마지막 날로 맞춘다(5월 31일 − 3개월 = 2월 28일). */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

/** `YYYY-MM-DD` 를 날짜로 읽는다. 모양이 다르거나 없는 날짜(2월 30일 등)면 null. */
export function parseDateOnly(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC 는 2월 30일을 3월 2일로 넘긴다. 되돌려 읽어 같은지 본다.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}
