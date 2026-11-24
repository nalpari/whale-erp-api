import { PATH_METADATA } from '@nestjs/common/constants';
import {
  THROTTLER_LIMIT,
  THROTTLER_TRACKER,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
import { AUTH_THROTTLERS, signedInUserTracker } from '../auth/throttle';
import { MyWithdrawalController } from './my-withdrawal.controller';
import type { MyWithdrawalService } from './my-withdrawal.service';

const me = { type: 'account', id: 12, email: 'a@b.c', sid: 31 } as never;

describe('MyWithdrawalController', () => {
  it('직원 앱 계정 토큰만, 내 정보 경로 아래다', () => {
    expect(Reflect.getMetadata(USER_TYPES, MyWithdrawalController)).toEqual([
      'account',
    ]);
    expect(
      Reflect.getMetadata(IS_PUBLIC, MyWithdrawalController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, MyWithdrawalController)).toBe(
      'me/profile',
    );
  });

  it('조건 조회 · 탈퇴 모두 토큰의 계정으로만 부른다', async () => {
    const getEligibility = jest.fn().mockResolvedValue({ canWithdraw: true });
    const withdraw = jest.fn().mockResolvedValue(undefined);
    const controller = new MyWithdrawalController({
      getEligibility,
      withdraw,
    } as unknown as MyWithdrawalService);

    await controller.getEligibility(me);
    await controller.withdraw(me, { currentPassword: 'OldPass123!' });

    expect(getEligibility).toHaveBeenCalledWith(12);
    expect(withdraw).toHaveBeenCalledWith(12, 'OldPass123!');
  });

  it('탈퇴는 로그인한 계정마다 10분에 10번 — 지금 비밀번호 대입을 늦춘다', () => {
    const handler = Object.getOwnPropertyDescriptor(
      MyWithdrawalController.prototype,
      'withdraw',
    )?.value as object;
    const meta = (key: string) =>
      Reflect.getMetadata(`${key}account`, handler) as unknown;
    expect(
      Reflect.getMetadata('__guards__', handler) as unknown[],
    ).toHaveLength(1);
    expect(meta(THROTTLER_LIMIT)).toBe(10);
    expect(meta(THROTTLER_TTL)).toBe(600_000);
    expect(meta(THROTTLER_TRACKER)).toBe(signedInUserTracker);
    expect(AUTH_THROTTLERS.map((t) => t.name)).toContain('account');
  });

  it('GET withdrawal-eligibility · POST withdrawal 경로', () => {
    const path = (name: string) =>
      Reflect.getMetadata(
        PATH_METADATA,
        Object.getOwnPropertyDescriptor(MyWithdrawalController.prototype, name)
          ?.value as object,
      ) as string;
    expect(path('getEligibility')).toBe('withdrawal-eligibility');
    expect(path('withdraw')).toBe('withdrawal');
  });
});
