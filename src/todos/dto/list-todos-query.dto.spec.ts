import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListTodosQueryDto } from './list-todos-query.dto';

const parse = (query: Record<string, unknown>) =>
  plainToInstance(ListTodosQueryDto, { page: '1', pageSize: '20', ...query });

describe('ListTodosQueryDto 담당직원 이름(WHALEERP-713)', () => {
  it('앞뒤 공백을 지우고, 공백만이면 없는 것으로 본다', async () => {
    const trimmed = parse({ assigneeName: '  김하늘 ' });
    expect(trimmed.assigneeName).toBe('김하늘');
    expect(await validate(trimmed)).toEqual([]);
    const blank = parse({ assigneeName: '   ' });
    expect(blank.assigneeName).toBeUndefined();
    expect(await validate(blank)).toEqual([]);
  });

  it('50자까지 받고 51자는 400', async () => {
    expect(await validate(parse({ assigneeName: '가'.repeat(50) }))).toEqual(
      [],
    );
    const errors = await validate(parse({ assigneeName: '가'.repeat(51) }));
    expect(errors.map((e) => e.property)).toEqual(['assigneeName']);
  });

  it('여러 번 보내면(배열) 400', async () => {
    const errors = await validate(parse({ assigneeName: ['김', '이'] }));
    expect(errors.map((e) => e.property)).toEqual(['assigneeName']);
  });
});
