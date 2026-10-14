import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import type { AuthUser } from '../auth/auth.types';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';

describe('InquiriesController', () => {
  let controller: InquiriesController;
  let inquiries: Record<
    'startProcessing' | 'reply' | 'saveInternalMemo',
    jest.Mock
  >;
  let scope: { isPlatformAdmin: jest.Mock };
  const user: AuthUser = { type: 'admin', id: 3, email: 'a@test.invalid' };
  const memo = { internalMemo: 'x', updatedAt: '2026-10-14T00:00:00.000Z' };
  const reply = { body: 'x', updatedAt: '2026-10-14T00:00:00.000Z' };

  beforeEach(async () => {
    inquiries = {
      startProcessing: jest.fn(),
      reply: jest.fn(),
      saveInternalMemo: jest.fn(),
    };
    scope = { isPlatformAdmin: jest.fn().mockResolvedValue(true) };
    const module = await Test.createTestingModule({
      controllers: [InquiriesController],
      providers: [
        { provide: InquiriesService, useValue: inquiries },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(InquiriesController);
  });

  it.each([
    ['startProcessing', () => controller.startProcessing(user, '7')],
    ['reply', () => controller.reply(user, '7', reply)],
    ['saveInternalMemo', () => controller.saveInternalMemo(user, '7', memo)],
  ] as const)('플랫폼 관리자가 아니면 %s 는 403', async (name, run) => {
    scope.isPlatformAdmin.mockResolvedValue(false);
    await expect(run()).rejects.toThrow(ForbiddenException);
    expect(inquiries[name]).not.toHaveBeenCalled();
  });

  it.each(['0', '2147483648', '-1', '1.5', 'abc'])(
    '경로 ID %s 는 DB 에 묻지 않고 404',
    async (raw) => {
      await expect(controller.startProcessing(user, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(inquiries.startProcessing).not.toHaveBeenCalled();
    },
  );

  it('로그인한 관리자와 그 ID 로 넘긴다', async () => {
    await controller.startProcessing(user, '2147483647');
    await controller.reply(user, '7', reply);
    await controller.saveInternalMemo(user, '7', memo);
    expect(inquiries.startProcessing).toHaveBeenCalledWith(3, 2147483647);
    expect(inquiries.reply).toHaveBeenCalledWith(3, 7, reply);
    expect(inquiries.saveInternalMemo).toHaveBeenCalledWith(7, memo);
  });
});
