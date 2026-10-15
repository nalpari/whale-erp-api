import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SignupBusinessVerificationDto } from './signup-business-verification.dto';

const check = (bizOpenDate: string) => {
  const dto = plainToInstance(SignupBusinessVerificationDto, {
    bizRegistrationNumber: '1234567890',
    bizCeoName: '남도현',
    bizOpenDate,
  });
  return validateSync(dto).find((e) => e.property === 'bizOpenDate');
};

describe('SignupBusinessVerificationDto 개업일자', () => {
  it('실제로 있는 YYYY-MM-DD 만 받는다', () => {
    expect(check('2021-03-15')).toBeUndefined();
    expect(check('2024-02-29')).toBeUndefined();
  });

  it.each(['abc', '2021-3-15', '2021-02-30', '2023-02-29', ''])(
    '모양이 틀리거나 없는 날짜는 문구 하나로 거절한다: %p',
    (value) => {
      const failed = check(value);
      expect(failed).toBeDefined();
      expect(Object.values(failed?.constraints ?? {})).toEqual([
        '개업일자는 YYYY-MM-DD 로 입력해 주세요.',
      ]);
    },
  );
});
