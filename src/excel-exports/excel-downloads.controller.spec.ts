import { NotFoundException } from '@nestjs/common';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ExcelDownloadsController } from './excel-downloads.controller';
import type { ExcelExportsService } from './excel-exports.service';

describe('ExcelDownloadsController', () => {
  const exports = { download: jest.fn().mockResolvedValue({ url: 'u' }) };
  const controller = new ExcelDownloadsController(
    exports as unknown as ExcelExportsService,
  );
  const user = { id: 7 } as AuthUser;

  beforeEach(() => exports.download.mockClear());

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, ExcelDownloadsController)).toEqual([
      'admin',
    ]);
  });

  it('토큰의 본인 id 로 찾는다 — 다른 사람의 파일은 서비스가 404 로 답한다', async () => {
    await expect(controller.download(user, '31')).resolves.toEqual({
      url: 'u',
    });
    expect(exports.download).toHaveBeenCalledWith(7, 31);
  });

  // integer 범위 밖이 DB 까지 가면 500 이다 — 경로에서 404 로 끊는다(CLAUDE.md).
  it.each(['abc', '0', '-1', '1.5', '2147483648'])(
    '%s 는 찾지 않고 404',
    (raw) => {
      expect(() => controller.download(user, raw)).toThrow(NotFoundException);
      expect(exports.download).not.toHaveBeenCalled();
    },
  );
});
