import { Prisma } from '@prisma/client';
import { errorKind } from './error-kind';

describe('errorKind', () => {
  it('오류 이름만 — 메시지는 싣지 않는다(받는 주소가 섞일 수 있다)', () => {
    const kind = errorKind(new TypeError('550 <staff@example.com>'));
    expect(kind).toBe('error=TypeError');
    expect(kind).not.toContain('staff@example.com');
  });

  it('Prisma 오류면 코드를 붙인다 — DB 문제인지 로그에서 가른다', () => {
    const error = new Prisma.PrismaClientKnownRequestError('x', {
      code: 'P1001',
      clientVersion: 'x',
    });
    expect(errorKind(error)).toBe(
      'error=PrismaClientKnownRequestError code=P1001',
    );
  });

  it('Error 가 아닌 값도 던지지 않고 종류를 적는다', () => {
    expect(errorKind('down')).toBe('error=string');
    expect(errorKind(null)).toBe('error=object');
  });
});
