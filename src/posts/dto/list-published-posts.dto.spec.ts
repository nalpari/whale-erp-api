// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListPublishedPostsDto } from './list-published-posts.dto';

// ValidationPipe 처럼 변환한 뒤 검증한다(whitelist 는 빼고).
const check = async (plain: object) => {
  const dto = plainToInstance(ListPublishedPostsDto, plain);
  return { dto, errors: (await validate(dto)).map((e) => e.property) };
};

describe('공지사항 · FAQ 목록 검색 형식', () => {
  it('구분 · 카테고리 하나는 목록으로 바꾸고, 여러 개도 받는다', async () => {
    const one = await check({ noticeType: 'GENERAL', faqCategoryCode: 'A' });
    expect(one.errors).toEqual([]);
    expect(one.dto).toMatchObject({
      noticeType: ['GENERAL'],
      faqCategoryCode: ['A'],
    });
    const many = await check({
      noticeType: ['GENERAL', 'MAINTENANCE'],
      faqCategoryCode: ['A', 'B'],
    });
    expect(many.errors).toEqual([]);
  });

  it('빈 카테고리는 거르지 않는다(전과 같다)', async () => {
    const { dto, errors } = await check({ faqCategoryCode: '' });
    expect(errors).toEqual([]);
    expect(dto.faqCategoryCode).toEqual([]);
  });

  it('없는 구분 · 21자 카테고리 · 51개 카테고리는 검증 오류', async () => {
    expect((await check({ noticeType: ['GENERAL', 'KIOSK'] })).errors).toEqual([
      'noticeType',
    ]);
    expect(
      (await check({ faqCategoryCode: ['A', 'a'.repeat(21)] })).errors,
    ).toEqual(['faqCategoryCode']);
    expect(
      (await check({ faqCategoryCode: Array.from({ length: 51 }, () => 'A') }))
        .errors,
    ).toEqual(['faqCategoryCode']);
  });
});
