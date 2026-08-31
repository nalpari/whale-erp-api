import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_THROTTLERS } from './throttle';

describe('AuthController', () => {
  let controller: AuthController;
  let auth: { login: jest.Mock; refresh: jest.Mock; logout: jest.Mock };

  beforeEach(async () => {
    auth = {
      login: jest.fn().mockResolvedValue('tokens'),
      refresh: jest.fn().mockResolvedValue('tokens'),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      // 컨트롤러에 ThrottlerGuard 가 붙어 있어 그 의존성이 필요하다.
      // 운영과 같은 설정을 넣어, 한도 값이 바뀌면 여기서도 같이 흔들리게 둔다.
      imports: [ThrottlerModule.forRoot(AUTH_THROTTLERS)],
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }],
    }).compile();
    controller = module.get(AuthController);
  });

  const dto = { email: 'a@whale.test', password: 'pw12345!' };

  it('직원 로그인은 staff 로 위임한다', async () => {
    await controller.staffLogin(dto);
    expect(auth.login).toHaveBeenCalledWith('staff', dto);
  });

  it('고객 로그인은 customer 로 위임한다', async () => {
    await controller.customerLogin(dto);
    expect(auth.login).toHaveBeenCalledWith('customer', dto);
  });

  it('갱신은 본문의 리프레시 토큰만 넘긴다', async () => {
    await controller.refresh({ refreshToken: '토큰' });
    expect(auth.refresh).toHaveBeenCalledWith('토큰');
  });

  it('로그아웃은 현재 사용자를 넘긴다', async () => {
    const user = { id: 7, type: 'staff' as const, email: 'a@whale.test' };
    await controller.logout(user);
    expect(auth.logout).toHaveBeenCalledWith(user);
  });
});
