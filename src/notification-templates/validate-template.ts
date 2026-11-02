import type {
  NotificationTemplateChannel,
  PreferenceCategory,
} from '@prisma/client';
import { alimtalkButtonProblem } from '../alimtalk/alimtalk-buttons';
import { NO_NUL } from '../common/no-nul';

export type TemplateVariableInput = {
  name: string;
  label: string;
  isRequired: boolean;
  sampleValue: string;
  /** 메일 공통 틀 · 알림톡 버튼이 붙이는 링크. 필수 변수 검사에서 빠진다 (NOTIFY-20) */
  isButtonLink?: boolean;
};

/** 등록 · 수정에서 저장할 템플릿 값 */
export type TemplateInput = {
  channel: NotificationTemplateChannel;
  templateName: string;
  templateCode: string;
  preferenceCategory: PreferenceCategory | null;
  title: string | null;
  body: string;
  kakaoTemplateCode: string | null;
  variables: TemplateVariableInput[];
};

const CODE = /^[A-Z][A-Z0-9_]*$/;
const VARIABLE_NAME = /^[^#{}\s]+$/;
const PUSH_LIMIT = { title: 40, body: 100 }; // NOTIFY-4
const BUTTON_LINK_CHANNELS: NotificationTemplateChannel[] = [
  'EMAIL',
  'ALIMTALK',
]; // NOTIFY-20

/**
 * 저장 전 검사. 고칠 수 있는 문장 목록을 돌려주고, 비어 있으면 저장해도 된다. 발송 때의 renderTemplate 과 같은
 * 규칙(목록에 없는 변수, 빈 필수 변수)을 저장 쪽에서 먼저 막아, 운영자가 고친 템플릿 때문에 발송이 멈추지 않게 한다.
 * 운영 정책 NTF-22 · 23 · 24, Manyfast 「알림 템플릿 등록」 예외.
 */
export function validateTemplate(t: TemplateInput): string[] {
  const errors: string[] = [];
  const add = (message: string) => errors.push(message);
  const alimtalk = t.channel === 'ALIMTALK';
  const title = t.title ?? '';

  const texts = [
    t.templateName,
    t.templateCode,
    title,
    t.body,
    t.kakaoTemplateCode ?? '',
  ];
  for (const v of t.variables) texts.push(v.name, v.label, v.sampleValue);
  if (!texts.every((s) => NO_NUL.test(s)))
    add('제어 문자(NUL)는 쓸 수 없습니다.');

  if (!t.templateName.trim()) add('템플릿 이름을 넣어 주세요.');
  else if (t.templateName.length > 100)
    add('템플릿 이름은 100자를 넘을 수 없습니다.');
  if (!t.templateCode) add('템플릿 코드를 넣어 주세요.');
  else if (!CODE.test(t.templateCode) || t.templateCode.length > 100)
    add('템플릿 코드는 영문 대문자로 시작하고 대문자 · 숫자 · 밑줄만 씁니다.');
  if (!t.body.trim()) add('본문을 넣어 주세요.');

  if (alimtalk) {
    if (title) add('알림톡은 제목을 쓰지 않습니다.');
    if (!t.kakaoTemplateCode?.trim()) add('카카오 템플릿 코드를 넣어 주세요.');
  } else {
    if (!title.trim()) add('제목을 넣어 주세요.');
    if (t.kakaoTemplateCode) add('카카오 템플릿 코드는 알림톡에만 넣습니다.');
  }

  if (t.channel === 'PUSH') {
    if (!t.preferenceCategory) add('앱 푸시는 수신 설정 묶음을 골라 주세요.');
    if (title.length > PUSH_LIMIT.title)
      add(
        `제목은 ${PUSH_LIMIT.title}자를 넘을 수 없습니다(지금 ${title.length}자).`,
      );
    if (t.body.length > PUSH_LIMIT.body)
      add(
        `본문은 ${PUSH_LIMIT.body}자를 넘을 수 없습니다(지금 ${t.body.length}자).`,
      );
  } else if (t.preferenceCategory) {
    add('수신 설정 묶음은 앱 푸시에만 고릅니다.');
  }

  if (t.variables.length > 50) add('변수는 50개까지 둘 수 있습니다.');
  const seen = new Set<string>();
  t.variables.forEach((v, i) => {
    const at = `변수 목록 ${i + 1}번째 줄:`;
    if (!v.name) add(`${at} 변수 이름을 넣어 주세요.`);
    else if (!VARIABLE_NAME.test(v.name))
      add(`${at} 변수 이름에 # · 중괄호 · 공백을 쓸 수 없습니다.`);
    else if (seen.has(v.name)) add(`${at} 변수 이름 ${v.name} 이 겹칩니다.`);
    seen.add(v.name);
    if (!v.label.trim()) add(`${at} 표시 이름을 넣어 주세요.`);
    if (v.isButtonLink && !BUTTON_LINK_CHANNELS.includes(t.channel))
      add(`${at} 버튼 링크는 메일 · 알림톡 변수에만 씁니다.`);
  });
  // 알림톡은 카카오에 등록한 버튼 하나만, 그 템플릿 코드에 정해진 이름과 링크 변수로 싣는다 — 맞지 않으면 발송이 보내기 전에
  // 던진다(WHALEERP-636, alimtalk-buttons.ts)
  // 템플릿 코드 형식이 틀렸으면 그 오류만 — 「개발팀에 알려 주세요」로 잘못 보내지 않게
  const buttonProblem =
    alimtalk && CODE.test(t.templateCode)
      ? alimtalkButtonProblem(t.templateCode, t.variables)
      : null;
  if (buttonProblem?.kind === 'LINK_MISMATCH')
    add(
      `이 알림톡의 버튼 링크는 #{${buttonProblem.link}} 변수 하나에만 표시합니다.`,
    );
  if (buttonProblem?.kind === 'NO_BUTTON_NAME')
    add(
      '이 템플릿 코드는 알림톡 버튼 이름이 정해지지 않아 버튼 링크를 쓸 수 없습니다. 카카오에 등록한 버튼 이름을 개발팀에 알려 주세요.',
    );

  const used = new Set<string>();
  const scan = (where: string, text: string) =>
    text.split('\n').forEach((line, i) => {
      const at = `${where} ${i + 1}번째 줄:`;
      for (const m of line.matchAll(/#\{([^}]*)\}/g)) {
        used.add(m[1]);
        if (!seen.has(m[1])) add(`${at} #{${m[1]}} 는 변수 목록에 없습니다.`);
      }
      if (/#\{[^}]*$/.test(line.replace(/#\{[^}]*\}/g, '')))
        add(`${at} 닫히지 않은 #{ 가 있습니다.`);
    });
  if (!alimtalk) scan('제목', title);
  scan('본문', t.body);

  for (const v of t.variables)
    if (v.isRequired && !v.isButtonLink && v.name && !used.has(v.name))
      add(`필수 변수 #{${v.name}} 가 제목 · 본문에 없습니다.`);

  return errors;
}
