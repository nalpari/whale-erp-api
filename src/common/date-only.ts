/** 날짜만 있는 칸(Prisma 는 UTC 자정의 Date 로 준다)을 YYYY-MM-DD 로. null 이면 null */
export function dateOnly(date: Date): string;
export function dateOnly(date: Date | null): string | null;
export function dateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
