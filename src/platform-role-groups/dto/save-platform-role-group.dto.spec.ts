// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreatePlatformRoleGroupDto,
  DeletePlatformRoleGroupDto,
  SaveRoleGroupMenusDto,
  UpdatePlatformRoleGroupDto,
} from './save-platform-role-group.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const check = async <T extends object>(cls: new () => T, plain: object) => {
  const dto = plainToInstance(cls, plain);
  return { dto, errors: (await validate(dto)).map((e) => e.property) };
};
const UPDATED_AT = '2026-10-15T01:00:00.000Z';

describe('플랫폼 권한 입력 형식', () => {
  it('권한명은 앞뒤 공백을 지우고 받는다. 설명이 비면 null', async () => {
    const { dto, errors } = await check(CreatePlatformRoleGroupDto, {
      name: '  고객지원 담당 ',
      description: '   ',
    });
    expect(errors).toEqual([]);
    expect(dto.name).toBe('고객지원 담당');
    expect(dto.description).toBeNull();
  });

  it.each(['', '   ', 'a'.repeat(21), 'a\u0000b', 3])(
    '권한명 #%# 는 거른다 — 빈 값 · 공백 · 21자 · NUL · 문자열 아님',
    async (name) => {
      expect(
        (await check(CreatePlatformRoleGroupDto, { name })).errors,
      ).toEqual(['name']);
    },
  );

  it('권한명 20자 · 설명 100자까지 받는다', async () => {
    expect(
      (
        await check(CreatePlatformRoleGroupDto, {
          name: '가'.repeat(20),
          description: '나'.repeat(100),
        })
      ).errors,
    ).toEqual([]);
  });

  it('설명 101자 · NUL 은 거른다', async () => {
    for (const description of ['나'.repeat(101), 'x\u0000'])
      expect(
        (await check(CreatePlatformRoleGroupDto, { name: 'a', description }))
          .errors,
      ).toEqual(['description']);
  });

  it('수정은 시간대가 붙은 updatedAt 을 받아야 한다', async () => {
    expect(
      (
        await check(UpdatePlatformRoleGroupDto, {
          name: 'a',
          updatedAt: UPDATED_AT,
        })
      ).errors,
    ).toEqual([]);
    expect(
      (
        await check(UpdatePlatformRoleGroupDto, {
          name: 'a',
          updatedAt: '2026-10-15T01:00:00',
        })
      ).errors,
    ).toEqual(['updatedAt']);
  });

  it('메뉴 저장은 메뉴별 네 칸을 받는다', async () => {
    const ok = {
      menus: [
        { menuId: 3, read: true, create: false, update: false, delete: false },
      ],
      updatedAt: UPDATED_AT,
    };
    expect((await check(SaveRoleGroupMenusDto, ok)).errors).toEqual([]);
    // 위반을 하나씩 넣어, 어느 검사가 걸렸는지 가른다.
    const row = ok.menus[0];
    for (const bad of [
      { ...row, menuId: 0 }, // id 하한
      { ...row, menuId: 2147483648 }, // int4 상한
      { ...row, read: 'y' }, // 참 · 거짓이 아님
    ])
      expect(
        (await check(SaveRoleGroupMenusDto, { ...ok, menus: [bad] })).errors,
      ).toEqual(['menus']);
    expect(
      (await check(SaveRoleGroupMenusDto, { updatedAt: UPDATED_AT })).errors,
    ).toEqual(['menus']);
  });

  it('삭제는 대체 권한을 고르지 않아도 된다', async () => {
    expect(
      (await check(DeletePlatformRoleGroupDto, { updatedAt: UPDATED_AT }))
        .errors,
    ).toEqual([]);
    expect(
      (
        await check(DeletePlatformRoleGroupDto, {
          updatedAt: UPDATED_AT,
          replacementRoleGroupId: 2_147_483_648,
        })
      ).errors,
    ).toEqual(['replacementRoleGroupId']);
  });
});
