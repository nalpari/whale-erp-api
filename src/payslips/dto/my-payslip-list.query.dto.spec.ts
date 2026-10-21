import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MyPayslipListQueryDto } from './my-payslip-list.query.dto';

// 주소 그대로(문자열)를 받아 ValidationPipe 처럼 바꾸고 검사한다. 걸리면 400 이다.
const check = (query: Record<string, unknown>) => {
  const dto = plainToInstance(MyPayslipListQueryDto, query);
  return { dto, failed: validateSync(dto).map((e) => e.property) };
};

describe('MyPayslipListQueryDto', () => {
  it('없으면 둘 다 비고 통과한다', () =>
    expect(check({})).toEqual({ dto: {}, failed: [] }));

  it('숫자 문자열은 숫자로 바꾼다', () =>
    expect(check({ storeId: '5', year: '2026' }).dto).toEqual({
      storeId: 5,
      year: 2026,
    }));

  it.each([['0'], ['abc'], [''], ['1.5'], ['2147483648'], [['1', '2']]])(
    '점포 %p 은 400',
    (storeId) => expect(check({ storeId }).failed).toEqual(['storeId']),
  );

  it.each([['1999'], ['2026.5'], ['10000'], ['']])('연도 %p 는 400', (year) =>
    expect(check({ year }).failed).toEqual(['year']),
  );
});
