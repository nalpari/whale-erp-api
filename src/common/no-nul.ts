/** PostgreSQL text 는 NUL(0x00)을 받지 않는다 — 그대로 보내면 500 이다. 문자열 입력 칸에 건다. */
// eslint-disable-next-line no-control-regex -- NUL 을 찾는 것이 목적이다
export const NO_NUL = /^[^\u0000]*$/;
