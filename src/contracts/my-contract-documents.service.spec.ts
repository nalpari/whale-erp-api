import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { MyContractDocumentsService } from './my-contract-documents.service';

/** 직원 앱 근로계약 파일 내려받기 주소(WHALEERP-146 · 149) */
describe('MyContractDocumentsService', () => {
  let prisma: {
    contract: { findFirst: jest.Mock };
    contractDocument: { findFirst: jest.Mock };
  };
  let storage: { downloadUrl: jest.Mock };
  const service = (s: unknown = storage) =>
    new MyContractDocumentsService(
      prisma as unknown as PrismaService,
      s as StorageService | null,
    );
  const doc = (kind: string) => ({
    kind,
    storageKey: 'contracts/41/0f8fad5b-d9cb-469f-a165-70867728950e.pdf',
    fileName: '근로계약서.pdf',
  });

  beforeEach(() => {
    prisma = {
      contract: {
        findFirst: jest.fn().mockResolvedValue({ status: 'SIGNED' }),
      },
      contractDocument: {
        findFirst: jest
          .fn()
          .mockResolvedValue(doc('PAPER_EMPLOYMENT_CONTRACT')),
      },
    };
    storage = {
      downloadUrl: jest.fn().mockResolvedValue('https://s3.test/signed'),
    };
  });

  it('내 계약의 파일이면 300초 주소를 준다 — 원래 파일 이름으로 받게 저장소에 넘긴다', async () => {
    await expect(service().downloadUrl(77, 41, 5)).resolves.toEqual({
      url: 'https://s3.test/signed',
    });
    expect(storage.downloadUrl).toHaveBeenCalledWith(
      'contracts/41/0f8fad5b-d9cb-469f-a165-70867728950e.pdf',
      '근로계약서.pdf',
    );
  });

  it('계약은 상세와 같은 「내 계약」 기준으로 찾는다 — 서명 대기 이후 · 내 계정에 이어진 직원 레코드', async () => {
    await service().downloadUrl(77, 41, 5);
    const [args] = prisma.contract.findFirst.mock.calls[0] as [
      Prisma.ContractFindFirstArgs,
    ];
    expect(args.where).toEqual({
      contractId: 41,
      status: {
        in: [
          'PENDING_SIGNATURE',
          'CORRECTION_REQUESTED',
          'SIGNED',
          'REJECTED',
          'EXPIRED',
          'ENDED',
        ],
      },
      staffMember: { accountId: 77 },
    });
  });

  it('내 계약이 아니면 상세와 같은 404 본문 — 파일도 저장소도 보지 않는다', async () => {
    prisma.contract.findFirst.mockResolvedValue(null);
    const run = service(null).downloadUrl(77, 41, 5);
    await expect(run).rejects.toBeInstanceOf(NotFoundException);
    await expect(run).rejects.toThrow('근로계약을 찾을 수 없습니다');
    expect(prisma.contractDocument.findFirst).not.toHaveBeenCalled();
  });

  it('파일은 그 계약의 것이고 상세 목록에 있는 것(필기 서명 제외)만 찾는다', async () => {
    await service().downloadUrl(77, 41, 5);
    const [args] = prisma.contractDocument.findFirst.mock.calls[0] as [
      Prisma.ContractDocumentFindFirstArgs,
    ];
    expect(args.where).toEqual({
      contractDocumentId: 5,
      contractId: 41,
      kind: { not: 'SIGNATURE' },
    });
  });

  it('다른 계약의 파일 · 필기 서명 · 없는 파일은 404 — 저장소 설정과 상관없이', async () => {
    prisma.contractDocument.findFirst.mockResolvedValue(null);
    const run = service(null).downloadUrl(77, 41, 5);
    await expect(run).rejects.toBeInstanceOf(NotFoundException);
    await expect(run).rejects.toThrow('파일을 찾을 수 없습니다');
  });

  it.each(['SIGNED', 'ENDED'])(
    '처리 완료본(SIGNED_COPY)은 체결된 계약(%s)에서 받는다',
    async (status) => {
      prisma.contract.findFirst.mockResolvedValue({ status });
      prisma.contractDocument.findFirst.mockResolvedValue(doc('SIGNED_COPY'));
      await expect(service().downloadUrl(77, 41, 5)).resolves.toEqual({
        url: 'https://s3.test/signed',
      });
    },
  );

  it.each(['PENDING_SIGNATURE', 'CORRECTION_REQUESTED', 'REJECTED', 'EXPIRED'])(
    '처리 완료본은 체결되지 않은 계약(%s)에서는 409 — 지금 상태를 싣고, 저장소를 부르지 않는다',
    async (status) => {
      prisma.contract.findFirst.mockResolvedValue({ status });
      prisma.contractDocument.findFirst.mockResolvedValue(doc('SIGNED_COPY'));
      const run = service().downloadUrl(77, 41, 5);
      await expect(run).rejects.toBeInstanceOf(ConflictException);
      await expect(run).rejects.toMatchObject({
        response: { code: 'CONTRACT_STATUS_CONFLICT', status },
      });
      expect(storage.downloadUrl).not.toHaveBeenCalled();
    },
  );

  it.each(['SENT_ORIGINAL', 'PAPER_EMPLOYMENT_CONTRACT', 'WAGE_CONTRACT'])(
    '처리 완료본이 아닌 파일(%s)은 서명 대기에서도 받는다',
    async (kind) => {
      prisma.contract.findFirst.mockResolvedValue({
        status: 'PENDING_SIGNATURE',
      });
      prisma.contractDocument.findFirst.mockResolvedValue(doc(kind));
      await expect(service().downloadUrl(77, 41, 5)).resolves.toEqual({
        url: 'https://s3.test/signed',
      });
    },
  );

  it('저장소가 설정되지 않았으면 503', async () => {
    await expect(service(null).downloadUrl(77, 41, 5)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('주소 만들기가 실패하면 그 오류를 그대로 올린다', async () => {
    storage.downloadUrl.mockRejectedValue(new Error('s3 down'));
    await expect(service().downloadUrl(77, 41, 5)).rejects.toThrow('s3 down');
  });
});
