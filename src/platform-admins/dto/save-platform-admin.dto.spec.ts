// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListPlatformAdminsDto,
  PlatformRoleGroupsQueryDto,
} from './list-platform-admins.dto';
import {
  CreatePlatformAdminDto,
  UpdatePlatformAdminDto,
} from './save-platform-admin.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const check = async <T extends object>(cls: new () => T, plain: object) => {
  const dto = plainToInstance(cls, plain);
  return { dto, errors: (await validate(dto)).map((e) => e.property) };
};

describe('플랫폼 관리자 입력 형식', () => {
  it.each([
    [{}, []],
    [{ purpose: 'filter' }, []],
    [{ purpose: 'foo' }, ['purpose']],
    [{ purpose: '' }, ['purpose']],
  ])('권한 목록 purpose %p → 오류 %p', async (plain, errors) => {
    expect((await check(PlatformRoleGroupsQueryDto, plain)).errors).toEqual(
      errors,
    );
  });

  const create = {
    loginId: 'seojun01',
    name: '이서준',
    phone: '01012345678',
    email: 'seojun@whale.test',
    roleGroupId: 20,
  };

  it('기본 입력은 받는다', async () => {
    expect((await check(CreatePlatformAdminDto, create)).errors).toEqual([]);
  });

  it.each(['abcd', 'A1b2', 'a'.repeat(20)])(
    '아이디 %p 는 받는다',
    async (loginId) => {
      expect(
        (await check(CreatePlatformAdminDto, { ...create, loginId })).errors,
      ).toEqual([]);
    },
  );

  it.each(['abc', 'a'.repeat(21), '12345', 'seo_jun', 'seo jun', '서준01'])(
    '아이디 %p 는 거른다 — 영문이 하나는 있어야 하고 밑줄 · 공백 · 한글은 안 된다',
    async (loginId) => {
      expect(
        (await check(CreatePlatformAdminDto, { ...create, loginId })).errors,
      ).toEqual(['loginId']);
    },
  );

  // 아이디 중복 확인(LoginIdAvailabilityQueryDto)과 같은 값으로 봐야 「사용 가능」 뒤에 400 이 나지 않는다.
  it('아이디는 앞뒤 공백을 지우고 받는다', async () => {
    const { dto, errors } = await check(CreatePlatformAdminDto, {
      ...create,
      loginId: ' seojun01 ',
    });
    expect(errors).toEqual([]);
    expect(dto.loginId).toBe('seojun01');
  });

  it.each(['서', '이서준1', 'a'.repeat(21), '   '])(
    '이름 %p 는 거른다',
    async (name) => {
      expect(
        (await check(CreatePlatformAdminDto, { ...create, name })).errors,
      ).toEqual(['name']);
    },
  );

  it.each(['021234567', '050720331334'])(
    '연락처 %p 는 받는다 — 9자리 지역번호 · 12자리 050X 평생번호',
    async (phone) => {
      expect(
        (await check(CreatePlatformAdminDto, { ...create, phone })).errors,
      ).toEqual([]);
    },
  );

  it.each(['010-1234-5678', '02123456', '0507203313345'])(
    '연락처 %p 는 거른다 — 하이픈 없이 9~12자리',
    async (phone) => {
      expect(
        (await check(CreatePlatformAdminDto, { ...create, phone })).errors,
      ).toEqual(['phone']);
    },
  );

  it('이메일은 앞뒤 공백을 지우고 소문자로 받는다', async () => {
    const { dto, errors } = await check(CreatePlatformAdminDto, {
      ...create,
      email: ' SeoJun@Whale.Test ',
    });
    expect(errors).toEqual([]);
    expect(dto.email).toBe('seojun@whale.test');
  });

  it('선택 칸을 비워 보내면 NULL 로 받는다', async () => {
    const { dto, errors } = await check(CreatePlatformAdminDto, {
      ...create,
      department: '  ',
      jobTitle: '',
      zipCode: null,
    });
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({
      department: null,
      jobTitle: null,
      zipCode: null,
    });
  });

  it('권한 그룹 id 는 integer 범위 안이어야 한다', async () => {
    expect(
      (
        await check(CreatePlatformAdminDto, {
          ...create,
          roleGroupId: 2_147_483_648,
        })
      ).errors,
    ).toEqual(['roleGroupId']);
  });

  it('수정은 사용 · 미사용과 최종수정일시를 받는다', async () => {
    const update = {
      ...create,
      accountStatus: 'INACTIVE',
      updatedAt: '2026-10-13T00:00:00.000Z',
    };
    expect((await check(UpdatePlatformAdminDto, update)).errors).toEqual([]);
    expect(
      (
        await check(UpdatePlatformAdminDto, {
          ...update,
          accountStatus: 'WITHDRAWN',
        })
      ).errors,
    ).toEqual(['accountStatus']);
    expect(
      (
        await check(UpdatePlatformAdminDto, {
          ...update,
          updatedAt: 'yesterday',
        })
      ).errors,
    ).toEqual(['updatedAt']);
  });

  it('목록 상태는 쉼표로 여러 개를 받는다', async () => {
    const { dto, errors } = await check(ListPlatformAdminsDto, {
      statuses: 'ACTIVE,INACTIVE',
      roleGroupId: '20',
    });
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({
      statuses: ['ACTIVE', 'INACTIVE'],
      roleGroupId: 20,
      page: 1,
      pageSize: 20,
    });
    expect(
      (await check(ListPlatformAdminsDto, { statuses: 'ACTIVE,WITHDRAWN' }))
        .errors,
    ).toEqual(['statuses']);
  });
});
