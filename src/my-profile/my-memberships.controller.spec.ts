import { NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  THROTTLER_LIMIT,
  THROTTLER_TRACKER,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
import { AUTH_THROTTLERS, signedInUserTracker } from '../auth/throttle';
import { MyMembershipsController } from './my-memberships.controller';
import type { MyMembershipsService } from './my-memberships.service';
import { StaffMemberIdPipe } from './staff-member-id.pipe';

const user = { type: 'account', id: 12, email: 'a@b.c', sid: 1 } as never;

describe('MyMembershipsController', () => {
  it('직원 앱 계정 토큰만, 경로는 me/memberships', () => {
    expect(Reflect.getMetadata(USER_TYPES, MyMembershipsController)).toEqual([
      'account',
    ]);
    expect(
      Reflect.getMetadata(IS_PUBLIC, MyMembershipsController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, MyMembershipsController)).toBe(
      'me/memberships',
    );
  });

  it('목록 · 신고 정보 모두 토큰의 계정으로 읽는다', async () => {
    const list = jest.fn().mockResolvedValue({ items: [], total: 0 });
    const taxProfile = jest.fn().mockResolvedValue({});
    const controller = new MyMembershipsController({
      list,
      taxProfile,
    } as unknown as MyMembershipsService);
    await controller.list(user, {});
    expect(list).toHaveBeenCalledWith(12, false);
    await controller.list(user, { includeRetired: true });
    expect(list).toHaveBeenLastCalledWith(12, true);
    await controller.taxProfile(31, user);
    expect(taxProfile).toHaveBeenCalledWith(12, 31);
  });

  it('신고 정보 저장은 로그인한 계정마다 10분에 10번 — 지금 비밀번호 대입을 늦춘다(이메일 변경 핀 요청과 같은 값, 2026-10-23)', () => {
    const handler = Object.getOwnPropertyDescriptor(
      MyMembershipsController.prototype,
      'saveTaxProfile',
    )?.value as object;
    const meta = (key: string) =>
      Reflect.getMetadata(`${key}account`, handler) as unknown;
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([
      ThrottlerGuard,
    ]);
    expect(meta(THROTTLER_LIMIT)).toBe(10);
    expect(meta(THROTTLER_TTL)).toBe(600_000);
    expect(meta(THROTTLER_TRACKER)).toBe(signedInUserTracker);
    expect(AUTH_THROTTLERS.map((t) => t.name)).toContain('account');
    // 조회에는 걸지 않는다
    const read = Object.getOwnPropertyDescriptor(
      MyMembershipsController.prototype,
      'taxProfile',
    )?.value as object;
    expect(Reflect.getMetadata('__guards__', read)).toBeUndefined();
  });

  it('신고 정보 저장은 토큰의 계정 · 경로의 소속 · 본문을 그대로 넘긴다', async () => {
    const saveTaxProfile = jest.fn().mockResolvedValue({});
    const controller = new MyMembershipsController({
      saveTaxProfile,
    } as unknown as MyMembershipsService);
    const dto = { rrn: '9803041234567', currentPassword: 'pw' };
    await controller.saveTaxProfile(31, user, dto);
    expect(saveTaxProfile).toHaveBeenCalledWith(12, 31, dto);
  });
});

describe('StaffMemberIdPipe', () => {
  const pipe = new StaffMemberIdPipe();

  it('integer 범위 안의 숫자만', () => {
    expect(pipe.transform('31')).toBe(31);
  });

  it('범위 밖 · 숫자가 아니면 DB 에 묻기 전에 404', () => {
    for (const raw of ['0', '2147483648', 'abc', '-1'])
      expect(() => pipe.transform(raw)).toThrow(NotFoundException);
  });
});
