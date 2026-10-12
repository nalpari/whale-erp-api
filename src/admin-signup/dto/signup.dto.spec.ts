import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SignupDto } from './signup.dto';

const body = (overrides: Record<string, unknown> = {}) => ({
  loginId: 'hangang01',
  password: 'whale-2026!',
  name: '정하윤',
  phone: '01048217730',
  email: 'hayoon@hangang.co.kr',
  tradeName: '㈜한강상회',
  agreeTermsOfUse: true,
  agreePrivacy: true,
  ...overrides,
});

const check = (overrides: Record<string, unknown> = {}) => {
  const dto = plainToInstance(SignupDto, body(overrides));
  return { dto, failed: validateSync(dto).map((e) => e.property) };
};

describe('SignupDto', () => {
  it('화면이 보내는 값을 받는다', () => expect(check().failed).toEqual([]));

  it('아이디와 이메일은 앞뒤 공백을 떼고 소문자로 바꾼다', () => {
    const { dto, failed } = check({
      loginId: ' HanGang01 ',
      email: ' HaYoon@Hangang.co.kr ',
    });
    expect(failed).toEqual([]);
    expect(dto.loginId).toBe('hangang01');
    expect(dto.email).toBe('hayoon@hangang.co.kr');
  });

  it('이름과 상호명은 앞뒤 공백을 뗀다', () => {
    const { dto } = check({ name: ' 정하윤 ', tradeName: ' ㈜한강상회 ' });
    expect(dto.name).toBe('정하윤');
    expect(dto.tradeName).toBe('㈜한강상회');
  });

  it.each([
    ['loginId', 'abc'],
    ['loginId', 'a'.repeat(21)],
    ['loginId', '12345678'],
    ['loginId', 'hangang_01'],
    ['name', '정'],
    ['name', '정 하윤'],
    ['name', '정하윤1'],
    ['phone', '010-4821-7730'],
    ['phone', '010482177'],
    ['phone', '010482177301'],
    ['email', 'hayoon'],
    ['tradeName', ''],
    ['tradeName', '   '],
    ['tradeName', '가'.repeat(51)],
    ['agreeTermsOfUse', 'true'],
    ['password', ''],
  ])('%s 가 %p 이면 거부한다', (property, value) =>
    expect(check({ [property]: value }).failed).toEqual([property]),
  );

  it('상호명은 50자까지 받는다', () =>
    expect(check({ tradeName: '가'.repeat(50) }).failed).toEqual([]));
});
