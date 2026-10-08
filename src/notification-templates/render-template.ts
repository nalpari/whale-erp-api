export type TemplateVariable = {
  name: string;
  isRequired?: boolean;
  /**
   * 「필수 변수는 본문에 있어야 한다」 검사에서 빠지는 링크 변수. 본문에 자리가 없고,
   * 메일은 공통 틀의 버튼으로, 알림톡은 대체 문자 끝에 붙인다. 링크에는 토큰이 들어
   * 있으므로 가림본에서는 언제나 가린다.
   */
  isButtonLink?: boolean;
};

export type TemplateSource = {
  templateCode: string;
  /** 알림톡은 제목이 없다(CHECK notification_templates_title_by_channel) */
  title: string | null;
  body: string;
  variables: TemplateVariable[];
};

export type RenderedTemplate = {
  subject: string | null;
  body: string;
  /** 이력에 남길 제목. 가릴 변수 값이 MASK 로 바뀌어 있다 */
  maskedSubject: string | null;
  /** 이력에 남길 본문. 가릴 변수 값이 MASK 로 바뀌어 있다 */
  maskedBody: string;
  /** 넘긴 버튼 링크 값(isButtonLink), 선언 순서. 빈 값은 뺀다 */
  links: string[];
};

export const MASK = '********';

const PLACEHOLDER = /#\{([^}]+)\}/g;

/**
 * 알림 템플릿의 `#{변수}` 를 채운다. 메일과 알림톡이 같이 쓴다. 본문은 채널을 가리지
 * 않고 일반 글이라 값을 그대로 넣는다 — 메일 HTML 은 메일이 채운 본문 전체를
 * 이스케이프해 공통 틀에 넣어 만든다. 한 번에 치환하므로 값 안의 `#{...}` 는 다시
 * 치환하지 않는다.
 *
 * 이력용 가림본을 같은 규칙으로 함께 만든다. `maskedVariables` 와 버튼 링크 변수를
 * 가린다 — 링크는 호출부가 빠뜨려도 토큰이 평문으로 남지 않게 언제나 가린다. 템플릿에
 * 없는 변수 이름은 넘긴 값이든 가림 이름이든 던진다 — 가림 이름의 오타가 조용히
 * 지나가면 비밀번호가 이력에 평문으로 남는다. 오류 메시지에 값은 담지 않는다.
 */
export function renderTemplate(
  template: TemplateSource,
  values: Record<string, string>,
  maskedVariables: readonly string[] = [],
): RenderedTemplate {
  const { templateCode: code } = template;
  const declared = new Set(template.variables.map((v) => v.name));

  const unknown = [...Object.keys(values), ...maskedVariables].filter(
    (name) => !declared.has(name),
  );
  if (unknown.length)
    throw new Error(`템플릿 ${code} 에 없는 변수입니다: ${unknown.join(', ')}`);
  const missing = template.variables
    .filter((v) => v.isRequired && typeof own(values, v.name) !== 'string')
    .map((v) => v.name);
  if (missing.length)
    throw new Error(
      `템플릿 ${code} 필수 변수가 비었습니다: ${missing.join(', ')}`,
    );

  const buttonLinks = template.variables.filter((v) => v.isButtonLink);
  const masked = { ...values };
  for (const name of [...maskedVariables, ...buttonLinks.map((v) => v.name)])
    masked[name] = MASK;

  const fill = (text: string, from: Record<string, string>) =>
    text.replace(PLACEHOLDER, (_, name: string) => {
      if (!declared.has(name))
        throw new Error(`템플릿 ${code} 에 선언되지 않은 자리입니다: ${name}`);
      return own(from, name) ?? '';
    });
  const subject = (from: Record<string, string>) =>
    template.title === null ? null : fill(template.title, from);

  return {
    subject: subject(values),
    body: fill(template.body, values),
    maskedSubject: subject(masked),
    maskedBody: fill(template.body, masked),
    links: buttonLinks
      .map((v) => own(values, v.name))
      .filter((link): link is string => !!link),
  };
}

/** 자기 속성만 본다. 상속받은 toString 같은 함수가 값으로 끼어들지 않게. */
function own(values: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}
