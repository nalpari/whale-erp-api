// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CodeGroupInputDto } from './code-group-input.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const check = async (plain: object) => {
  const dto = plainToInstance(CodeGroupInputDto, plain);
  return { dto, errors: await validate(dto) };
};

describe('CodeGroupInputDto — 그룹 한 행', () => {
  const group = {
    groupCode: 'BANK',
    groupName: '은행',
    status: 'ACTIVE',
    sortOrder: 1,
  };

  it('그룹 코드는 대문자로 바꿔 받고, 형식이 틀리면 거른다', async () => {
    const ok = await check({ ...group, groupCode: ' bank_2 ' });
    expect(ok.errors).toHaveLength(0);
    expect(ok.dto.groupCode).toBe('BANK_2');
    const { errors } = await check({ ...group, groupCode: '1BANK' });
    expect(errors.map((e) => e.property)).toEqual(['groupCode']);
  });

  // integer 칸을 넘는 값은 DB 가 거부해 500 이 된다. 검증에서 400 으로 끝낸다.
  it('표시 순서는 integer 범위 안이어야 한다', async () => {
    expect(
      (await check({ ...group, sortOrder: 2_147_483_647 })).errors,
    ).toHaveLength(0);
    const { errors } = await check({ ...group, sortOrder: 2_147_483_648 });
    expect(errors.map((e) => e.property)).toEqual(['sortOrder']);
  });

  // DB 에 공백 금지 CHECK 가 없어 그대로 저장된다. 검증에서 거른다.
  it.each(['', '   '])('그룹명이 %p 면 거른다', async (groupName) => {
    const { errors } = await check({ ...group, groupName });
    expect(errors.map((e) => e.property)).toEqual(['groupName']);
  });

  it('그룹명의 앞뒤 공백은 지우고 받는다', async () => {
    const { dto, errors } = await check({ ...group, groupName: ' 은행  ' });
    expect(errors).toHaveLength(0);
    expect(dto.groupName).toBe('은행');
  });
});
