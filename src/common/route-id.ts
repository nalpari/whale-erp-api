const MAX_ID = 2_147_483_647;

/**
 * 경로의 ID 를 정수로 읽는다. `integer` 범위(1..2147483647) 밖이거나 숫자가 아니면 null — 그대로 DB 에 보내면
 * PostgreSQL 오류로 500 이 되므로, 부르는 쪽이 묻기 전에 404 로 답한다.
 */
export function parseRouteId(raw: string): number | null {
  const id = /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
  return id >= 1 && id <= MAX_ID ? id : null;
}
