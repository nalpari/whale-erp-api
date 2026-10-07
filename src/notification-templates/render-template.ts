const PLACEHOLDER = /#\{([^}]+)\}/g;

/**
 * `#{변수}` 를 한 번에 치환한다. 값 안의 `#{...}` 는 다시 치환하지 않는다.
 * 값이 문자열이 아닌 변수(빠졌거나 null)가 있으면 `#{변수}` 가 글자 그대로
 * 나가지 않도록 보내기 전에 던진다. 빈 문자열은 값으로 보고 그대로 치환한다.
 */
export function renderTemplate(
  text: string,
  variables: Record<string, string>,
  label: string,
): string {
  const missing = new Set<string>();
  const rendered = text.replace(PLACEHOLDER, (match, name: string) => {
    // 자기 키만 본다. 상속받은 toString 같은 함수가 값으로 끼어들지 않게.
    const value: unknown = Object.hasOwn(variables, name)
      ? variables[name]
      : undefined;
    if (typeof value === 'string') return value;
    missing.add(name);
    return match;
  });
  if (missing.size)
    throw new Error(`${label} 변수가 비었습니다: ${[...missing].join(', ')}`);
  return rendered;
}
