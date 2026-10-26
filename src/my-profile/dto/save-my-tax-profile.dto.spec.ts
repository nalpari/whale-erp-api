import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SaveMyTaxProfileDto } from './save-my-tax-profile.dto';

const errorsOf = async (body: object) =>
  (await validate(plainToInstance(SaveMyTaxProfileDto, body))).map(
    (e) => e.property,
  );

describe('SaveMyTaxProfileDto', () => {
  it('보내지 않은 항목은 건너뛰고 하이픈 · 공백은 지운다', async () => {
    const dto = plainToInstance(SaveMyTaxProfileDto, {
      rrn: '980304-1234567',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.rrn).toBe('9803041234567');
  });

  it.each([
    ['rrn', { rrn: null }],
    ['bankCode', { bankCode: null, payrollAccountNumber: '110123456789' }],
    ['payrollAccountNumber', { bankCode: 'B004', payrollAccountNumber: null }],
  ])(
    '%s 가 null 이면 400 — 보낸 값으로 보고 쓰다 500 이 나지 않게(api #86 리뷰)',
    async (property, body) => {
      expect(await errorsOf(body)).toEqual([property]);
    },
  );

  it('지금 비밀번호 — 보내지 않으면 건너뛰고(처음 작성), 보내면 문자열 1~128자(이메일 변경 핀 요청과 같다)', async () => {
    expect(await errorsOf({ rrn: '9803041234567' })).toEqual([]);
    expect(
      await errorsOf({
        rrn: '9803041234567',
        currentPassword: 'x'.repeat(128),
      }),
    ).toEqual([]);
    for (const currentPassword of ['', 'x'.repeat(129), null, 1234])
      expect(await errorsOf({ rrn: '9803041234567', currentPassword })).toEqual(
        ['currentPassword'],
      );
  });
});
