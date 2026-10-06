export const ALIMTALK_TEMPLATE_REGISTRY = Symbol('ALIMTALK_TEMPLATE_REGISTRY');

export type AlimtalkTemplate = {
  /** 카카오에 검수 등록한 본문과 글자 하나까지 같아야 한다. 다르면 발송이 거절된다. */
  body: string;
  /** 강조 표기형 템플릿의 제목. 본문처럼 `#{변수}` 를 담을 수 있다. */
  title?: string;
};

type VariableNames<S extends string> =
  S extends `${string}#{${infer V}}${infer Rest}`
    ? V | VariableNames<Rest>
    : never;

/** 본문의 `#{변수}` 에서 뽑은 변수 이름을 키로 갖는 객체 타입. */
export type TemplateVariables<S extends string> = Record<
  VariableNames<S>,
  string
>;

/**
 * 알림톡 템플릿. 키는 비즈뿌리오 템플릿 코드다.
 *
 * `as const` 를 빼면 `satisfies` 만으로는 body 가 string 으로 넓어져
 * `AlimtalkVariables` 가 `{}` 가 된다. 본문이 리터럴로 남아야 변수 이름을 뽑아
 * 호출부의 누락을 컴파일 단계에서 잡는다. 객체에 넓은 타입을 붙여도 같은 이유로 깨진다.
 * 본문이 `https://#{url}` 처럼 프로토콜을 품고 있으면 변수에는 프로토콜을 뺀 값을 넘긴다.
 */
export const ALIMTALK_TEMPLATES = {} as const satisfies Record<
  string,
  AlimtalkTemplate
>;

export type AlimtalkTemplateCode = keyof typeof ALIMTALK_TEMPLATES;

/** 템플릿 하나의 본문과 제목에서 뽑은 변수 객체 타입. */
export type AlimtalkVariablesOf<T extends AlimtalkTemplate> = TemplateVariables<
  T['body'] | (T extends { title: infer S extends string } ? S : never)
>;

export type AlimtalkVariables<C extends AlimtalkTemplateCode> =
  AlimtalkVariablesOf<(typeof ALIMTALK_TEMPLATES)[C]>;
