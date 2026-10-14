/**
 * 관리자 웹(whale-erp-front) 주소(`ADMIN_WEB_URL`)를 읽는 하나뿐인 규칙. 메일의 바로가기 버튼이
 * `adminWebLink(이 주소, 화면 경로)` 로 간다(운영 정책 NTF-03). 플랫폼 관리자 메일 · BP 회원가입 메일 · 문의 답변
 * 메일이 모두 이것을 쓴다.
 *
 * - 비었으면 null — 기동은 하고 그 메일만 보내지 않는다. 꼭 있어야 하는 곳은 `src/admin-signup/admin-web-url.ts` 처럼
 *   null 을 던짐으로 바꿔 쓴다.
 * - http(s) 주소가 아니면 기동 때 던진다 — 첫 메일 때가 아니라 배포 때 알게.
 * - 운영에서는 https 만 받는다(`staff-app-url.ts` 와 같다). 메일 링크로 관리자가 로그인한다.
 * - 끝의 `/` 는 뗀다. 경로는 받는다 — 하위 경로에 배포한 관리자 웹이면 그 경로 뒤에 화면 경로가 붙는다.
 */
export function readOptionalAdminWebUrl(
  raw: string | undefined,
  production: boolean,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value))
    throw new Error(`ADMIN_WEB_URL 은 http(s) 주소여야 합니다: ${value}`);
  if (production && !/^https:\/\//i.test(value))
    throw new Error(`운영에서 ADMIN_WEB_URL 은 https 여야 합니다: ${value}`);
  return value.replace(/\/+$/, '');
}

/** 관리자 웹 화면의 전체 주소. `path` 는 `/` 로 시작하는 관리자 웹 경로이고, 주소의 경로를 버리지 않는다. */
export function adminWebLink(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}
