// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCodeGroupsDto } from './update-code-groups.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const errorsOf = async (plain: object) =>
  validate(plainToInstance(UpdateCodeGroupsDto, plain));
const constraintsOf = async (plain: object) =>
  (await errorsOf(plain)).flatMap((e) => [
    e.property,
    ...Object.keys(e.constraints ?? {}),
  ]);

// 본문은 { items } 하나다. 빈 배열은 할 일이 없는 요청이라 400, 상한은 화면이 한 번에 보낼 만큼.
describe('UpdateCodeGroupsDto — 그룹 수정 본문', () => {
  const row = {
    groupCode: 'BANK',
    groupName: '은행',
    status: 'ACTIVE',
    sortOrder: 1,
    updatedAt: '2026-10-30T01:02:03.456Z',
  };

  it('한 행이면 받는다', async () => {
    expect(await constraintsOf({ items: [row] })).toEqual([]);
  });

  // 목록에서 읽은 값 그대로 — 그 뒤 다른 관리자가 고쳤으면 409 다.
  it('행마다 updatedAt(시간대 포함)이 있어야 한다', async () => {
    for (const item of [
      { ...row, updatedAt: undefined },
      { ...row, updatedAt: '2026-10-30T01:02:03.456' },
    ]) {
      const errors = await errorsOf({ items: [item] });
      expect(errors[0].children?.[0].children?.[0].property).toBe('updatedAt');
    }
  });

  // integer 칸을 넘는 값은 DB 가 거부해 500 이 된다. 검증에서 400 으로 끝낸다.
  it('표시 순서는 integer 범위 안이어야 한다', async () => {
    expect(
      await constraintsOf({ items: [{ ...row, sortOrder: 2_147_483_647 }] }),
    ).toEqual([]);
    const errors = await errorsOf({
      items: [{ ...row, sortOrder: 2_147_483_648 }],
    });
    expect(errors[0].children?.[0].children?.[0].property).toBe('sortOrder');
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

  it('행의 형식도 검증한다', async () => {
    const errors = await errorsOf({ items: [{ ...row, sortOrder: 0 }] });
    expect(errors.map((e) => e.property)).toEqual(['items']);
    expect(errors[0].children?.[0].children?.[0].property).toBe('sortOrder');
  });
});
