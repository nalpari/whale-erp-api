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

  it('NUL 문자가 들어 있으면 400(PostgreSQL text 는 NUL 을 받지 않아 그대로 두면 500)', async () => {
    const errors = await validate(parse({ assigneeName: 'a\u0000b' }));
    expect(errors.map((e) => e.property)).toEqual(['assigneeName']);
  });

  it('여러 번 보내면(배열) 400', async () => {
    const errors = await validate(parse({ assigneeName: ['김', '이'] }));
    expect(errors.map((e) => e.property)).toEqual(['assigneeName']);
  });
});

// 본사 점포(2026-11-17) — 점포 유형에 HQ(본사)가 더해졌다
describe('ListTodosQueryDto 점포 유형(storeTypes)', () => {
  it('HQ 를 받는다 — 다른 유형과 섞어도', async () => {
    const hq = parse({ storeTypes: 'HQ' });
    expect(hq.storeTypes).toEqual(['HQ']);
    expect(await validate(hq)).toEqual([]);
    const mixed = parse({ storeTypes: 'FRANCHISE,HQ' });
    expect(mixed.storeTypes).toEqual(['FRANCHISE', 'HQ']);
    expect(await validate(mixed)).toEqual([]);
  });

  it('모르는 유형은 400', async () => {
    const errors = await validate(parse({ storeTypes: 'BRANCH' }));
    expect(errors.map((e) => e.property)).toEqual(['storeTypes']);
  });
});
