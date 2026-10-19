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

  describe('multipart 텍스트 칸 (WHALEERP-272) — 값이 모두 문자열로 온다', () => {
    const dtoOf = (overrides: Record<string, unknown>) =>
      plainToInstance(UpdatePostDto, {
        title: '제목',
        body: '본문',
        status: 'DRAFT',
        updatedAt: '2026-10-13T01:02:03.456Z',
        ...overrides,
      });

    it('노출 대상 하나는 문자열, 여럿은 배열로 온다 — 둘 다 목록이 된다', async () => {
      expect(dtoOf({ audiences: 'GUEST' }).audiences).toEqual(['GUEST']);
      expect(dtoOf({ audiences: ['GUEST', 'BP'] }).audiences).toEqual([
        'GUEST',
        'BP',
      ]);
      await expect(errorsOf({ audiences: 'GUEST' })).resolves.toEqual([]);
    });

    it('노출 대상을 빼면 빈 목록이다 — multipart 는 빈 배열을 보낼 수 없다', async () => {
      expect(dtoOf({}).audiences).toEqual([]);
      await expect(errorsOf({ audiences: undefined })).resolves.toEqual([]);
    });

    it.each([
      ['true', true],
      ['false', false],
    ])('상단 고정 %p 는 %p', (raw, value) => {
      expect(dtoOf({ isPinned: raw }).isPinned).toBe(value);
    });

    it('상단 고정이 참 · 거짓이 아니면 400', async () => {
      await expect(errorsOf({ isPinned: 'yes' })).resolves.toEqual([
        'isPinned',
      ]);
    });

    it('빈 문자열인 선택 칸은 비운 값(null)이다', async () => {
      const dto = dtoOf({
        noticeType: '',
        publishStartDate: '',
        publishEndDate: '',
        faqCategoryCode: '',
      });
      expect(dto).toMatchObject({
        noticeType: null,
        publishStartDate: null,
        publishEndDate: null,
        faqCategoryCode: null,
      });
      await expect(
        errorsOf({ noticeType: '', publishStartDate: '', faqCategoryCode: '' }),
      ).resolves.toEqual([]);
    });

    it('뺄 첨부 ID 는 하나든 여럿이든 정수 목록이 된다', async () => {
      expect(dtoOf({ removeAttachmentIds: '3' }).removeAttachmentIds).toEqual([
        3,
      ]);
      expect(
        dtoOf({ removeAttachmentIds: ['3', '4'] }).removeAttachmentIds,
      ).toEqual([3, 4]);
      await expect(
        errorsOf({ removeAttachmentIds: ['3', '4'] }),
      ).resolves.toEqual([]);
    });

    it.each([['abc'], ['1.5'], ['0'], ['2147483648'], [['3', '3']]])(
      '뺄 첨부 ID 가 1~2147483647 의 서로 다른 정수가 아니면(%p) 400',
      async (removeAttachmentIds) => {
        await expect(errorsOf({ removeAttachmentIds })).resolves.toEqual([
          'removeAttachmentIds',
        ]);
      },
    );
  });

  it('공백만 있는 제목 · 본문은 400', async () => {
    await expect(errorsOf({ title: '   ', body: '\n' })).resolves.toEqual([
      'title',
      'body',
    ]);
  });
});
