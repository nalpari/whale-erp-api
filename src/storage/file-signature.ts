export type FileKind = 'JPG' | 'PNG' | 'PDF';

// 확장자와 Content-Type 은 보내는 쪽이 정하므로 믿지 않는다.
const SIGNATURES: [FileKind, number[]][] = [
  ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['JPG', [0xff, 0xd8, 0xff]],
  ['PDF', [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
];

/** 파일 앞 바이트로 종류를 판정한다. 모르는 종류면 null. */
export function detectFileType(head: Uint8Array): FileKind | null {
  const match = SIGNATURES.find(([, signature]) =>
    signature.every((byte, i) => head[i] === byte),
  );
  return match?.[0] ?? null;
}
