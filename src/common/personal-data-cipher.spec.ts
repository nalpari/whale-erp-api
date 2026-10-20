import { randomBytes } from 'node:crypto';
import {
  decryptPersonalData,
  encryptPersonalData,
  readPersonalDataKey,
  staffTaxProfileAad,
} from './personal-data-cipher';

const KEY = randomBytes(32);
const AAD = staffTaxProfileAad('rrn_encrypted', 31);

describe('staffTaxProfileAad', () => {
  it('「테이블.칸:직원 레코드 id」 — 쓰는 쪽과 읽는 쪽이 같은 함수를 쓴다', () => {
    expect(staffTaxProfileAad('rrn_encrypted', 31)).toBe(
      'staff_tax_profiles.rrn_encrypted:31',
    );
    expect(staffTaxProfileAad('payroll_account_number_encrypted', 7)).toBe(
      'staff_tax_profiles.payroll_account_number_encrypted:7',
    );
  });
});

describe('readPersonalDataKey', () => {
  it('비어 있으면 null — 키가 없어도 앱은 뜨고, 암호문을 읽을 때만 막는다', () => {
    expect(readPersonalDataKey(undefined)).toBeNull();
    expect(readPersonalDataKey('  ')).toBeNull();
  });

  it('base64 32바이트면 그 키', () => {
    expect(readPersonalDataKey(KEY.toString('base64'))).toEqual(KEY);
  });

  it('32바이트가 아니면 기동을 막는다 — 틀린 키로 뜬 서버는 모든 복호화가 실패한다', () => {
    expect(() =>
      readPersonalDataKey(randomBytes(16).toString('base64')),
    ).toThrow(/PERSONAL_DATA_ENCRYPTION_KEY/);
    expect(() => readPersonalDataKey('not base64!')).toThrow(
      /PERSONAL_DATA_ENCRYPTION_KEY/,
    );
  });
});

describe('encryptPersonalData · decryptPersonalData', () => {
  it('암호화한 값을 같은 키 · 같은 AAD 로 되돌린다', () => {
    const sealed = encryptPersonalData(KEY, '9803041234567', AAD);
    expect(decryptPersonalData(KEY, sealed, AAD)).toBe('9803041234567');
  });

  it('형식: 버전 1바이트(1) + IV 12 + 태그 16 + 암호문 — 원문이 보이지 않는다', () => {
    const sealed = encryptPersonalData(KEY, '9803041234567', AAD);
    expect(sealed[0]).toBe(1);
    expect(sealed.length).toBe(1 + 12 + 16 + 13);
    expect(sealed.toString('latin1')).not.toContain('9803041234567');
  });

  it('같은 원문도 매번 다른 값 — IV 를 매번 새로 뽑는다', () => {
    expect(encryptPersonalData(KEY, 'a', AAD)).not.toEqual(
      encryptPersonalData(KEY, 'a', AAD),
    );
  });

  it('다른 행의 AAD 로는 풀리지 않는다 — 암호문을 남의 행으로 옮겨도 쓸 수 없다', () => {
    const sealed = encryptPersonalData(KEY, '9803041234567', AAD);
    expect(() =>
      decryptPersonalData(KEY, sealed, staffTaxProfileAad('rrn_encrypted', 32)),
    ).toThrow();
  });

  it('다른 키 · 한 바이트라도 바뀐 암호문은 던진다', () => {
    const sealed = encryptPersonalData(KEY, '9803041234567', AAD);
    expect(() => decryptPersonalData(randomBytes(32), sealed, AAD)).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptPersonalData(KEY, tampered, AAD)).toThrow();
  });

  it('모르는 버전 · 너무 짧은 값은 던진다', () => {
    const sealed = encryptPersonalData(KEY, 'x', AAD);
    const v2 = Buffer.from(sealed);
    v2[0] = 2;
    expect(() => decryptPersonalData(KEY, v2, AAD)).toThrow(/버전/);
    expect(() => decryptPersonalData(KEY, Buffer.alloc(10), AAD)).toThrow();
  });

  it('32바이트가 아닌 키는 암호화 · 복호화 모두 던진다 — 키를 읽는 곳을 거치지 않고 불러도', () => {
    const short = randomBytes(16);
    expect(() => encryptPersonalData(short, 'x', AAD)).toThrow(/32바이트/);
    const sealed = encryptPersonalData(KEY, 'x', AAD);
    expect(() => decryptPersonalData(short, sealed, AAD)).toThrow(/32바이트/);
  });
});
