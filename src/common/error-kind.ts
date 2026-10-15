/** 로그에 남길 오류 종류 — 이름과 코드만. 메시지에는 개인정보(받는 주소 등)가 섞일 수 있다. */
export function errorKind(e: unknown): string {
  const { name, code } = (e ?? {}) as { name?: unknown; code?: unknown };
  return `error=${String(name)} code=${String(code)}`;
}
