// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateCodeGroupDto,
  CreateCodeGroupsDto,
} from './create-code-groups.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const errorsOf = async (cls: new () => object, plain: object) =>
  validate(plainToInstance(cls, plain));

const groupRow = {
  groupCode: 'BANK',
  groupName: '은행',
  status: 'ACTIVE',
};
const row = { ...groupRow, manageOwnerCode: 'PLATFORM_PROVIDED' };

describe('CreateCodeGroupDto — 새 그룹 한 행', () => {
  it('관리 주체는 플랫폼고정 · 플랫폼제공만', async () => {
    for (const manageOwnerCode of ['PLATFORM_FIXED', 'PLATFORM_PROVIDED'])
      expect(
        await errorsOf(CreateCodeGroupDto, { ...row, manageOwnerCode }),
      ).toHaveLength(0);
    const errors = await errorsOf(CreateCodeGroupDto, {
      ...row,
      manageOwnerCode: 'BP_ONLY',
    });
    expect(errors.map((e) => e.property)).toEqual(['manageOwnerCode']);
  });

  // 표시 순서는 api 가 매긴다(전체 최대 + 1) — 화면이 보낸 값은 앱의 ValidationPipe 처럼 400 이다.
  it('표시 순서는 받지 않는다', async () => {
    const errors = await validate(
      plainToInstance(CreateCodeGroupDto, { ...row, sortOrder: 6 }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.map((e) => e.property)).toEqual(['sortOrder']);
  });

  it('행 형식은 그룹 행(CodeGroupInputDto)의 검증을 물려받는다', async () => {
    const errors = await errorsOf(CreateCodeGroupDto, {
      ...row,
      groupName: '',
    });
    expect(errors.map((e) => e.property)).toEqual(['groupName']);
  });
});

// 본문은 { items } 하나다. 빈 배열은 할 일이 없는 요청이라 400, 상한은 화면이 한 번에 보낼 만큼.
describe('CreateCodeGroupsDto — 그룹 등록 본문', () => {
  const constraintsOf = async (plain: object) =>
    (await errorsOf(CreateCodeGroupsDto, plain)).flatMap((e) => [
      e.property,
      ...Object.keys(e.constraints ?? {}),
    ]);

  it('한 행이면 받는다', async () => {
    expect(await constraintsOf({ items: [row] })).toEqual([]);
  });

  it('빈 items · items 없음은 400', async () => {
    expect(await constraintsOf({ items: [] })).toEqual([
      'items',
      'arrayMinSize',
    ]);
    expect(await constraintsOf({})).toContain('items');
  });

  it('상한 200 행까지 받고, 넘으면 400', async () => {
    const rows = (n: number) => ({
      items: Array.from({ length: n }, () => row),
    });
    expect(await constraintsOf(rows(200))).toEqual([]);
    expect(await constraintsOf(rows(201))).toEqual(['items', 'arrayMaxSize']);
  });

  it('수정 행 모양(관리 주체 없음)으로는 등록할 수 없다', async () => {
    const errors = await errorsOf(CreateCodeGroupsDto, { items: [groupRow] });
    expect(errors[0].children?.[0].children?.map((e) => e.property)).toEqual([
      'manageOwnerCode',
    ]);
  });
});
