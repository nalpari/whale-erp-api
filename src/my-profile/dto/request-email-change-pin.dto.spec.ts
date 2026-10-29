import { plainToInstance } from 'class-transformer';
import { isEmail, validate } from 'class-validator';
import { RequestEmailChangePinDto } from './request-email-change-pin.dto';

const SENDABLE_MESSAGE = '메일을 보낼 수 없는 형식의 이메일입니다.';

const constraintsOf = async (newEmail: unknown) => {
  const errors = await validate(
    plainToInstance(RequestEmailChangePinDto, {
      newEmail,
      currentPassword: 'Current1!',
    }),
  );
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('RequestEmailChangePinDto', () => {
  it('보통 주소는 받고 소문자로 바꾼다', async () => {
    const dto = plainToInstance(RequestEmailChangePinDto, {
      newEmail: ' New@Example.com ',
      currentPassword: 'Current1!',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.newEmail).toBe('new@example.com');
  });

  it('따옴표 로컬 파트는 @IsEmail 은 받지만 메일 발송이 막는 주소라 400 — 받으면 핀이 지워지고 500 이 됐다', async () => {
    const quoted = '"a"@example.com';
    expect(isEmail(quoted)).toBe(true);
    expect(await constraintsOf(quoted)).toEqual([SENDABLE_MESSAGE]);
  });

  it.each([
    ['괄호 주석', 'a(b)@example.com'],
    ['역슬래시', 'a\\b@example.com'],
  ])('%s 는 @IsEmail 도 막는다 — 어느 쪽이든 400', async (_, newEmail) => {
    expect(isEmail(newEmail)).toBe(false);
    expect(await constraintsOf(newEmail)).toContain(SENDABLE_MESSAGE);
  });

  it.each([
    ['빠짐', undefined],
    ['빈 문자열', ''],
    ['문자열 아님', 1234],
    ['128자 넘음', 'a'.repeat(129)],
  ])('지금 비밀번호가 %s 이면 400', async (_, currentPassword) => {
    const errors = await validate(
      plainToInstance(RequestEmailChangePinDto, {
        newEmail: 'new@example.com',
        currentPassword,
      }),
    );
    expect(errors.map((e) => e.property)).toEqual(['currentPassword']);
  });

  it('끝이 맞지 않는 아주 긴 입력도 정규식에 닿기 전에 길이로 거절한다 — 제곱으로 일하는 정규식이 이벤트 루프를 멈추지 않게(ReDoS)', async () => {
    // trim · 소문자 뒤에도 남고 기본 JSON 한도(100kb) 안에 드는 약 10만 자
    const long = 'a@' + 'a.'.repeat(50_000) + '@x';
    const started = Date.now();
    const constraints = await constraintsOf(long);
    expect(Date.now() - started).toBeLessThan(200);
    expect(constraints).toContain(SENDABLE_MESSAGE);
  });
});
