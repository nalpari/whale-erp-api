import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// 주민등록번호 · 급여 계좌 같은 개인정보 칸(bytea)의 암호화. AES-256-GCM 이고 저장 형식은
// 버전(1) + IV(12) + 인증 태그(16) + 암호문이다. 버전 바이트는 저장 형식의 버전이고 지금은 1 뿐이다 — 키를 바꾸게 되면
// 어느 키로 잠갔는지 가를 방법은 그때 새 버전과 함께 정한다. AAD 에 「테이블.칸:행 id」를 넣어, 암호문을 다른 행으로
// 옮기면 풀리지 않게 한다(WHALEERP-188, 2026-10-20 노영주 결정). 화면에 가린 값이라도 보여야 해서 해시가 아닌 양방향이다.
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** 신고 정보 칸의 AAD — 쓰는 곳(신고 정보 저장)과 읽는 곳이 이 함수 하나로 맞춘다 */
export function staffTaxProfileAad(
  column: 'rrn_encrypted' | 'payroll_account_number_encrypted',
  staffMemberId: number,
): string {
  return `staff_tax_profiles.${column}:${staffMemberId}`;
}

function assertKey(key: Buffer) {
  if (key.length !== KEY_BYTES)
    throw new Error(`개인정보 암호화 키는 ${KEY_BYTES}바이트여야 합니다`);
}

/**
 * `PERSONAL_DATA_ENCRYPTION_KEY`(base64, 32바이트)를 읽는다. 비어 있으면 null — 있는 신고 정보를 읽을 때만
 * 503 으로 막고 앱은 뜬다. 값이 있는데 32바이트가 아니면 던져 기동을 막는다: 틀린 키로 뜬 서버는 모든 값을 못 푼다.
 */
export function readPersonalDataKey(value: string | undefined): Buffer | null {
  const raw = value?.trim() ?? '';
  if (raw === '') return null;
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(raw)
    ? Buffer.from(raw, 'base64')
    : Buffer.alloc(0);
  if (key.length !== KEY_BYTES)
    throw new Error(
      `PERSONAL_DATA_ENCRYPTION_KEY 는 base64 로 쓴 ${KEY_BYTES}바이트여야 합니다. 예) node -e ` +
        `"console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
    );
  return key;
}

export function encryptPersonalData(
  key: Buffer,
  plaintext: string,
  aad: string,
): Buffer<ArrayBuffer> {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** 키 · AAD 가 다르거나 값이 바뀌었으면 던진다. */
export function decryptPersonalData(
  key: Buffer,
  sealed: Uint8Array,
  aad: string,
): string {
  assertKey(key);
  const buf = Buffer.from(sealed);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES)
    throw new Error('암호문이 너무 짧습니다');
  if (buf[0] !== VERSION)
    throw new Error(`모르는 암호문 버전입니다: ${buf[0]}`);
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(buf.subarray(1 + IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
