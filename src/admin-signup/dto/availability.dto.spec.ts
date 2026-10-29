import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EmailAvailabilityDto } from './email-availability.dto';
import { LoginIdAvailabilityDto } from './login-id-availability.dto';
import { SignupDto } from './signup.dto';

// 중복 확인은 가입이 받을 값을 미리 묻는 것이다. 정규화나 형식이 가입과 다르면 「사용 가능」이라던
// 아이디가 가입에서 400 이 되거나, 대문자 이메일이 「사용 가능」인데 가입은 409 가 된다.
const signupField = (field: 'loginId' | 'email', value: string) => {
  const dto = plainToInstance(SignupDto, { [field]: value });
  const failed = validateSync(dto).some((e) => e.property === field);
  return { value: dto[field], failed };
};

describe('LoginIdAvailabilityDto', () => {
  const check = (loginId: string) => {
    const dto = plainToInstance(LoginIdAvailabilityDto, { loginId });
    return { value: dto.loginId, failed: validateSync(dto).length > 0 };
  };

  it.each([' HanGang01 ', 'hangang01', 'abcd', '1234', 'ab1', 'han-gang01'])(
    '가입과 같게 정규화하고 같게 거른다: %p',
    (loginId) =>
      expect(check(loginId)).toEqual(signupField('loginId', loginId)),
  );

  it('대문자로 와도 소문자로 본다', () =>
    expect(check(' HanGang01 ')).toEqual({
      value: 'hangang01',
      failed: false,
    }));

  // 영문만도 받으므로 「영문·숫자 조합」만 적으면 숫자를 꼭 섞어야 하는 것처럼 읽힌다.
  it('형식이 틀리면 가입과 같은 문구로 알린다', () => {
    const constraintsOf = (dto: object) =>
      validateSync(dto).find((e) => e.property === 'loginId')?.constraints;
    const expected = {
      matches: '영문 또는 영문·숫자 조합으로 4~20자로 입력해 주세요.',
    };
    expect(
      constraintsOf(plainToInstance(LoginIdAvailabilityDto, { loginId: 'ab' })),
    ).toEqual(expected);
    expect(
      constraintsOf(plainToInstance(SignupDto, { loginId: 'ab' })),
    ).toEqual(expected);
  });
});

describe('EmailAvailabilityDto', () => {
  const check = (email: string) => {
    const dto = plainToInstance(EmailAvailabilityDto, { email });
    return { value: dto.email, failed: validateSync(dto).length > 0 };
  };

  it.each([' HaYoon@Hangang.co.kr ', 'hayoon@hangang.co.kr', 'not-an-email'])(
    '가입과 같게 정규화하고 같게 거른다: %p',
    (email) => expect(check(email)).toEqual(signupField('email', email)),
  );

  it('대문자로 와도 소문자로 본다 — 가입은 소문자로 저장한다', () =>
    expect(check(' HaYoon@Hangang.co.kr ')).toEqual({
      value: 'hayoon@hangang.co.kr',
      failed: false,
    }));
});
