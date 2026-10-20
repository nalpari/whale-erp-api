// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CodeItemInputDto } from './code-item-input.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const check = async (plain: object) => {
  const dto = plainToInstance(CodeItemInputDto, plain);
  return { dto, errors: await validate(dto) };
};

describe('CodeItemInputDto — 상세 코드 한 행', () => {
  const item = { label: '정규직', status: 'ACTIVE', sortOrder: 1 };

  it('소문자로 쳐도 대문자로 바꿔 받는다', async () => {
    const { dto, errors } = await check({ ...item, itemCode: 'full_time' });
    expect(errors).toHaveLength(0);
    expect(dto.itemCode).toBe('FULL_TIME');
  });

  it.each(['A', 'A'.repeat(20), 'POS_2', 'TABLE_ORDER'])(
    '%p 는 받는다',
    async (itemCode) => {
      const { errors } = await check({ ...item, itemCode });
      expect(errors).toHaveLength(0);
    },
  );

  it.each(['', '1POS', '_POS', 'A'.repeat(21), 'POS-2', 'POS 2', '가나'])(
    '%p 는 거른다',
    async (itemCode) => {
      const { errors } = await check({ ...item, itemCode });
      expect(errors.map((e) => e.property)).toEqual(['itemCode']);
    },
  );

  // integer 칸을 넘는 값은 DB 가 거부해 500 이 된다. 검증에서 400 으로 끝낸다.
  it('표시 순서는 integer 범위 안이어야 한다', async () => {
    const row = { ...item, itemCode: 'FULL' };
    expect(
      (await check({ ...row, sortOrder: 2_147_483_647 })).errors,
    ).toHaveLength(0);
    const { errors } = await check({ ...row, sortOrder: 2_147_483_648 });
    expect(errors.map((e) => e.property)).toEqual(['sortOrder']);
  });

  // DB 에 공백 금지 CHECK 가 없어 그대로 저장된다. 검증에서 거른다.
  it.each(['', '   '])('코드명이 %p 면 거른다', async (label) => {
    const { errors } = await check({ ...item, itemCode: 'FULL', label });
    expect(errors.map((e) => e.property)).toEqual(['label']);
  });

  it('코드명의 앞뒤 공백은 지우고 받는다', async () => {
    const { dto, errors } = await check({
      ...item,
      itemCode: 'FULL',
      label: '  정규직 ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.label).toBe('정규직');
  });

  it('사용 상태는 ACTIVE · INACTIVE 만', async () => {
    const { errors } = await check({
      ...item,
      itemCode: 'FULL',
      status: 'STOPPED',
    });
    expect(errors.map((e) => e.property)).toEqual(['status']);
  });
});
