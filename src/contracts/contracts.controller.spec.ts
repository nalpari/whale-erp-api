import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

describe('ContractsController', () => {
  const service = {
    list: jest.fn(),
    create: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const controller = new ContractsController(
    service as unknown as ContractsService,
  );

  it('GET /contracts 는 쿼리를 그대로 서비스에 넘긴다', async () => {
    const page = { items: [], total: 0 };
    service.list.mockResolvedValue(page);
    const query = { page: 2, pageSize: 20, status: ['SIGNED' as const] };

    await expect(controller.list(query)).resolves.toBe(page);
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('POST /contracts 는 본문과 로그인한 관리자 id 를 서비스에 넘긴다', async () => {
    const created = { contractId: 7, staffMemberId: 3 };
    service.create.mockResolvedValue(created);
    const body = { name: '남도현' } as never;

    await expect(
      controller.create(body, { id: 5, type: 'admin', email: 'a@b.c' }),
    ).resolves.toBe(created);
    expect(service.create).toHaveBeenCalledWith(body, 5);
  });

  it('GET /contracts/:contractId 는 그 계약을 준다', async () => {
    const detail = { contractId: 7 };
    service.findOne.mockResolvedValue(detail);
    await expect(controller.findOne(7)).resolves.toBe(detail);
    expect(service.findOne).toHaveBeenCalledWith(7);
  });

  it('PUT /contracts/:contractId 는 id 와 본문을 서비스에 넘긴다', async () => {
    const saved = { contractId: 7, staffMemberId: 3 };
    service.update.mockResolvedValue(saved);
    const body = { name: '남도현' } as never;
    await expect(controller.update(7, body)).resolves.toBe(saved);
    expect(service.update).toHaveBeenCalledWith(7, body);
  });

  it('DELETE /contracts/:contractId 는 그 id 를 서비스에 넘긴다', async () => {
    service.remove.mockResolvedValue(undefined);
    await expect(controller.remove(7)).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith(7);
  });

  // 직원 이름 · 급여가 담긴다. 관리자 웹 토큰만 받는다.
  it('관리자 토큰만 받는다 (@UserTypes("admin"))', () => {
    expect(Reflect.getMetadata(USER_TYPES, ContractsController)).toEqual([
      'admin',
    ]);
    expect(Reflect.getMetadata(IS_PUBLIC, ContractsController)).toBeUndefined();
  });
});
