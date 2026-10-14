import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StaffMemberListService } from './staff-member-list.service';
import { StaffMembersController } from './staff-members.controller';

describe('StaffMembersController', () => {
  let controller: StaffMembersController;
  let list: { list: jest.Mock };
  const admin = { type: 'admin' as const, id: 9, loginId: 'admin', sid: 1 };

  beforeEach(async () => {
    list = { list: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [StaffMembersController],
      providers: [{ provide: StaffMemberListService, useValue: list }],
    }).compile();
    controller = module.get(StaffMembersController);
  });

  it('관리자 ID 와 쿼리를 넘겨 결과를 그대로 낸다', async () => {
    list.list.mockResolvedValue({ items: [], total: 0 });
    await expect(controller.findAll(admin, { page: 2 })).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(list.list).toHaveBeenCalledWith(9, { page: 2 });
  });

  it('사용 중인 관리자가 아니면 403', async () => {
    list.list.mockResolvedValue(null);
    await expect(controller.findAll(admin, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
