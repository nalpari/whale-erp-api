export type TemplateVariable = {
  name: string;
  isRequired?: boolean;
  /**
   * 「필수 변수는 본문에 있어야 한다」 검사에서 빠지는 링크 변수. 알림톡은 버튼으로 붙일
   * 링크라 본문에 자리가 없고, 대체 문자 끝에 붙인다. 메일은 이 표시를 읽지 않는다.
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
};

export const MASK = '********';

const PLACEHOLDER = /#\{([^}]+)\}/g;
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 알림 템플릿의 `#{변수}` 를 채운다. 메일과 알림톡이 같이 쓴다. 메일 본문은 완성된
 * HTML 이라 `escapeBody` 로 값을 이스케이프해 넣고, 알림톡 본문은 텍스트라 그대로
 * 넣는다. 제목은 메일 헤더라 언제나 그대로다. 한 번에 치환하므로 값 안의 `#{...}`
 * 는 다시 치환하지 않는다.
 *
 * 이력용 가림본을 같은 규칙으로 함께 만든다. 템플릿에 없는 변수 이름은 넘긴
 * 값이든 가림 이름이든 던진다 — 가림 이름의 오타가 조용히 지나가면 비밀번호가
 * 이력에 평문으로 남는다. 오류 메시지에 값은 담지 않는다.
 */
export function renderTemplate(
  template: TemplateSource,
  values: Record<string, string>,
  maskedVariables: readonly string[] = [],
  { escapeBody = false }: { escapeBody?: boolean } = {},
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

  const masked = { ...values };
  for (const name of maskedVariables) masked[name] = MASK;

  const fill = (text: string, from: Record<string, string>, escape: boolean) =>
    text.replace(PLACEHOLDER, (_, name: string) => {
      if (!declared.has(name))
        throw new Error(`템플릿 ${code} 에 선언되지 않은 자리입니다: ${name}`);
      const value = own(from, name) ?? '';
      return escape ? escapeHtml(value) : value;
    });
  const subject = (from: Record<string, string>) =>
    template.title === null ? null : fill(template.title, from, false);

  return {
    subject: subject(values),
    body: fill(template.body, values, escapeBody),
    maskedSubject: subject(masked),
    maskedBody: fill(template.body, masked, escapeBody),
  };
}

/** 자기 속성만 본다. 상속받은 toString 같은 함수가 값으로 끼어들지 않게. */
function own(values: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
