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
  const user = { id: 5, type: 'admin' as const, loginId: 'admin', sid: 1 };
  // 가드가 정한 대상 BP — 서비스에 그대로 넘긴다(WHALEERP-618)
  const bp = { bpCodeId: 2, isPlatformCaller: false };

  it('GET /contracts 는 쿼리 · 로그인한 관리자 id · 대상 BP 를 서비스에 넘긴다', async () => {
    const page = { items: [], total: 0 };
    service.list.mockResolvedValue(page);
    const query = { page: 2, pageSize: 20, status: ['SIGNED' as const] };

    await expect(controller.list(query, user, bp)).resolves.toBe(page);
    expect(service.list).toHaveBeenCalledWith(5, query, bp);
  });

  it('POST /contracts 는 본문 · 로그인한 관리자 id · 대상 BP 를 서비스에 넘긴다', async () => {
    const created = { contractId: 7, staffMemberId: 3 };
    service.create.mockResolvedValue(created);
    const body = { name: '남도현' } as never;

    await expect(controller.create(body, user, bp)).resolves.toBe(created);
    expect(service.create).toHaveBeenCalledWith(body, 5, [], bp);
  });

  it('GET /contracts/:contractId 는 관리자 id 와 계약 id 로 그 계약을 준다', async () => {
    const detail = { contractId: 7 };
    service.findOne.mockResolvedValue(detail);
    await expect(controller.findOne(7, user, bp)).resolves.toBe(detail);
    expect(service.findOne).toHaveBeenCalledWith(5, 7, bp);
  });

  it('PUT /contracts/:contractId 는 관리자 id · 계약 id 와 본문을 서비스에 넘긴다', async () => {
    const saved = { contractId: 7, staffMemberId: 3 };
    service.update.mockResolvedValue(saved);
    const body = { name: '남도현' } as never;
    await expect(controller.update(7, body, user, bp)).resolves.toBe(saved);
    expect(service.update).toHaveBeenCalledWith(5, 7, body, [], bp);
  });

  it('DELETE /contracts/:contractId 는 관리자 id 와 계약 id 를 서비스에 넘긴다', async () => {
    service.remove.mockResolvedValue(undefined);
    await expect(controller.remove(7, user, bp)).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith(5, 7, bp);
  });

  // 직원 이름 · 급여가 담긴다. 관리자 웹 토큰만 받는다.
  it('관리자 토큰만 받는다 (@UserTypes("admin"))', () => {
    expect(Reflect.getMetadata(USER_TYPES, ContractsController)).toEqual([
      'admin',
    ]);
    expect(Reflect.getMetadata(IS_PUBLIC, ContractsController)).toBeUndefined();
  });
});
