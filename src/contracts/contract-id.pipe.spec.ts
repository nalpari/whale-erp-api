import { NotFoundException } from '@nestjs/common';
import { ContractIdPipe } from './contract-id.pipe';

describe('ContractIdPipe', () => {
  const pipe = new ContractIdPipe();

  it('1..2147483647 의 정수 글자를 숫자로 바꾼다', () => {
    expect(pipe.transform('7')).toBe(7);
    expect(pipe.transform('2147483647')).toBe(2147483647);
  });

  // integer 컬럼을 넘는 값이 DB 까지 가면 Postgres 가 오류를 내 404 가 500 이 된다.
  it.each(['0', '-1', '2147483648', '1.5', 'abc', '07a', ''])(
    '%p 는 없는 계약이라 404',
    (raw) => {
      expect(() => pipe.transform(raw)).toThrow(NotFoundException);
    },
  );
});
