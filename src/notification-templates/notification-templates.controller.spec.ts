import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationTemplatesService } from './notification-templates.service';

describe('NotificationTemplatesController', () => {
  let controller: NotificationTemplatesController;
  let scope: { isPlatformAdmin: jest.Mock };
  let service: Record<
    'list' | 'get' | 'create' | 'update' | 'restore' | 'setActive',
    jest.Mock
  >;
  const admin = { type: 'admin' as const, id: 9, email: 'a@test.invalid' };
  const version = { updatedAt: '2026-10-13T01:02:03.456Z' };

  beforeEach(async () => {
    scope = { isPlatformAdmin: jest.fn().mockResolvedValue(true) };
    service = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      get: jest.fn().mockResolvedValue({ id: 5 }),
      create: jest.fn().mockResolvedValue({ id: 6 }),
      update: jest.fn().mockResolvedValue({ id: 5 }),
      restore: jest.fn().mockResolvedValue({ id: 5 }),
      setActive: jest.fn().mockResolvedValue({ id: 5 }),
    };
    const module = await Test.createTestingModule({
      controllers: [NotificationTemplatesController],
      providers: [
        { provide: NotificationTemplatesService, useValue: service },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(NotificationTemplatesController);
  });

  it('플랫폼 관리자가 아니면 모든 요청이 403', async () => {
    scope.isPlatformAdmin.mockResolvedValue(false);
    await expect(controller.list(admin, { channel: 'EMAIL' })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(controller.get(admin, '5')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(controller.restore(admin, '5', version)).rejects.toThrow(
      ForbiddenException,
    );
    expect(service.list).not.toHaveBeenCalled();
  });

  it.each(['0', 'abc', '2147483648', '-1'])(
    '경로 id %s 는 404',
    async (raw) => {
      await expect(controller.get(admin, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(scope.isPlatformAdmin).not.toHaveBeenCalled();
    },
  );

  it('관리자 id 를 넘겨 서비스를 부른다', async () => {
    await controller.update(admin, '5', { ...version } as never);
    await controller.setActive(admin, '5', { ...version, isActive: false });
    expect(service.update).toHaveBeenCalledWith(9, 5, expect.anything());
    expect(service.setActive).toHaveBeenCalledWith(9, 5, {
      ...version,
      isActive: false,
    });
  });
});
