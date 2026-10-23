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

  it('그룹 코드 · 그룹명 검색어는 앞뒤 공백을 지우고, 각각 20자 · 50자까지 받는다', async () => {
    const dto = plainToInstance(ListCodeGroupsDto, {
      groupCode: '  emp_ ',
      groupName: ' 고용 ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto).toMatchObject({ groupCode: 'emp_', groupName: '고용' });

    const tooLong = plainToInstance(ListCodeGroupsDto, {
      groupCode: 'A'.repeat(21),
      groupName: '가'.repeat(51),
    });
    expect((await validate(tooLong)).map((e) => e.property)).toEqual([
      'groupCode',
      'groupName',
    ]);
  });
});
