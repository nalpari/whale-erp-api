import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotificationIdPipe } from './notification-id.pipe';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let service: {
    list: jest.Mock;
    read: jest.Mock;
    readAll: jest.Mock;
    remove: jest.Mock;
  };
  const admin = { type: 'admin' as const, id: 9, email: 'a@test.invalid' };

  beforeEach(async () => {
    service = {
      list: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, unreadCount: 0 }),
      read: jest.fn().mockResolvedValue({ id: 70 }),
      readAll: jest.fn().mockResolvedValue({ updated: 2 }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: service }],
    }).compile();
    controller = module.get(NotificationsController);
  });

  it('목록은 관리자 ID 와 쿼리를 넘긴다', async () => {
    await controller.findAll(admin, { page: 2 });
    expect(service.list).toHaveBeenCalledWith(9, { page: 2 });
  });

  it('읽음 · 모두 읽음 · 삭제는 관리자 ID 로 부른다', async () => {
    await expect(controller.read(admin, 70)).resolves.toEqual({ id: 70 });
    await expect(controller.readAll(admin)).resolves.toEqual({ updated: 2 });
    await controller.remove(admin, { ids: [70, 71] });
    expect(service.read).toHaveBeenCalledWith(9, 70);
    expect(service.readAll).toHaveBeenCalledWith(9);
    expect(service.remove).toHaveBeenCalledWith(9, [70, 71]);
  });
});

describe('NotificationIdPipe', () => {
  const pipe = new NotificationIdPipe();

  it.each(['0', '-1', 'abc', '2147483648', '01'])('%s 는 404', (raw) => {
    expect(() => pipe.transform(raw)).toThrow(NotFoundException);
  });

  it('범위 안의 정수는 숫자로 바꾼다', () => {
    expect(pipe.transform('2147483647')).toBe(2147483647);
  });
});
