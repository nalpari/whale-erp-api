const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 한국 시각 `YYYY-MM-DD HH:mm` — 엑셀 칸 · 메일 변수에 쓴다. */
export function kstDateTime(date: Date): string {
  return new Date(date.getTime() + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}
