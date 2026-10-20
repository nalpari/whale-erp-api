// 개인정보를 화면에 내보낼 때의 가림. 형식이 맞지 않으면 던진다 — 깨진 값을 그럴듯하게 가려 내보내면
// 잘못된 번호가 맞는 것처럼 보인다.

/** 주민등록번호 → `980304-1******`. 생년월일과 성별 자리만 남긴다. */
export function maskRrn(rrn: string): string {
  const digits = rrn.replace(/-/g, '');
  if (!/^\d{13}$/.test(digits)) throw new Error('주민등록번호 형식이 아닙니다');
  return `${digits.slice(0, 6)}-${digits[6]}******`;
}

/** 계좌번호 → 끝 4자리만 남긴 `********6789`. 하이픈은 빼고 센다. */
export function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/-/g, '');
  if (!/^\d{5,}$/.test(digits)) throw new Error('계좌번호 형식이 아닙니다');
  return '*'.repeat(digits.length - 4) + digits.slice(-4);
}
