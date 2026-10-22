/**
 * 목록 필터가 값을 여러 개 받게 한다 — `?status=A&status=B`. 하나만 오면 쿼리 파서가 배열이 아니라 문자열로 주므로
 * 배열로 감싼다. `@Transform(toList)` 뒤에 `{ each: true }` 검사를 건다.
 */
export const toList = ({ value }: { value: unknown }): unknown[] =>
  Array.isArray(value) ? (value as unknown[]) : [value];
