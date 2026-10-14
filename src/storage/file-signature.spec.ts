import { detectFileType } from './file-signature';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('detectFileType', () => {
  it.each([
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)],
    ['JPG', bytes(0xff, 0xd8, 0xff, 0xe0, 0x00)],
    ['PDF', Buffer.from('%PDF-1.7\n')],
  ])('%s 를 앞 바이트로 알아본다', (kind, head) => {
    expect(detectFileType(head)).toBe(kind);
  });

  it('확장자만 바꾼 글 파일은 알아보지 않는다', () => {
    expect(detectFileType(Buffer.from('hello.pdf'))).toBeNull();
  });

  it('비었거나 서명보다 짧으면 던지지 않고 null', () => {
    expect(detectFileType(bytes())).toBeNull();
    expect(detectFileType(bytes(0xff, 0xd8))).toBeNull();
  });
});
