import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RequestEmailChangePinDto } from './request-email-change-pin.dto';

const errorsOf = async (newEmail: unknown) =>
  validate(plainToInstance(RequestEmailChangePinDto, { newEmail }));

describe('RequestEmailChangePinDto', () => {
  it('보통 주소는 받고 소문자로 바꾼다', async () => {
    const dto = plainToInstance(RequestEmailChangePinDto, {
      newEmail: ' New@Example.com ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.newEmail).toBe('new@example.com');
  });

  it.each([
    ['따옴표 로컬 파트', '"a"@example.com'],
    ['괄호 주석', 'a(b)@example.com'],
    ['역슬래시', 'a\\b@example.com'],
  ])(
    '%s 는 400 — @IsEmail 은 받지만 메일 발송이 막는 주소라, 받으면 핀이 지워지고 500 이 된다',
    async (_, newEmail) => {
      const errors = await errorsOf(newEmail);
      expect(errors).toHaveLength(1);
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        '메일을 보낼 수 없는 형식의 이메일입니다',
      );
    },
  );
});
