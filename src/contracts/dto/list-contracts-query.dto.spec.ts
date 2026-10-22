import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListContractsQueryDto } from './list-contracts-query.dto';

// ValidationPipe 처럼 바꾸고 검사한다. 걸린 칸 이름이 곧 400 이다.
const check = (plain: object) => {
  const dto = plainToInstance(ListContractsQueryDto, plain);
  return { dto, failed: validateSync(dto).map((e) => e.property) };
};

describe('ListContractsQueryDto (근로계약 목록 쿼리)', () => {
  it('쉼표 목록과 같은 이름 여러 번을 같은 배열로 받는다', () => {
    expect(
      check({ storeIds: '3,5', storeTypes: 'DIRECT,FRANCHISE' }),
    ).toMatchObject({
      dto: { storeIds: [3, 5], storeTypes: ['DIRECT', 'FRANCHISE'] },
      failed: [],
    });
    expect(
      check({ storeIds: ['3', '5'], storeTypes: ['FRANCHISE'] }),
    ).toMatchObject({
      dto: { storeIds: [3, 5], storeTypes: ['FRANCHISE'] },
      failed: [],
    });
  });

  it('같은 이름 여러 번과 쉼표를 섞어도 받는다', () =>
    expect(check({ storeIds: ['1,2', '3'] })).toMatchObject({
      dto: { storeIds: [1, 2, 3] },
      failed: [],
    }));

  it.each(['3,,5', 'a', '0', '2147483648', '0x10', '1e3', ' 1'])(
    '점포 %p 는 400',
    (storeIds) => expect(check({ storeIds }).failed).toEqual(['storeIds']),
  );

  it('점포는 1000개까지', () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => i + 1).join(',');
    expect(check({ storeIds: ids(1000) }).failed).toEqual([]);
    expect(check({ storeIds: ids(1001) }).failed).toEqual(['storeIds']);
  });

  it.each(['', 'HQ', 'DIRECT,'])('점포 유형 %p 는 400', (storeTypes) =>
    expect(check({ storeTypes }).failed).toEqual(['storeTypes']),
  );
});
