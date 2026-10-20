/** date 칸을 YYYY-MM-DD 로. Prisma 는 date 를 UTC 자정의 Date 로 준다 */
export const dateOnly = (date: Date | null) =>
  date ? date.toISOString().slice(0, 10) : null;
