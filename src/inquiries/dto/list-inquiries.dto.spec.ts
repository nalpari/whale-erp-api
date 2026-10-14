// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListInquiriesDto } from './list-inquiries.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const check = async (plain: object) => {
  const dto = plainToInstance(ListInquiriesDto, plain);
  return { dto, errors: (await validate(dto)).map((e) => e.property) };
};

describe('문의사항 목록 검색 형식', () => {
  it('조건 없이도 받고 쪽은 기본값이다', async () => {
    const { dto, errors } = await check({});
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({ page: 1, pageSize: 20 });
  });

  it.each(['WAITING', 'ANSWERED'])('답변 상태 %s 는 받는다', async (v) => {
    expect((await check({ answerStatus: v })).errors).toEqual([]);
  });

  // 목록 거르기는 답변 대기 · 답변 완료 둘뿐이다. 접수 · 처리중은 각 줄의 status 로 본다.
  it.each(['RECEIVED', 'IN_PROGRESS', 'waiting'])(
    '답변 상태 %s 는 400',
    async (v) => {
      expect((await check({ answerStatus: v })).errors).toEqual([
        'answerStatus',
      ]);
    },
  );

  it('제목 · 보낸 곳은 앞뒤 공백을 지운다', async () => {
    const { dto } = await check({ title: '  kiosk  ', sender: ' 한강 ' });
    expect(dto).toMatchObject({ title: 'kiosk', sender: '한강' });
  });

  it('제목은 200자, 보낸 곳은 100자까지다', async () => {
    expect(
      (await check({ title: 'a'.repeat(200), sender: 'a'.repeat(100) })).errors,
    ).toEqual([]);
    expect(
      (await check({ title: 'a'.repeat(201), sender: 'a'.repeat(101) })).errors,
    ).toEqual(['title', 'sender']);
  });

  // PostgreSQL text 는 NUL 을 받지 않는다 — 그대로 보내면 400 이 아니라 500 이다.
  it('NUL 문자는 400', async () => {
    expect(
      (await check({ title: 'a\u0000b', sender: 'a\u0000b' })).errors,
    ).toEqual(['title', 'sender']);
  });
});
