import { readOptionalAdminWebUrl } from '../common/admin-web-url';
import { isProduction } from '../config/profile';

export const ADMIN_WEB_URL = Symbol('ADMIN_WEB_URL');

/**
 * 관리자 웹(whale-erp-front) 주소. 메일의 바로가기 버튼이 여기로 간다. 규칙은
 * `src/common/admin-web-url.ts` 하나이고, 여기서는 비었을 때 던지는 것만 더한다 — 그대로 뜨면 첫 가입
 * 메일이 버튼 링크 검사에 걸려서야 드러나고, 그때는 가입이 이미 끝나 메일만 조용히 빠진다.
 */
export function readAdminWebUrl(value: string | undefined): string {
  const url = readOptionalAdminWebUrl(value, isProduction());
  if (url === null)
    throw new Error(
      'ADMIN_WEB_URL 가 비어 있습니다. .env.<APP_ENV> 를 확인하세요.',
    );
  return url;
}
