import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IS_PUBLIC } from '../auth/auth.decorators';
import { AdminSignupController } from './admin-signup.controller';
import { AdminSignupService } from './admin-signup.service';
import type { SignupDto } from './dto/signup.dto';

// 로그인 전 경로라 공개이고, 이 경로를 지키는 것은 요청 제한뿐이다. 아래 테스트와 e2e 는 가드를 끄고
// 돌므로, 데코레이터가 빠져도 알 수 없다 — 메타데이터로 고정한다. 키는 Nest 내부 상수다.
describe('AdminSignupController 경로 보호', () => {
  const meta = (key: string): unknown =>
    Reflect.getMetadata(key, AdminSignupController);

  it('로그인 없이 받는다', () => expect(meta(IS_PUBLIC)).toBe(true));

  it('요청 제한(IP · 계정 두 축)을 건다 — 가입은 scrypt 를 쓰고 중복 확인은 가입 여부를 알려 준다', () =>
    expect(meta('__guards__')).toContain(ThrottlerGuard));
});

describe('AdminSignupController', () => {
  let controller: AdminSignupController;
  let service: {
    signup: jest.Mock;
    isLoginIdAvailable: jest.Mock;
    isEmailAvailable: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      signup: jest.fn().mockResolvedValue({ signupToken: 't' }),
      isLoginIdAvailable: jest.fn().mockResolvedValue(false),
      isEmailAvailable: jest.fn().mockResolvedValue(true),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminSignupController],
      providers: [{ provide: AdminSignupService, useValue: service }],
    })
      // 요청 제한은 AuthModule 이 설정한다. 여기서는 위임만 보고, 제한은 e2e 가 본다.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(AdminSignupController);
  });

  it('가입은 요청 IP 를 약관 동의 기록에 넘긴다', async () => {
    const dto = { loginId: 'hangang01' } as SignupDto;
    await expect(controller.signup(dto, '203.0.113.7')).resolves.toEqual({
      signupToken: 't',
    });
    expect(service.signup).toHaveBeenCalledWith(dto, '203.0.113.7');
  });

  it('아이디 중복 확인은 { available } 로 답한다', async () => {
    await expect(
      controller.loginIdAvailability({ loginId: 'hangang01' }),
    ).resolves.toEqual({ available: false });
    expect(service.isLoginIdAvailable).toHaveBeenCalledWith('hangang01');
  });

  it('이메일 중복 확인은 { available } 로 답한다', async () => {
    await expect(
      controller.emailAvailability({ email: 'hayoon@hangang.co.kr' }),
    ).resolves.toEqual({ available: true });
    expect(service.isEmailAvailable).toHaveBeenCalledWith(
      'hayoon@hangang.co.kr',
    );
  });
});
