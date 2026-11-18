/**
 * 메일 머리의 고래 로고(관리자 웹 헤더 로고를 짙은 색으로, 흰 바탕 88×88 PNG — 화면에는 34px).
 * 공개 주소 없이도 보이게 메일에 인라인 첨부(cid)로 싣는다 — SVG · data: 그림은 Gmail 등이 보이지 않는다.
 * 바탕을 흰색으로 칠해 두어, 메일 전체를 뒤집는 다크 모드에서도 짙은 로고가 어두운 바탕에 묻히지 않는다(2026-11-18).
 * 바꾸려면 front `public/guest/logo-whale.svg` · `logo-star.svg` 를 같은 배치로 다시 그린다.
 */
export const MAIL_LOGO_CID = 'whale-erp-logo';

export const MAIL_LOGO_PNG = Buffer.from(
  [
    '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',
  ].join(''),
  'base64',
);
