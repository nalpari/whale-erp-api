import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { MyTodosController } from './my-todos.controller';
import { StaffMemberTodosController } from './staff-member-todos.controller';
import { TodoIdPipe } from './todo-id.pipe';
import { TodosController } from './todos.controller';
import { TodosService } from './todos.service';

const permission = (cls: object, name: string) =>
  Reflect.getMetadata(
    MENU_PERMISSION,
    Object.getOwnPropertyDescriptor(
      (cls as { prototype: object }).prototype,
      name,
    )!.value as object,
  ) as unknown;

describe('TO-DO 컨트롤러', () => {
  let todos: Record<string, jest.Mock>;
  let admin: TodosController;
  let mine: MyTodosController;
  const adminUser = { type: 'admin' as const, id: 9, loginId: 'bm', sid: 1 };
  const account = { type: 'account' as const, id: 3, email: 'a@b.c', sid: 1 };

  beforeEach(async () => {
    todos = {
      list: jest.fn(),
      changeStatus: jest.fn(),
      listMine: jest.fn(),
      changeMyStatus: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [
        TodosController,
        MyTodosController,
        StaffMemberTodosController,
      ],
      providers: [{ provide: TodosService, useValue: todos }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    admin = module.get(TodosController);
    mine = module.get(MyTodosController);
  });

  it('TO-DO 리스트 관리(MN000026) — 조회 · 등록 · 수정 · 삭제 권한을 경로마다 본다', () => {
    const expected = {
      list: 'read',
      assignableStaff: 'create',
      findOne: 'read',
      create: 'create',
      update: 'update',
      changeStatus: 'update',
      remove: 'delete',
    };
    for (const [name, action] of Object.entries(expected))
      expect([name, permission(TodosController, name)]).toEqual([
        name,
        { action },
      ]);
  });

  it('assignable-staff 는 :todoId 보다 먼저 선언된다(그래야 경로 ID 로 읽히지 않는다)', () => {
    const names = Object.getOwnPropertyNames(TodosController.prototype);
    expect(names.indexOf('assignableStaff')).toBeGreaterThan(-1);
    expect(names.indexOf('assignableStaff')).toBeLessThan(
      names.indexOf('findOne'),
    );
  });

  it('직원 상세의 TO-DO 는 직원 정보 관리(MN000005) 조회 권한', () => {
    expect(permission(StaffMemberTodosController, 'list')).toEqual({
      action: 'read',
    });
  });

  it('내 TO-DO 는 직원 근무 앱 토큰만', () => {
    expect(Reflect.getMetadata(USER_TYPES, MyTodosController)).toEqual([
      'account',
    ]);
  });

  it('토큰의 사용자 ID 로 서비스를 부른다', async () => {
    await admin.list({ page: 1, pageSize: 20 }, adminUser);
    expect(todos.list).toHaveBeenCalledWith(9, { page: 1, pageSize: 20 });
    await admin.changeStatus(7, { status: 'DONE' }, adminUser);
    expect(todos.changeStatus).toHaveBeenCalledWith(9, 7, 'DONE');
    await mine.list({ page: 1, pageSize: 20 }, account);
    expect(todos.listMine).toHaveBeenCalledWith(3, { page: 1, pageSize: 20 });
    await mine.changeStatus(7, { status: 'DONE' }, account);
    expect(todos.changeMyStatus).toHaveBeenCalledWith(3, 7, 'DONE');
  });

  it('경로 ID 는 1..2147483647 만 받는다(그 밖은 404)', () => {
    const pipe = new TodoIdPipe();
    expect(pipe.transform('7')).toBe(7);
    for (const raw of ['0', 'abc', '2147483648'])
      expect(() => pipe.transform(raw)).toThrow(NotFoundException);
  });
});
