import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminLoginIdFindService,
  LOGIN_ID_NOT_FOUND_MESSAGE,
  maskLoginId,
} from './admin-login-id-find.service';
import { AdminLoginIdFindDto } from './dto/admin-login-id-find.dto';

describe('maskLoginId', () => {
  it('앞 2자와 뒤 1자만 보이고 나머지는 길이만큼 가린다', () => {
    expect(maskLoginId('hanwhale1')).toBe('ha******1');
  });

  it('4자(최소 길이)면 가운데 한 자만 가린다', () => {
    expect(maskLoginId('abcd')).toBe('ab*d');
  });

  it('4자보다 짧으면 던진다 — 가릴 글자가 없어 전체가 드러난다(admin_accounts_login_id_format 이 막는 값)', () => {
    expect(() => maskLoginId('abc')).toThrow();
  });
});

describe('AdminLoginIdFindService', () => {
  let service: AdminLoginIdFindService;
  let findFirst: jest.Mock;
  const dto = { name: '홍길동', email: 'a@test.invalid' };

  beforeEach(async () => {
    findFirst = jest.fn().mockResolvedValue({ loginId: 'hanwhale1' });
    const module = await Test.createTestingModule({
      providers: [
        AdminLoginIdFindService,
        { provide: PrismaService, useValue: { adminAccount: { findFirst } } },
      ],
    }).compile();
    service = module.get(AdminLoginIdFindService);
  });

  it('이름 · 이메일이 맞는 사용 중 계정의 아이디를 가려서 준다', async () => {
    await expect(service.find(dto)).resolves.toEqual({
      maskedLoginId: 'ha******1',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        name: '홍길동',
        email: 'a@test.invalid',
        accountStatusCode: 'ACTIVE',
        isDeleted: false,
      },
      select: { loginId: true },
    });
  });

  it('맞는 사용 중 계정이 없으면 같은 문구의 404 다(미사용 · 탈퇴 · 삭제 계정도 조건에서 빠진다)', async () => {
    findFirst.mockResolvedValue(null);
    const err = await service.find(dto).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe(LOGIN_ID_NOT_FOUND_MESSAGE);
  });
});

describe('AdminLoginIdFindDto', () => {
  const parse = (body: object) => plainToInstance(AdminLoginIdFindDto, body);

  it('이름은 앞뒤 공백을 지우고, 이메일은 앞뒤 공백을 지운 뒤 소문자로 바꾼다', async () => {
    const dto = parse({ name: ' 홍길동 ', email: ' A@Test.Invalid ' });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toEqual({ name: '홍길동', email: 'a@test.invalid' });
  });

  it('공백뿐인 이름 · 21자 이름 · 이메일 형식이 아닌 값은 거른다', async () => {
    const errors = await validate(
      parse({ name: '   ', email: 'not-an-email' }),
    );
    expect(errors.map((e) => e.property)).toEqual(['name', 'email']);
    expect(
      await validate(parse({ name: '가'.repeat(21), email: 'a@test.invalid' })),
    ).toHaveLength(1);
  });
});
