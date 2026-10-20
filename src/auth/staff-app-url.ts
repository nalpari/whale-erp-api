const RESET_LINK_PATH = '/password-reset/link';
const INVITE_LINK_PATH = '/invite';

/**
 * 직원 앱 주소(`STAFF_APP_URL`). 관리자 초기화 재설정 링크가 이 주소로 간다(WHALEERP-172). 비었으면 null — 기동은
 * 하고 링크 발송만 503 이다(직원 앱 주소 설정 없이도 로그인은 떠야 한다). 잘못된 값은 기동 때 던진다 — 첫 발송 때가
 * 아니라 배포 때 알게. 운영에서는 https 만 받는다: 링크에 비밀번호를 바꿀 권한(토큰)이 실린다.
 *
 * 앱 스킴(`whaleerp://`)은 받지 않는다 — 메일 앱이 막거나 지우고, 앱이 없는 기기에서 스토어로 보낼 수 없다.
 * 앱 포장 때 같은 https 주소를 Universal Links · App Links 로 앱에 연결한다(2026-10-13 노영주).
 */
export function readStaffAppUrl(
  raw: string | undefined,
  production: boolean,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!URL.canParse(value))
    throw new Error(`STAFF_APP_URL 이 주소가 아닙니다: ${value}`);
  const { protocol } = new URL(value);
  if (protocol !== 'https:' && protocol !== 'http:')
    throw new Error(`STAFF_APP_URL 은 웹 주소여야 합니다: ${value}`);
  if (production && protocol !== 'https:')
    throw new Error(
      '운영에서 STAFF_APP_URL 은 https 여야 합니다 — 링크에 재설정 토큰이 실린다',
    );
  return value;
}

/**
 * 재설정 링크. 기본 주소의 경로는 버리고(origin 만 쓴다) 직원 앱의 고정 경로를 쓴다. 토큰은 쿼리가 아니라
 * fragment(`#token=`)에 싣는다 — fragment 는 서버로 가지 않아 직원 앱 · BFF 접근 로그에 남지 않는다(api #28 리뷰).
 */
export function resetLinkOf(baseUrl: string, token: string): string {
  const url = new URL(RESET_LINK_PATH, baseUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

/**
 * 가입 초대 링크(`/invite#token=…`, 2026-10-19 재영 — 진입 · 가입 화면 가이드). 재설정 링크와 같이 origin 만 쓰고
 * 토큰은 fragment 에 싣는다. 링크로 열면 직원 앱이 초대 코드 입력을 건너뛴다.
 */
export function inviteLinkOf(baseUrl: string, token: string): string {
  const url = new URL(INVITE_LINK_PATH, baseUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
