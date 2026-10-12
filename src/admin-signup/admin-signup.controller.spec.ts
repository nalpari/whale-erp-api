import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AdminSignupController } from './admin-signup.controller';
import { AdminSignupService } from './admin-signup.service';
import type { SignupDto } from './dto/signup.dto';

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
