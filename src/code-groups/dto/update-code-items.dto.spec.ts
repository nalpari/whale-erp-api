// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCodeItemsDto } from './update-code-items.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const errorsOf = async (plain: object) =>
  validate(plainToInstance(UpdateCodeItemsDto, plain));
const constraintsOf = async (plain: object) =>
  (await errorsOf(plain)).flatMap((e) => [
    e.property,
    ...Object.keys(e.constraints ?? {}),
  ]);

// 본문은 { items } 하나다. 빈 배열은 할 일이 없는 요청이라 400, 상한은 화면이 한 번에 보낼 만큼.
describe('UpdateCodeItemsDto — 상세 코드 수정 본문', () => {
  const row = {
    itemCode: 'FULL',
    label: '정규직',
    status: 'ACTIVE',
    sortOrder: 1,
  };

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

  it('상한 500 행까지 받고, 넘으면 400', async () => {
    const rows = (n: number) => ({
      items: Array.from({ length: n }, () => row),
    });
    expect(await constraintsOf(rows(500))).toEqual([]);
    expect(await constraintsOf(rows(501))).toEqual(['items', 'arrayMaxSize']);
  });

  it('행의 형식도 검증한다', async () => {
    const errors = await errorsOf({ items: [{ ...row, sortOrder: 0 }] });
    expect(errors.map((e) => e.property)).toEqual(['items']);
    expect(errors[0].children?.[0].children?.[0].property).toBe('sortOrder');
  });
});
