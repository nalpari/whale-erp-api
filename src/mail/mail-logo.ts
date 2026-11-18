/**
 * 메일 머리 띠의 흰 고래 로고(관리자 웹 헤더 로고를 흰색으로, 띠 색 #282f37 바탕 88×88 PNG — 화면에는 44px).
 * 공개 주소 없이도 보이게 메일에 인라인 첨부(cid)로 싣는다 — SVG · data: 그림은 Gmail 등이 보이지 않는다.
 * 바탕을 띠 색으로 칠해 두어, 메일 전체를 뒤집는 다크 모드에서 띠가 밝아져도 흰 로고가 묻히지 않는다(2026-11-18).
 * 바꾸려면 front `public/guest/logo-whale.svg` · `logo-star.svg` 를 같은 배치로 다시 그린다.
 */
export const MAIL_LOGO_CID = 'whale-erp-logo';

export const MAIL_LOGO_PNG = Buffer.from(
  [
    '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',
  ].join(''),
  'base64',
);
