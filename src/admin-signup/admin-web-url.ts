export const ADMIN_WEB_URL = Symbol('ADMIN_WEB_URL');

/**
 * 관리자 웹(whale-erp-front) 주소. 메일의 바로가기 버튼이 여기로 간다. 기동 단계에서 읽고
 * 비었거나 웹 주소가 아니면 던진다 — 그대로 뜨면 첫 가입 메일이 버튼 링크 검사에 걸려서야
 * 드러나고, 그때는 가입이 이미 끝나 메일만 조용히 빠진다.
 */
export function readAdminWebUrl(value: string | undefined): string {
  const url = value?.trim();
  if (!url)
    throw new Error(
      'ADMIN_WEB_URL 가 비어 있습니다. .env.<APP_ENV> 를 확인하세요.',
    );
  if (!/^https?:\/\//i.test(url))
    throw new Error('ADMIN_WEB_URL 은 http(s) 주소여야 합니다');
  return url.replace(/\/+$/, '');
}
