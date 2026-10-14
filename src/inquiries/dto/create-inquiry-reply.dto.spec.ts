import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateInquiryReplyDto } from './create-inquiry-reply.dto';
import { SaveLeadReplyDto } from '../../leads/dto/save-lead-reply.dto';

const updatedAt = '2026-10-14T01:02:03.456Z';

// 빈 답변이 통과하면 문의자에게 「답변이 등록되었습니다」가 나가고, 첫 답변 알림은 다시 보내지 않아 되돌릴 수 없다.
describe.each([
  ['CreateInquiryReplyDto', CreateInquiryReplyDto, 'body'],
  ['SaveLeadReplyDto', SaveLeadReplyDto, 'reply'],
] as const)('%s', (_, Dto, field) => {
  const errorsOf = async (body: object) =>
    (await validate(plainToInstance(Dto, body))).map((e) => e.property);

  it('답변과 시간대가 붙은 updatedAt 이면 받는다', async () => {
    expect(await errorsOf({ [field]: '답변', updatedAt })).toEqual([]);
  });

  it.each([
    ['공백만', ' \n\t '],
    ['NUL 문자', '답\u0000변'],
    ['20,001자', 'a'.repeat(20_001)],
    ['문자열이 아님', 123],
    ['빠짐', undefined],
  ])('답변이 %s 이면 400', async (_label, value) => {
    expect(await errorsOf({ [field]: value, updatedAt })).toEqual([field]);
  });

  it.each([
    ['시간대가 없음', '2026-10-14T01:02:03.456'],
    ['빠짐', undefined],
  ])('updatedAt 이 %s 이면 400', async (_label, value) => {
    expect(await errorsOf({ [field]: '답변', updatedAt: value })).toEqual([
      'updatedAt',
    ]);
  });
});
