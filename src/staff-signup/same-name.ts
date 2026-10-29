import { nameKey } from '../contracts/identity-match';

/**
 * 계정이 그 직원 레코드의 사람인지 이름으로 본다 — 날인 전 본인 대조와 같은 규칙(contracts/identity-match.ts 의 nameKey: 공백을
 * 모두 지우고 영문은 대문자로, 저장 값은 그대로)을 그대로 쓴다. 계정 번호는 바꿀 길이 없어, 번호가 다른 사람에게 넘어가면 옛
 * 계정이 새 주인 앞으로 온 초대 · 요청을 받지 않게 번호와 함께 이름을 본다 — 근무지 더하기(2026-10-28 김민식, api #180 리뷰)와
 * 소속 추가 확인 · 복귀 확인 요청(2026-10-29 김민식, WHALEERP-140). 소속 추가 확인 메일(contract-delivery)도 같은 nameKey 로
 * 보내 앱 목록과 메일의 기준이 어긋나지 않는다.
 */
export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);
