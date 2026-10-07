export type TemplateVariable = { name: string; isRequired?: boolean };

export type MailTemplateSource = {
  templateCode: string;
  title: string;
  body: string;
  variables: TemplateVariable[];
};

export type RenderedMail = {
  subject: string;
  html: string;
  /** mail_send_logs 에 남길 제목. 가릴 변수 값이 MASK 로 바뀌어 있다 */
  maskedSubject: string;
  /** mail_send_logs 에 남길 본문 */
  maskedHtml: string;
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
 * 메일 템플릿의 `#{변수}` 를 채운다. 본문은 완성된 HTML 이라 값을 이스케이프해
 * 넣고, 제목은 메일 헤더라 그대로 넣는다. 한 번에 치환하므로 값 안의 `#{...}` 는
 * 다시 치환하지 않는다.
 *
 * 이력용 가림본을 같은 규칙으로 함께 만든다. 템플릿에 없는 변수 이름은 넘긴
 * 값이든 가림 이름이든 던진다 — 가림 이름의 오타가 조용히 지나가면 비밀번호가
 * 이력에 평문으로 남는다. 오류 메시지에 값은 담지 않는다.
 */
export function renderMail(
  template: MailTemplateSource,
  values: Record<string, string>,
  maskedVariables: readonly string[] = [],
): RenderedMail {
  const { templateCode: code } = template;
  const declared = new Set(template.variables.map((v) => v.name));

  const unknown = [...Object.keys(values), ...maskedVariables].filter(
    (name) => !declared.has(name),
  );
  if (unknown.length)
    throw new Error(
      `메일 ${code} 템플릿에 없는 변수입니다: ${unknown.join(', ')}`,
    );
  const missing = template.variables
    .filter((v) => v.isRequired && typeof own(values, v.name) !== 'string')
    .map((v) => v.name);
  if (missing.length)
    throw new Error(
      `메일 ${code} 필수 변수가 비었습니다: ${missing.join(', ')}`,
    );

  const masked = { ...values };
  for (const name of maskedVariables) masked[name] = MASK;

  const fill = (text: string, from: Record<string, string>, escape: boolean) =>
    text.replace(PLACEHOLDER, (_, name: string) => {
      if (!declared.has(name))
        throw new Error(
          `메일 ${code} 템플릿에 선언되지 않은 자리입니다: ${name}`,
        );
      const value = own(from, name) ?? '';
      return escape ? escapeHtml(value) : value;
    });

  return {
    subject: fill(template.title, values, false),
    html: fill(template.body, values, true),
    maskedSubject: fill(template.title, masked, false),
    maskedHtml: fill(template.body, masked, true),
  };
}

/** 자기 속성만 본다. 상속받은 toString 같은 함수가 값으로 끼어들지 않게. */
function own(values: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
