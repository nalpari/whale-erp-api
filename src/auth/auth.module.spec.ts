import { dummyPasswordHash } from './password';
import { AuthModule } from './auth.module';

jest.mock('./password', () => ({
  ...jest.requireActual<typeof import('./password')>('./password'),
  dummyPasswordHash: jest.fn(),
}));

const dummyPasswordHashMock = dummyPasswordHash as jest.Mock;

describe('AuthModule', () => {
  beforeEach(() => dummyPasswordHashMock.mockReset());

  it('기동할 때 더미 해시를 미리 계산한다 — 첫 "없는 계정" 요청만 scrypt 를 두 번 돌아 느려지지 않게', async () => {
    dummyPasswordHashMock.mockResolvedValue('scrypt$dummy');

    await new AuthModule().onModuleInit();

    expect(dummyPasswordHashMock).toHaveBeenCalledTimes(1);
  });

  it('계산에 실패하면 기동을 멈춘다 — 요청 중에 실패해 없는 계정만 500 이 되는 것보다 낫다', async () => {
    dummyPasswordHashMock.mockRejectedValue(new Error('scrypt failed'));

    await expect(new AuthModule().onModuleInit()).rejects.toThrow(
      'scrypt failed',
    );
  });
});
