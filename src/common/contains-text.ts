/**
 * 대소문자 없이 「들어 있음」을 찾는 Prisma 조건. Prisma 의 `contains` 는 LIKE 의 와일드카드(`%` · `_`)와 이스케이프
 * 문자(`\`)를 그대로 넘겨, `_` 하나로 찾으면 모든 행에 맞는다(공용 DB 에서 확인, 2026-10-14). 셋을 `\` 로 막아 글자
 * 그대로 찾는다 — PostgreSQL LIKE 의 기본 이스케이프 문자가 `\` 다.
 */
export function containsText(value: string) {
  return {
    contains: value.replace(/[\\%_]/g, '\\$&'),
    mode: 'insensitive' as const,
  };
}
