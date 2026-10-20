// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListCodeGroupsDto } from './list-code-groups.dto';

describe('ListCodeGroupsDto', () => {
  it('쪽 번호는 건너뛸 행 수가 integer 범위를 넘지 않을 만큼만', async () => {
    const page = (n: number) =>
      validate(plainToInstance(ListCodeGroupsDto, { page: String(n) }));
    expect(await page(10_000_000)).toHaveLength(0);
    expect((await page(10_000_001)).map((e) => e.property)).toEqual(['page']);
  });
});
