import { NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
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
    await controller.list(user);
    expect(list).toHaveBeenCalledWith(12);
    await controller.taxProfile(31, user);
    expect(taxProfile).toHaveBeenCalledWith(12, 31);
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
