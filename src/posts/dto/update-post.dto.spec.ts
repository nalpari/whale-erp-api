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

  it.each([[['GUEST', 'GUEST']], [['ADDON']]])(
    '중복되거나 1차에 없는 노출 대상(%p)은 400',
    async (audiences) => {
      await expect(errorsOf({ audiences })).resolves.toEqual(['audiences']);
    },
  );

  it('NUL 문자가 든 제목 · 본문은 400 — PostgreSQL text 가 받지 않아 500 이 된다', async () => {
    await expect(
      errorsOf({ title: 'a\u0000b', body: 'a\u0000' }),
    ).resolves.toEqual(['title', 'body']);
  });

  it.each(['billing', 'A'.repeat(21), 'BILLING\u0000'])(
    'FAQ 카테고리가 상세코드 모양(영문 대문자 · 숫자 · 밑줄 20자)이 아니면(%p) 400',
    async (faqCategoryCode) => {
      await expect(errorsOf({ faqCategoryCode })).resolves.toEqual([
        'faqCategoryCode',
      ]);
    },
  );

  it('제목 200자 · 본문 20,000자를 넘으면 400', async () => {
    await expect(errorsOf({ title: 'a'.repeat(200) })).resolves.toEqual([]);
    await expect(
      errorsOf({ title: 'a'.repeat(201), body: 'a'.repeat(20_001) }),
    ).resolves.toEqual(['title', 'body']);
  });

  it('공백만 있는 제목 · 본문은 400', async () => {
    await expect(errorsOf({ title: '   ', body: '\n' })).resolves.toEqual([
      'title',
      'body',
    ]);
  });
});
