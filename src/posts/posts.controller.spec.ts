import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import type { AuthUser } from '../auth/auth.types';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

describe('PostsController', () => {
  let controller: PostsController;
  let posts: Record<'list' | 'get' | 'create' | 'update' | 'remove', jest.Mock>;
  let scope: { isPlatformAdmin: jest.Mock };
  const user: AuthUser = { type: 'admin', id: 3, loginId: 'admin', sid: 1 };

  beforeEach(async () => {
    posts = {
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    scope = { isPlatformAdmin: jest.fn().mockResolvedValue(true) };
    const module = await Test.createTestingModule({
      controllers: [PostsController],
      providers: [
        { provide: PostsService, useValue: posts },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    controller = module.get(PostsController);
  });

  it.each([
    ['list', () => controller.list(user, { contentType: 'NOTICE' })],
    ['get', () => controller.get(user, '7')],
    ['create', () => controller.create(user, {} as never)],
    ['update', () => controller.update(user, '7', {} as never)],
    ['remove', () => controller.remove(user, '7')],
  ] as const)('플랫폼 관리자가 아니면 %s 는 403', async (name, run) => {
    scope.isPlatformAdmin.mockResolvedValue(false);
    await expect(run()).rejects.toThrow(ForbiddenException);
    expect(posts[name]).not.toHaveBeenCalled();
  });

  it.each(['0', '2147483648', '-1', '1.5', 'abc'])(
    '경로 ID %s 는 DB 에 묻지 않고 404',
    async (raw) => {
      await expect(controller.get(user, raw)).rejects.toThrow(
        NotFoundException,
      );
      await expect(controller.remove(user, raw)).rejects.toThrow(
        NotFoundException,
      );
      expect(posts.get).not.toHaveBeenCalled();
      expect(posts.remove).not.toHaveBeenCalled();
    },
  );

  it('정수 범위 안이면 그 ID 로 넘긴다', async () => {
    await controller.get(user, '2147483647');
    expect(posts.get).toHaveBeenCalledWith(2147483647);
  });
});
