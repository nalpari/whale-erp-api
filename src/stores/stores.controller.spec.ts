import { USER_TYPES } from '../auth/auth.decorators';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';

describe('StoresController', () => {
  const service = { list: jest.fn() };
  const controller = new StoresController(service as unknown as StoresService);

  it('GET /stores 는 쿼리와 로그인한 관리자 id 를 서비스에 넘긴다', async () => {
    const page = { items: [], total: 0 };
    service.list.mockResolvedValue(page);
    await expect(
      controller.list(
        { page: 1, pageSize: 200 },
        { id: 5, type: 'admin', email: 'a@b.c' },
      ),
    ).resolves.toBe(page);
    expect(service.list).toHaveBeenCalledWith(5, { page: 1, pageSize: 200 });
  });

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, StoresController)).toEqual([
      'admin',
    ]);
  });
});
