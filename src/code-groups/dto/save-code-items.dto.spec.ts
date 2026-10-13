// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListCodeGroupsDto } from './list-code-groups.dto';
import { CreateCodeGroupDto } from './save-code-groups.dto';
import { CodeItemInputDto } from './save-code-items.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const check = async <T extends object>(cls: new () => T, plain: object) => {
  const dto = plainToInstance(cls, plain);
  return { dto, errors: await validate(dto) };
};

describe('공통코드 입력 형식', () => {
  const item = { label: '정규직', status: 'ACTIVE', sortOrder: 1 };

  it('소문자로 쳐도 대문자로 바꿔 받는다', async () => {
    const { dto, errors } = await check(CodeItemInputDto, {
      ...item,
      itemCode: 'full_time',
    });
    expect(errors).toHaveLength(0);
    expect(dto.itemCode).toBe('FULL_TIME');
  });

  it.each(['A', 'A'.repeat(20), 'POS_2', 'TABLE_ORDER'])(
    '%p 는 받는다',
    async (itemCode) => {
      const { errors } = await check(CodeItemInputDto, { ...item, itemCode });
      expect(errors).toHaveLength(0);
    },
  );

  it.each(['', '1POS', '_POS', 'A'.repeat(21), 'POS-2', 'POS 2', '가나'])(
    '%p 는 거른다',
    async (itemCode) => {
      const { errors } = await check(CodeItemInputDto, { ...item, itemCode });
      expect(errors.map((e) => e.property)).toEqual(['itemCode']);
    },
  );

  it('새 그룹의 관리 주체는 플랫폼고정 · 플랫폼제공만', async () => {
    const group = {
      groupCode: 'BANK',
      groupName: '은행',
      status: 'ACTIVE',
      sortOrder: 1,
    };
    for (const manageOwnerCode of ['PLATFORM_FIXED', 'PLATFORM_PROVIDED'])
      expect(
        (await check(CreateCodeGroupDto, { ...group, manageOwnerCode })).errors,
      ).toHaveLength(0);
    const { errors } = await check(CreateCodeGroupDto, {
      ...group,
      manageOwnerCode: 'BP_ONLY',
    });
    expect(errors.map((e) => e.property)).toEqual(['manageOwnerCode']);
  });

  // integer 칸을 넘는 값은 DB 가 거부해 500 이 된다. 검증에서 400 으로 끝낸다.
  it('표시 순서는 integer 범위 안이어야 한다', async () => {
    const group = {
      groupCode: 'BANK',
      groupName: '은행',
      status: 'ACTIVE',
      manageOwnerCode: 'PLATFORM_PROVIDED',
    };
    for (const [cls, plain] of [
      [CodeItemInputDto, { ...item, itemCode: 'FULL' }],
      [CreateCodeGroupDto, group],
    ] as [new () => object, object][]) {
      const ok = await check(cls, { ...plain, sortOrder: 2_147_483_647 });
      expect(ok.errors).toHaveLength(0);
      const { errors } = await check(cls, {
        ...plain,
        sortOrder: 2_147_483_648,
      });
      expect(errors.map((e) => e.property)).toEqual(['sortOrder']);
    }
  });

  it('쪽 번호는 건너뛸 행 수가 integer 범위를 넘지 않을 만큼만', async () => {
    const page = (n: number) => check(ListCodeGroupsDto, { page: String(n) });
    expect((await page(10_000_000)).errors).toHaveLength(0);
    expect((await page(10_000_001)).errors.map((e) => e.property)).toEqual([
      'page',
    ]);
  });

  // DB 에 공백 금지 CHECK 가 없어 그대로 저장된다. 검증에서 거른다.
  it.each(['', '   '])('그룹명 · 코드명이 %p 면 거른다', async (name) => {
    const { errors: itemErrors } = await check(CodeItemInputDto, {
      ...item,
      itemCode: 'FULL',
      label: name,
    });
    expect(itemErrors.map((e) => e.property)).toEqual(['label']);
    const { errors: groupErrors } = await check(CreateCodeGroupDto, {
      groupCode: 'BANK',
      groupName: name,
      status: 'ACTIVE',
      sortOrder: 1,
      manageOwnerCode: 'PLATFORM_PROVIDED',
    });
    expect(groupErrors.map((e) => e.property)).toEqual(['groupName']);
  });

  it('그룹명 · 코드명의 앞뒤 공백은 지우고 받는다', async () => {
    const { dto, errors } = await check(CodeItemInputDto, {
      ...item,
      itemCode: 'FULL',
      label: '  정규직 ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.label).toBe('정규직');
  });

  it('사용 상태는 ACTIVE · INACTIVE 만', async () => {
    const { errors } = await check(CodeItemInputDto, {
      ...item,
      itemCode: 'FULL',
      status: 'STOPPED',
    });
    expect(errors.map((e) => e.property)).toEqual(['status']);
  });
});
