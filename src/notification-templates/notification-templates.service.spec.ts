import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationTemplateChannel,
  PreferenceCategory,
  Prisma,
} from '@prisma/client';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  historySummary,
  NotificationTemplatesService,
} from './notification-templates.service';

const updatedAt = new Date('2026-10-13T01:02:03.456Z');
const vars = [
  {
    name: '직원이름',
    label: '직원 이름',
    isRequired: true,
    sampleValue: '문태경',
  },
];
const row = (over: object = {}) => ({
  notificationTemplateId: 5,
  templateCode: 'NTF_CONTRACT_SIGNED',
  channel: 'NOTIFICATION' as NotificationTemplateChannel,
  templateName: '근로계약 날인',
  preferenceCategory: null as PreferenceCategory | null,
  title: '#{직원이름} 님이 날인했습니다',
  body: '근무지',
  variables: vars,
  kakaoTemplateCode: null,
  isActive: true,
  defaultTitle: '#{직원이름} 님이 날인했습니다',
  defaultBody: '근무지',
  defaultVariables: vars,
  updatedBy: null,
  updatedAt,
  ...over,
});
const fields = (over: object = {}) => ({
  channel: 'NOTIFICATION' as const,
  templateName: '근로계약 날인',
  templateCode: 'NTF_CONTRACT_SIGNED',
  preferenceCategory: null,
  title: '#{직원이름} 님이 날인했습니다',
  body: '새 본문',
  kakaoTemplateCode: null,
  variables: vars,
  ...over,
});
/** 목의 첫 호출에서 넘긴 data */
const dataOf = (m: jest.Mock): Record<string, unknown> =>
  (m.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'x',
  });

