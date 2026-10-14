/**
 * 관리자 웹 주소(`ADMIN_WEB_URL`). 메일 버튼이 이 주소 + 업무 화면 경로로 바로 간다(운영 정책 NTF-03). 비었으면
 * null — 기동은 하고 그 메일만 건너뛴다(메일 버튼 링크가 필수 변수라 링크 없이는 보낼 수 없다). 잘못된 값은
 * 기동 때 던진다 — 첫 발송 때가 아니라 배포 때 알게. 경로 · 쿼리 · 조각이 붙은 주소도 잘못된 값이다: 링크는 origin
 * 에 화면 경로를 붙이므로, 하위 경로에 배포한 주소는 링크에서 조용히 사라진다.
 */
export function readAdminWebUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!URL.canParse(value))
    throw new Error(`ADMIN_WEB_URL 이 주소가 아닙니다: ${value}`);
  const { protocol, pathname, search, hash } = new URL(value);
  if (protocol !== 'https:' && protocol !== 'http:')
    throw new Error(`ADMIN_WEB_URL 은 웹 주소여야 합니다: ${value}`);
  if (pathname !== '/' || search || hash)
    throw new Error(
      `ADMIN_WEB_URL 은 경로 없는 주소(origin)여야 합니다: ${value}`,
    );
  return value;
}

/** 관리자 웹 화면의 전체 주소. path 는 `/` 로 시작하는 관리자 웹 경로다. */
export function adminWebLink(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}
