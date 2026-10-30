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
  };

  it('그룹 코드는 대문자로 바꿔 받고, 형식이 틀리면 거른다', async () => {
    const ok = await check({ ...group, groupCode: ' bank_2 ' });
    expect(ok.errors).toHaveLength(0);
    expect(ok.dto.groupCode).toBe('BANK_2');
    const { errors } = await check({ ...group, groupCode: '1BANK' });
    expect(errors.map((e) => e.property)).toEqual(['groupCode']);
  });

  // 화면 문구와 같은 말이다(front 와 맞춤, 2026-10-30).
  it('형식 · 길이 문구', async () => {
    const [code] = (await check({ ...group, groupCode: '1BANK' })).errors;
    expect(Object.values(code.constraints ?? {})).toEqual([
      '영문 대문자로 시작해 영문·숫자·_로 입력해 주세요(최대 20자).',
    ]);
    const [name] = (await check({ ...group, groupName: '가'.repeat(51) }))
      .errors;
    expect(Object.values(name.constraints ?? {})).toEqual([
      '그룹명은 50자까지입니다.',
    ]);
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