describe('NotificationTemplatesService', () => {
  let service: NotificationTemplatesService;
  let tx: {
    notificationTemplate: { findUnique: jest.Mock; updateMany: jest.Mock };
    notificationTemplateHistory: { create: jest.Mock };
  };
  let prisma: {
    notificationTemplate: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    notificationTemplateHistory: { findMany: jest.Mock };
    adminAccount: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    tx = {
      notificationTemplate: {
        findUnique: jest.fn().mockResolvedValue(row()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      notificationTemplateHistory: { create: jest.fn() },
    };
    prisma = {
      notificationTemplate: {
        findMany: jest.fn().mockResolvedValue([row({ updatedBy: 9 })]),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue(row()),
        create: jest.fn().mockResolvedValue(row({ notificationTemplateId: 6 })),
      },
      notificationTemplateHistory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      adminAccount: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ adminAccountId: 9, name: '이서준' }]),
      },
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (t: typeof tx) => unknown)(tx)
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationTemplatesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(NotificationTemplatesService);
  });

  describe('list', () => {
    it('채널 하나를 코드순으로 한 쪽 주고, 고친 관리자 이름과 기본 문구 여부를 붙인다', async () => {
      const result = await service.list({
        channel: 'NOTIFICATION',
        page: 2,
        pageSize: 20,
      });

      expect(prisma.notificationTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { channel: 'NOTIFICATION' },
          orderBy: [{ templateCode: 'asc' }, { notificationTemplateId: 'asc' }],
          skip: 20,
          take: 20,
        }),
      );
      expect(result).toEqual({
        total: 1,
        items: [
          expect.objectContaining({
            id: 5,
            templateCode: 'NTF_CONTRACT_SIGNED',
            hasDefault: true,
            updatedByName: '이서준',
            bodySummary: '근무지',
          }),
        ],
      });
    });
  });

  describe('get', () => {
    it('없으면 404', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(null);
      await expect(service.get(5)).rejects.toThrow(NotFoundException);
    });

    it('변경 이력을 최근 것부터, 바뀐 것 요약과 함께 준다', async () => {
      prisma.notificationTemplateHistory.findMany.mockResolvedValue([
        { ...row({ body: '옛 본문' }), changedBy: 9, changedAt: updatedAt },
      ]);

      const detail = await service.get(5);

      expect(detail.histories).toEqual([
        { changedAt: updatedAt, changedByName: '이서준', summary: '본문' },
      ]);
      expect(detail.variables).toEqual(vars);
    });
  });

  describe('create', () => {
    it('검사에 걸리면 400 과 고칠 문장 목록', async () => {
      await expect(
        service.create(1, { ...fields({ body: '' }), isActive: true }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.notificationTemplate.create).not.toHaveBeenCalled();
    });

    it('코드가 겹치면 409', async () => {
      prisma.notificationTemplate.create.mockRejectedValue(p2002());
      await expect(
        service.create(1, { ...fields(), isActive: true }),
      ).rejects.toThrow(ConflictException);
    });

    it('알림톡이 아닌데 카카오 템플릿 코드가 빈 글자면 없음으로 저장한다', async () => {
      await service.create(1, {
        ...fields({ kakaoTemplateCode: '' }),
        isActive: true,
      });
      expect(dataOf(prisma.notificationTemplate.create)).toMatchObject({
        kakaoTemplateCode: null,
      });
    });

    it('기본 문구 없이 만들고 만든 관리자를 남긴다', async () => {
      await service.create(1, { ...fields(), isActive: false });

      const data = dataOf(prisma.notificationTemplate.create);
      expect(data).toMatchObject({
        templateCode: 'NTF_CONTRACT_SIGNED',
        isActive: false,
        updatedBy: 1,
      });
      expect(data).not.toHaveProperty('defaultBody');
    });
  });

  describe('update', () => {
    it('바뀌기 전 행을 이력에 남기고 읽은 시각이 같을 때만 고친다', async () => {
      await service.update(1, 5, {
        ...fields(),
        updatedAt: updatedAt.toISOString(),
      });

      expect(dataOf(tx.notificationTemplateHistory.create)).toMatchObject({
        notificationTemplateId: 5,
        body: '근무지',
        changedBy: 1,
      });
      const [update] = tx.notificationTemplate.updateMany.mock.calls[0] as [
        { where: unknown; data: Record<string, unknown> },
      ];
      expect(update.where).toEqual({
        notificationTemplateId: 5,
        updatedAt: { gte: updatedAt, lt: new Date(updatedAt.getTime() + 1) },
      });
      expect(update.data).toMatchObject({ body: '새 본문', updatedBy: 1 });
    });

    it('그사이 누가 고쳤으면 409', async () => {
      tx.notificationTemplate.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.update(1, 5, {
          ...fields(),
          updatedAt: updatedAt.toISOString(),
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('없으면 404, 검사에 걸리면 400, 코드가 겹치면 409', async () => {
      tx.notificationTemplate.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.update(1, 5, {
          ...fields(),
          updatedAt: updatedAt.toISOString(),
        }),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.update(1, 5, {
          ...fields({ title: '' }),
          updatedAt: updatedAt.toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);

      tx.notificationTemplate.updateMany.mockRejectedValue(p2002());
      await expect(
        service.update(1, 5, {
          ...fields(),
          updatedAt: updatedAt.toISOString(),
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('restore', () => {
    it('제목 · 본문 · 변수 목록만 기본값으로 돌리고 이력을 남긴다 (NOTIFY-18)', async () => {
      tx.notificationTemplate.findUnique.mockResolvedValue(
        row({
          body: '고친 본문',
          templateCode: 'NTF_RENAMED',
          isActive: false,
        }),
      );

      await service.restore(1, 5, { updatedAt: updatedAt.toISOString() });

      expect(tx.notificationTemplateHistory.create).toHaveBeenCalled();
      expect(dataOf(tx.notificationTemplate.updateMany)).toEqual({
        title: '#{직원이름} 님이 날인했습니다',
        body: '근무지',
        variables: vars,
        updatedBy: 1,
      });
    });

    it('되돌릴 값이 지금 채널 규칙에 맞지 않으면 400 으로 막고 고치지 않는다', async () => {
      // 채널을 앱 푸시로 바꾼 뒤 되돌리면, 운영 알림 기본 본문이 앱 푸시 100자를 넘을 수 있다.
      tx.notificationTemplate.findUnique.mockResolvedValue(
        row({
          channel: 'PUSH',
          preferenceCategory: 'CONTRACT',
          defaultBody: '가'.repeat(101),
        }),
      );
      await expect(
        service.restore(1, 5, { updatedAt: updatedAt.toISOString() }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.notificationTemplate.updateMany).not.toHaveBeenCalled();
    });

    it('기본 문구가 없는 템플릿(등록한 것)은 409', async () => {
      tx.notificationTemplate.findUnique.mockResolvedValue(
        row({ defaultBody: null, defaultTitle: null, defaultVariables: null }),
      );
      await expect(
        service.restore(1, 5, { updatedAt: updatedAt.toISOString() }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('setActive', () => {
    it('사용 여부를 바꾸고 이력을 남긴다', async () => {
      await service.setActive(1, 5, {
        isActive: false,
        updatedAt: updatedAt.toISOString(),
      });

      expect(tx.notificationTemplateHistory.create).toHaveBeenCalled();
      expect(dataOf(tx.notificationTemplate.updateMany)).toEqual({
        isActive: false,
        updatedBy: 1,
      });
    });
  });
});

describe('historySummary', () => {
  it('바뀐 칸 이름을 화면 순서로 잇는다', () => {
    const before = row();
    expect(
      historySummary(before, row({ title: 'x', body: 'y', isActive: false })),
    ).toBe('사용 여부 · 제목 · 본문');
    expect(historySummary(before, row({ variables: [] }))).toBe('변수 목록');
    expect(historySummary(before, row())).toBe('바뀐 것 없음');
  });
});
