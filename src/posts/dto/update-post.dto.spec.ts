import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdatePostDto } from './update-post.dto';

describe('UpdatePostDto', () => {
  const errorsOf = async (overrides: Record<string, unknown>) => {
    const dto = plainToInstance(UpdatePostDto, {
      title: '제목',
      body: '본문',
      status: 'DRAFT',
      audiences: [],
      updatedAt: '2026-10-13T01:02:03.456Z',
      ...overrides,
    });
    return (await validate(dto)).map((e) => e.property);
  };

  it('상세 응답의 updatedAt 그대로면 통과한다', async () => {
    await expect(errorsOf({})).resolves.toEqual([]);
    await expect(
      errorsOf({ updatedAt: '2026-10-13T10:02:03.456+09:00' }),
    ).resolves.toEqual([]);
  });

  it.each(['2026-10-13T10:00:00', '2026-10-13'])(
    '시간대가 없는 updatedAt(%s)은 400',
    async (updatedAt) => {
      await expect(errorsOf({ updatedAt })).resolves.toEqual(['updatedAt']);
    },
  );

  it('공백만 있는 제목 · 본문은 400', async () => {
    await expect(errorsOf({ title: '   ', body: '\n' })).resolves.toEqual([
      'title',
      'body',
    ]);
  });
});
