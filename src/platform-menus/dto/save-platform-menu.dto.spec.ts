// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreatePlatformMenuDto,
  MovePlatformMenuDto,
  UpdatePlatformMenuDto,
} from './save-platform-menu.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const check = async <T extends object>(cls: new () => T, plain: object) => {
  const dto = plainToInstance(cls, plain);
  return { dto, errors: (await validate(dto)).map((e) => e.property) };
};
const UPDATED_AT = '2026-10-16T01:00:00.000Z';
const base = { serviceCode: 'PLATFORM', name: '메뉴' };

describe('플랫폼 메뉴 입력 형식', () => {
  it('등록 — 메뉴명은 앞뒤 공백을 지우고, URL 이 비면 null, 상위 · 상태는 생략할 수 있다', async () => {
    const { dto, errors } = await check(CreatePlatformMenuDto, {
      ...base,
      name: '  플랫폼 메뉴 관리 ',
      url: '   ',
    });
    expect(errors).toEqual([]);
    expect(dto.name).toBe('플랫폼 메뉴 관리');
    expect(dto.url).toBeNull();
    expect(dto.parentMenuId).toBeUndefined();
    expect(dto.status).toBeUndefined();
  });

  it('최상위는 parentMenuId 를 null 로 보낼 수도 있다', async () => {
    expect(
      (await check(CreatePlatformMenuDto, { ...base, parentMenuId: null }))
        .errors,
    ).toEqual([]);
  });

  it.each(['', '   ', '가'.repeat(21), 'a\u0000b', 3])(
    '메뉴명 #%# 는 거른다 — 빈 값 · 공백 · 21자 · NUL · 문자열 아님',
    async (name) => {
      expect(
        (await check(CreatePlatformMenuDto, { ...base, name })).errors,
      ).toEqual(['name']);
    },
  );

  it('메뉴명 20자까지 받는다', async () => {
    expect(
      (await check(CreatePlatformMenuDto, { ...base, name: '가'.repeat(20) }))
        .errors,
    ).toEqual([]);
  });

  it.each(['/staff-content', '/staff-members', '/a1-b-2'])(
    'URL %s 는 받는다',
    async (url) => {
      expect(
        (await check(CreatePlatformMenuDto, { ...base, url })).errors,
      ).toEqual([]);
    },
  );

  it.each([
    'platform', // / 로 시작하지 않음
    '/', // 구간이 없음
    '/stores/', // 끝 /
    '/a b', // 공백
    '/Stores', // 대문자
    '/a?x=1', // 쿼리
    '//a', // 빈 구간
    '/staff/content', // 2뎁스 — 1뎁스만 받는다
    '/platform/system/menus', // 시드 모양의 여러 구간도 새로는 받지 않는다
    `/${'a'.repeat(200)}`, // 200자 초과
  ])('URL %s 는 거른다', async (url) => {
    expect(
      (await check(CreatePlatformMenuDto, { ...base, url })).errors,
    ).toEqual(['url']);
  });

  it('서비스 코드 · 상위 id · 상태 형식', async () => {
    for (const [bad, field] of [
      [{ serviceCode: 'platform' }, 'serviceCode'],
      [{ serviceCode: '' }, 'serviceCode'],
      [{ parentMenuId: 0 }, 'parentMenuId'],
      [{ parentMenuId: 2147483648 }, 'parentMenuId'],
      [{ status: 'DELETED' }, 'status'],
    ] as const)
      expect(
        (await check(CreatePlatformMenuDto, { ...base, ...bad })).errors,
      ).toEqual([field]);
  });

  it('수정은 메뉴명 · 상태 · 시간대가 붙은 updatedAt 이 있어야 한다. URL 을 빼면 비운다(null)', async () => {
    const ok = { name: '메뉴', status: 'INACTIVE', updatedAt: UPDATED_AT };
    const { dto, errors } = await check(UpdatePlatformMenuDto, ok);
    expect(errors).toEqual([]);
    expect(dto.url).toBeUndefined();
    expect(
      (await check(UpdatePlatformMenuDto, { ...ok, status: undefined })).errors,
    ).toEqual(['status']);
    expect(
      (
        await check(UpdatePlatformMenuDto, {
          ...ok,
          updatedAt: '2026-10-16T01:00:00',
        })
      ).errors,
    ).toEqual(['updatedAt']);
  });

  it('옮기기는 상위(null 이면 최상위)와 0부터의 자리를 받는다', async () => {
    expect(
      (await check(MovePlatformMenuDto, { parentMenuId: null, index: 0 }))
        .errors,
    ).toEqual([]);
    expect(
      (await check(MovePlatformMenuDto, { parentMenuId: 3, index: 2 })).errors,
    ).toEqual([]);
    expect((await check(MovePlatformMenuDto, { index: 0 })).errors).toEqual([
      'parentMenuId',
    ]);
    expect(
      (await check(MovePlatformMenuDto, { parentMenuId: null, index: -1 }))
        .errors,
    ).toEqual(['index']);
  });
});
