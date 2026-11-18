import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../prisma/prisma.service';
import { LIVE_STORE_STATUSES } from '../stores/store-format';
import { BusinessVerificationService } from './business-verification.service';
import {
  NtsUnavailableError,
  type BizIdentity,
  type NtsBusinessClient,
} from '../nts/nts-business.client';

const identity: BizIdentity = {
  bizRegistrationNumber: '1234567890',
  bizCeoName: '정하윤',
  bizOpenDate: '2020-03-02',
};

describe('BusinessVerificationService', () => {
  let prisma: {
    storeBusinessProfile: { findFirst: jest.Mock };
  };
  let client: { verify: jest.Mock };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let error: jest.SpyInstance;
  let service: BusinessVerificationService;

  beforeEach(() => {
    prisma = {
      storeBusinessProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    client = { verify: jest.fn().mockResolvedValue('MATCH') };
    jwt = {
      signAsync: jest.fn().mockResolvedValue('signed-token'),
      verifyAsync: jest.fn(),
    };
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    service = new BusinessVerificationService(
      prisma as unknown as PrismaService,
      client as unknown as NtsBusinessClient,
      jwt as unknown as JwtService,
    );
  });

  afterEach(() => error.mockRestore());

  it('다른 BP(의 본사 점포)가 쓰는 번호면 국세청을 부르지 않고 409', async () => {
    prisma.storeBusinessProfile.findFirst.mockResolvedValue({ storeId: 3 });
    await expect(service.verify(identity)).rejects.toThrow(
      new ConflictException('이미 등록된 사업자등록번호입니다.'),
    );
    expect(client.verify).not.toHaveBeenCalled();
  });

  // BP 번호는 본사 점포 사업자정보로 옮겨 갔다(2026-11-17) — BP · 점포 두 검사가 점포 하나로 합쳐진다. 탈퇴한 BP 의
  // 본사는 폐점, 삭제한 BP 의 본사는 삭제라 아래 조건에서 함께 빠진다(예전 bp_codes 부분 고유 인덱스와 같은 결과).
  it('점포 사업자정보(본사 포함)가 쓰는 번호면 409 — 폐점·삭제한 점포는 뺀다(점포 등록과 같은 규칙)', async () => {
    prisma.storeBusinessProfile.findFirst.mockResolvedValue({ storeId: 9 });
    await expect(service.verify(identity)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.storeBusinessProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bizRegistrationNumber: '1234567890',
          store: {
            isDeleted: false,
            storeStatusCode: { in: [...LIVE_STORE_STATUSES] },
            bpCode: { isPlatform: false },
          },
        },
      }),
    );
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('재인증(excludeBpCodeId)은 자기 BP 의 본사 · 점포 번호를 중복으로 보지 않는다', async () => {
    await service.verify(identity, 7);
    expect(prisma.storeBusinessProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bizRegistrationNumber: '1234567890',
          store: {
            isDeleted: false,
            storeStatusCode: { in: [...LIVE_STORE_STATUSES] },
            bpCodeId: { not: 7 },
            bpCode: { isPlatform: false },
          },
        },
      }),
    );
  });

  it('MISMATCH 면 422 와 불일치 문구', async () => {
    client.verify.mockResolvedValue('MISMATCH');
    await expect(service.verify(identity)).rejects.toThrow(
      new UnprocessableEntityException(
        '입력한 사업자정보가 국세청 정보와 일치하지 않습니다.',
      ),
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('NtsUnavailableError 면 503 과 장애 문구, 로그에 대표자명을 남기지 않는다', async () => {
    client.verify.mockRejectedValue(new NtsUnavailableError('HTTP 500'));
    await expect(service.verify(identity)).rejects.toThrow(
      new ServiceUnavailableException(
        '국세청 확인이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.',
      ),
    );
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain('정하윤');
  });

  it('MATCH 면 typ biz-verification 10분 토큰', async () => {
    await expect(service.verify(identity)).resolves.toBe('signed-token');
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { typ: 'biz-verification', ...identity },
      { expiresIn: '10m' },
    );
  });

  it('readToken 은 토큰의 세 값을 돌려준다', async () => {
    jwt.verifyAsync.mockResolvedValue({
      typ: 'biz-verification',
      ...identity,
      iat: 1,
      exp: 2,
    });
    await expect(service.readToken('t')).resolves.toEqual(identity);
  });

  it.each([
    [
      '서명·만료가 틀림',
      () => jwt.verifyAsync.mockRejectedValue(new Error('jwt expired')),
    ],
    [
      '가입 완료 토큰',
      () => jwt.verifyAsync.mockResolvedValue({ sub: 1, typ: 'signup' }),
    ],
    [
      '로그인 토큰',
      () => jwt.verifyAsync.mockResolvedValue({ sub: 1, typ: 'access' }),
    ],
  ])('readToken 은 %s 이면 400 만료 문구', async (_, arrange) => {
    arrange();
    await expect(service.readToken('t')).rejects.toThrow(
      new BadRequestException(
        '사업자정보 인증이 만료되었습니다. 다시 인증해 주세요.',
      ),
    );
  });

  it('isBizRegistrationNumberTaken 은 넘긴 트랜잭션으로 본다', async () => {
    const tx = {
      storeBusinessProfile: {
        findFirst: jest.fn().mockResolvedValue({ storeId: 1 }),
      },
    };
    await expect(
      service.isBizRegistrationNumberTaken('1234567890', tx as never),
    ).resolves.toBe(true);
    expect(prisma.storeBusinessProfile.findFirst).not.toHaveBeenCalled();
  });
});
