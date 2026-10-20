/** 로그에 남길 오류 종류 — 이름과 (Prisma 오류면) 코드만. 메시지에는 주소가 섞일 수 있어 싣지 않는다 */
export function errorKind(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string'
    ? `error=${name} code=${code}`
    : `error=${name}`;
}
