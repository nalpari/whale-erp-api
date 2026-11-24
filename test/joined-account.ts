/**
 * e2e 가 읽은 계정 행에서 탈퇴하지 않은 계정의 개인정보 칸(WHALEERP-770 이후 DB 는 null 을 허용한다)을 값으로 좁힌다. 이 테스트들이
 * 만든 계정은 가입 완료 상태라 다섯 칸이 모두 있다 — 비어 있으면 던진다.
 */
type Nullable<T> = {
  email: string | null;
  passwordHash: string | null;
  realName: string | null;
  birthDate: Date | null;
  phone: string | null;
} & T;

export function joinedOf<T extends Nullable<object>>(
  account: T,
): T & {
  email: string;
  passwordHash: string;
  realName: string;
  birthDate: Date;
  phone: string;
} {
  const { email, passwordHash, realName, birthDate, phone } = account;
  if (
    email === null ||
    passwordHash === null ||
    realName === null ||
    birthDate === null ||
    phone === null
  )
    throw new Error('가입 완료 계정의 개인정보 칸이 비어 있다');
  return { ...account, email, passwordHash, realName, birthDate, phone };
}
