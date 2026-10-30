/**
 * 버튼을 다는 알림톡 템플릿의 버튼(WHALEERP-636) — 버튼 이름과, 버튼 링크가 들어가는 변수 이름. 이름은 카카오에 등록 · 검수한
 * 버튼 이름과 글자 하나까지 같아야 한다 — 다르면 비즈뿌리오가 거절한다(28자까지). 템플릿 변수 목록이 아니라 코드에 두는 까닭:
 * 변수 목록은 템플릿 관리 화면이 저장할 때 아는 칸만 남겨, 거기에 둔 이름은 화면에서 한 번 저장하면 지워진다(메일 버튼
 * 「바로가기」도 코드에 있다). 링크 변수 이름까지 두는 까닭: 관리 화면에서 버튼 링크 표시를 다른 변수(초대코드 · 근무지)로
 * 옮기면 그 값이 버튼 주소로 실리거나 모든 발송이 실패한다(api #219 리뷰). 템플릿 코드로 찾는다 — 발송 코드가 템플릿을 부르는
 * 이름이다. 두 이름은 재영 2026-10-30 확정, 카카오에도 이 이름으로 등록한다 — 바꾸면 카카오 재검수와 함께 바꾼다.
 */
export const ALIMTALK_BUTTONS: Readonly<
  Record<string, { readonly name: string; readonly link: string }>
> = {
  TALK_STAFF_INVITATION: { name: '가입하기', link: '링크' },
  TALK_STAFF_AFFILIATION_REQUEST: { name: '요청 확인하기', link: '링크' },
};

/** 그 템플릿 코드의 알림톡 버튼. 버튼을 달지 않는 템플릿이면 undefined */
export function alimtalkButtonOf(
  templateCode: string,
): { name: string; link: string } | undefined {
  return Object.hasOwn(ALIMTALK_BUTTONS, templateCode)
    ? ALIMTALK_BUTTONS[templateCode]
    : undefined;
}

/**
 * 알림톡 템플릿의 버튼 설정이 보낼 수 있는 모양인가. 버튼을 다는 템플릿은 정해진 링크 변수 하나에만 버튼 링크 표시가 있어야
 * 하고(LINK_MISMATCH — 없음 · 다른 변수 · 둘 이상), 버튼을 달지 않는 템플릿에는 버튼 링크 변수가 없어야 한다(NO_BUTTON_NAME).
 * 발송(AlimtalkService) · 근로계약 발송 전 검사 · 템플릿 저장 검사가 같이 본다 — 커밋 뒤 발송에서야 드러나 「다시 보내 주세요」로
 * 보이지 않게(api #219 code-review).
 */
export function alimtalkButtonProblem(
  templateCode: string,
  variables: readonly { name: string; isButtonLink?: boolean }[],
): 'LINK_MISMATCH' | 'NO_BUTTON_NAME' | null {
  const links = variables.filter((v) => v.isButtonLink).map((v) => v.name);
  const button = alimtalkButtonOf(templateCode);
  if (!button) return links.length ? 'NO_BUTTON_NAME' : null;
  return links.length === 1 && links[0] === button.link
    ? null
    : 'LINK_MISMATCH';
}
