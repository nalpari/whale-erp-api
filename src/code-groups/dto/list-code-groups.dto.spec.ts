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

  it('관리 주체는 반복 · 쉼표 둘 다 배열로 받고, 플랫폼고정 · 플랫폼제공 밖은 막는다', async () => {
    const comma = plainToInstance(ListCodeGroupsDto, {
      manageOwnerCodes: 'PLATFORM_FIXED,PLATFORM_PROVIDED',
    });
    expect(await validate(comma)).toHaveLength(0);
    expect(comma.manageOwnerCodes).toEqual([
      'PLATFORM_FIXED',
      'PLATFORM_PROVIDED',
    ]);

    const repeated = plainToInstance(ListCodeGroupsDto, {
      manageOwnerCodes: ['PLATFORM_PROVIDED'],
    });
    expect(await validate(repeated)).toHaveLength(0);

    const bpOnly = plainToInstance(ListCodeGroupsDto, {
      manageOwnerCodes: 'BP_ONLY',
    });
    expect((await validate(bpOnly)).map((e) => e.property)).toEqual([
      'manageOwnerCodes',
    ]);
  });
});
