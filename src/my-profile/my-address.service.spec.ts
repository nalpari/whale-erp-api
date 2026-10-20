import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MyAddressService } from './my-address.service';

const BEFORE = {
  status: 'JOINED',
  zipCode: '06236',
  address: '서울 강남구 테헤란로 1',
  addressDetail: '3층',
};

describe('MyAddressService', () => {
  let tx: {
    $queryRaw: jest.Mock;
    account: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };

  const build = async (before: Record<string, unknown> = BEFORE) => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(before),
        update: jest.fn().mockResolvedValue({}),
      },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MyAddressService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    return moduleRef.get(MyAddressService);
  };

  const input = {
    zipCode: '04524',
    address: '서울 중구 세종대로 110',
    addressDetail: '2층 201호',
  };

  it('계정 행을 잠그고 그 계정의 주소 세 칸을 바꾼다 — 직원 레코드는 계정 주소를 읽으므로 모든 소속에 같이 보인다', async () => {
    const service = await build();
    await service.update(12, input);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.account.update).toHaveBeenCalledWith({
      where: { accountId: 12 },
      data: input,
    });
  });

  it('변경 전후 값을 본인 경로(SELF) 주소 이력으로 남긴다', async () => {
    const service = await build();
    await service.update(12, input);
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: {
        accountId: 12,
        field: 'ADDRESS',
        channel: 'SELF',
        beforeValue: '(06236) 서울 강남구 테헤란로 1 3층',
        afterValue: '(04524) 서울 중구 세종대로 110 2층 201호',
      },
    });
  });

  it('처음 넣는 주소는 이전 값이 null 이다', async () => {
    const service = await build({
      status: 'JOINED',
      zipCode: null,
      address: null,
      addressDetail: null,
    });
    await service.update(12, input);
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ beforeValue: null }) as unknown,
    });
  });

  it('상세 주소를 비우면 null 로 저장한다', async () => {
    const service = await build();
    await service.update(12, { ...input, addressDetail: null });
    expect(tx.account.update).toHaveBeenCalledWith({
      where: { accountId: 12 },
      data: { ...input, addressDetail: null },
    });
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterValue: '(04524) 서울 중구 세종대로 110',
      }) as unknown,
    });
  });

  it('같은 값이면 쓰지 않고 이력도 남기지 않는다', async () => {
    const service = await build();
    await service.update(12, {
      zipCode: BEFORE.zipCode,
      address: BEFORE.address,
      addressDetail: BEFORE.addressDetail,
    });
    expect(tx.account.update).not.toHaveBeenCalled();
    expect(tx.accountChangeHistory.create).not.toHaveBeenCalled();
  });

  it('이어 붙인 글이 같아도 칸이 다르면 바뀐 것이다 — 「A」+「B」와 「A B」+없음', async () => {
    const service = await build({
      status: 'JOINED',
      zipCode: '04524',
      address: '서울 중구 세종대로 110',
      addressDetail: '2층',
    });
    await service.update(12, {
      zipCode: '04524',
      address: '서울 중구 세종대로 110 2층',
      addressDetail: null,
    });
    expect(tx.account.update).toHaveBeenCalled();
  });

  it('탈퇴 계정은 401 이고 쓰지 않는다', async () => {
    const service = await build({ ...BEFORE, status: 'WITHDRAWN' });
    await expect(service.update(12, input)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tx.account.update).not.toHaveBeenCalled();
  });
});
