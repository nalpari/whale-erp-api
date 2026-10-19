import { Test, TestingModule } from '@nestjs/testing';
import { CodesService } from '../codes/codes.service';
import { PrismaService } from '../prisma/prisma.service';
import { TermsVersionsService } from './terms-versions.service';

const firstArg = (fn: jest.Mock) =>
  (fn.mock.calls as unknown[][])[0][0] as {
    where: Record<string, unknown>;
    orderBy: unknown;
    select: Record<string, unknown>;
  };

describe('TermsVersionsService', () => {
  let service: TermsVersionsService;
  let prisma: {
    termsVersion: { findMany: jest.Mock; findFirst: jest.Mock };
  };
  let codes: { forPlatform: jest.Mock };

  const TYPES = [
    { value: 'TERMS_SERVICE', label: '이용약관', order: 1 },
    { value: 'PRIVACY_COLLECT', label: '개인정보 수집·이용 동의', order: 2 },
  ];
  const row = (termsTypeCode: string, over: Record<string, unknown> = {}) => ({
    termsTypeCode,
    title: `${termsTypeCode} 제목`,
    version: 'v1.0',
    effectiveDate: new Date('2026-10-01T00:00:00Z'),
    ...over,
  });

  beforeEach(async () => {
    prisma = {
      termsVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    codes = {
      forPlatform: jest.fn().mockResolvedValue({ TERMS_TYPE: TYPES }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TermsVersionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodesService, useValue: codes },
      ],
    }).compile();
    service = module.get(TermsVersionsService);
  });

  describe('findAll', () => {
    it('사용 중 · 미삭제 · 시행된 행만, 최신 시행일부터 읽는다', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-19T16:00:00Z') }); // KST 10-20 01시
      try {
        await service.findAll();
      } finally {
        jest.useRealTimers();
      }
      expect(codes.forPlatform).toHaveBeenCalledWith(['TERMS_TYPE']);
      expect(prisma.termsVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            termsTypeCode: { in: ['TERMS_SERVICE', 'PRIVACY_COLLECT'] },
            isActive: true,
            isDeleted: false,
            effectiveDate: { lte: new Date('2026-10-20T00:00:00Z') },
          },
          orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
        }),
      );
    });

    it('목록에는 본문을 싣지 않는다', async () => {
      await service.findAll();
      expect(firstArg(prisma.termsVersion.findMany).select).not.toHaveProperty(
        'content',
      );
    });

    it('공통코드 순서대로, 유형마다 첫 행(최신)만, 탭 이름은 공통코드 label', async () => {
      prisma.termsVersion.findMany.mockResolvedValue([
        row('PRIVACY_COLLECT', { version: 'v1.1' }),
        row('TERMS_SERVICE'),
        row('PRIVACY_COLLECT'),
      ]);
      expect(await service.findAll()).toEqual({
        items: [
          {
            termsTypeCode: 'TERMS_SERVICE',
            label: '이용약관',
            title: 'TERMS_SERVICE 제목',
            version: 'v1.0',
            effectiveDate: '2026-10-01',
          },
          {
            termsTypeCode: 'PRIVACY_COLLECT',
            label: '개인정보 수집·이용 동의',
            title: 'PRIVACY_COLLECT 제목',
            version: 'v1.1',
            effectiveDate: '2026-10-01',
          },
        ],
        total: 2,
      });
    });

    it('사용 중인 행이 없는 유형은 빠진다', async () => {
      prisma.termsVersion.findMany.mockResolvedValue([row('PRIVACY_COLLECT')]);
      const { items, total } = await service.findAll();
      expect(items.map((i) => i.termsTypeCode)).toEqual(['PRIVACY_COLLECT']);
      expect(total).toBe(1);
    });
  });

  describe('findOne', () => {
    it('본문을 더해 돌려준다', async () => {
      prisma.termsVersion.findFirst.mockResolvedValue(
        row('PRIVACY_COLLECT', { content: '## 본문' }),
      );
      expect(await service.findOne('PRIVACY_COLLECT')).toEqual({
        termsTypeCode: 'PRIVACY_COLLECT',
        label: '개인정보 수집·이용 동의',
        title: 'PRIVACY_COLLECT 제목',
        version: 'v1.0',
        effectiveDate: '2026-10-01',
        content: '## 본문',
      });
      const { where, orderBy } = firstArg(prisma.termsVersion.findFirst);
      expect(where).toMatchObject({
        termsTypeCode: 'PRIVACY_COLLECT',
        isActive: true,
        isDeleted: false,
      });
      expect(where).toHaveProperty('effectiveDate.lte');
      expect(orderBy).toEqual([
        { effectiveDate: 'desc' },
        { termsVersionId: 'desc' },
      ]);
    });

    it('공통코드에 없거나 사용하지 않는 유형이면 DB 를 보지 않고 null', async () => {
      expect(await service.findOne('POLICY')).toBeNull();
      expect(prisma.termsVersion.findFirst).not.toHaveBeenCalled();
    });

    it('사용 중인 행이 없으면 null', async () => {
      expect(await service.findOne('TERMS_SERVICE')).toBeNull();
    });
  });
});
