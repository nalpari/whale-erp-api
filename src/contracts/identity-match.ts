import type { Gender } from '@prisma/client';

/** 본인 대조 항목(WHALEERP-125 · 145) — 응답의 mismatches 에 이 이름으로 싣는다 */
export const IDENTITY_FIELDS = [
  'name',
  'phone',
  'birthDate',
  'gender',
  'isForeigner',
] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** 계약서 당사자 칸(관리자 입력분) */
export type ContractIdentity = {
  enteredName: string | null;
  enteredPhone: string | null;
  enteredBirthDate: Date | null;
  enteredGender: Gender | null;
  isForeigner: boolean;
};

/** 당사자 행이 없는 계약 — 모든 칸이 빈 계약서로 대조한다 */
export const EMPTY_CONTRACT_IDENTITY: ContractIdentity = {
  enteredName: null,
  enteredPhone: null,
  enteredBirthDate: null,
  enteredGender: null,
  isForeigner: false,
};

/** 직원 계정(가입 때 직원이 넣은 값) */
export type AccountIdentity = {
  realName: string;
  phone: string;
  birthDate: Date;
  gender: Gender | null;
  isForeigner: boolean;
};

/** 이름은 공백을 모두 지우고 영문은 대문자로 비교한다 — 저장 값은 그대로다(2026-10-16) */
const nameKey = (name: string) =>
  name.normalize('NFC').replace(/\s/g, '').toUpperCase();
const digits = (phone: string) => phone.replace(/\D/g, '');
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 날인 전 본인 대조 — 계약서 값과 직원 계정 값이 다른 항목을 돌려준다(빈 배열이면 날인할 수 있다). 계약서 칸이 비어 있으면
 * 다른 것이다(관리자가 근로자 정보 수정으로 채운다). 성별도 늘 본다 — 가입 때 필수로 받아 계정 성별이 비지 않는다(운영 정책
 * ACC-23 · JOI-10, 2026-10-21 재영). 그 전에 성별 없이 가입한 계정은 계정 값이 비어 다른 것이 된다.
 */
export function identityMismatches(
  contract: ContractIdentity,
  account: AccountIdentity,
): IdentityField[] {
  const out: IdentityField[] = [];
  if (
    contract.enteredName === null ||
    nameKey(contract.enteredName) !== nameKey(account.realName)
  )
    out.push('name');
  if (
    contract.enteredPhone === null ||
    digits(contract.enteredPhone) !== digits(account.phone)
  )
    out.push('phone');
  if (
    contract.enteredBirthDate === null ||
    day(contract.enteredBirthDate) !== day(account.birthDate)
  )
    out.push('birthDate');
  if (
    contract.enteredGender === null ||
    contract.enteredGender !== account.gender
  )
    out.push('gender');
  if (contract.isForeigner !== account.isForeigner) out.push('isForeigner');
  return out;
}
