/**
 * 계정이 그 직원 레코드의 사람인지 이름으로 본다 — 날인 전 본인 대조(contracts/identity-match.ts 의 nameKey)와 같은 규칙이다:
 * 공백을 모두 지우고 영문은 대문자로(저장 값은 그대로). 계정 번호는 바꿀 길이 없어, 번호가 다른 사람에게 넘어가면 옛 계정이 새
 * 주인 앞으로 온 초대 · 요청을 받지 않게 번호와 함께 이름을 본다 — 근무지 더하기(2026-10-28 김민식, api #180 리뷰)와 소속 추가
 * 확인 · 복귀 확인 요청(2026-10-29 김민식, WHALEERP-140). contracts 는 다른 작업 영역이라 그 함수를 내보내지 않고 같은 식을 둔다.
 */
export const sameName = (a: string, b: string) => {
  const key = (name: string) =>
    name.normalize('NFC').replace(/\s/g, '').toUpperCase();
  return key(a) === key(b);
};
