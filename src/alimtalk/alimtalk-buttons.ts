/**
 * 버튼 링크 변수(isButtonLink)가 있는 알림톡 템플릿의 버튼 이름(WHALEERP-636). 카카오에 등록 · 검수한 버튼 이름과 글자
 * 하나까지 같아야 한다 — 다르면 비즈뿌리오가 거절한다(28자까지). 템플릿 변수 목록이 아니라 코드에 두는 까닭: 변수 목록은
 * 템플릿 관리 화면이 저장할 때 아는 칸만 남겨, 거기에 둔 이름은 화면에서 한 번 저장하면 지워진다(메일 버튼 「바로가기」도
 * 코드에 있다). 템플릿 코드로 찾는다 — 발송 코드가 템플릿을 부르는 이름이다. 두 이름은 재영 2026-10-30 확정, 카카오에도
 * 이 이름으로 등록한다 — 바꾸면 카카오 재검수와 함께 바꾼다.
 */
export const ALIMTALK_BUTTON_NAMES: Readonly<Record<string, string>> = {
  TALK_STAFF_INVITATION: '가입하기',
  TALK_STAFF_AFFILIATION_REQUEST: '요청 확인하기',
};

/** 그 템플릿 코드의 알림톡 버튼 이름. 정해지지 않았으면 undefined */
export function alimtalkButtonNameOf(templateCode: string): string | undefined {
  return Object.hasOwn(ALIMTALK_BUTTON_NAMES, templateCode)
    ? ALIMTALK_BUTTON_NAMES[templateCode]
    : undefined;
}

/**
 * 알림톡 템플릿의 버튼 설정이 보낼 수 있는 모양인가 — 버튼 링크 변수는 하나까지(한 이름의 버튼만 등록한다)이고, 있으면 그
 * 템플릿 코드의 버튼 이름이 있어야 한다. 안 되면 까닭. 발송(AlimtalkService) · 근로계약 발송 전 검사 · 템플릿 저장 검사가
 * 같이 본다 — 커밋 뒤 발송에서야 드러나 「다시 보내 주세요」로 보이지 않게(api #219 code-review).
 */
export function alimtalkButtonProblem(
  templateCode: string,
  variables: readonly { isButtonLink?: boolean }[],
): 'MULTIPLE_LINKS' | 'NO_BUTTON_NAME' | null {
  const links = variables.filter((v) => v.isButtonLink).length;
  if (links > 1) return 'MULTIPLE_LINKS';
  if (links === 1 && !alimtalkButtonNameOf(templateCode))
    return 'NO_BUTTON_NAME';
  return null;
}
