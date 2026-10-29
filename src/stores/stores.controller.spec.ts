// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { signedInUserTracker } from '../auth/throttle';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import type { ExcelExportsService } from '../excel-exports/excel-exports.service';
import type { StoreExcelSource } from './store-excel.source';
import type { StoreManagementService } from './store-management.service';
import { StoresController } from './stores.controller';
import type { StoresService } from './stores.service';

const USER: AuthUser = { id: 5, type: 'admin', loginId: 'admin', sid: 1 };
/** 가드가 X-Bp-Code-Id 로 정한 대상 BP(@TargetBp) */
const BP: TargetBpContext = { bpCodeId: 8, isPlatformCaller: true };

describe('StoresController', () => {
  const methodMeta = (key: string, method: keyof StoresController): unknown =>
    Reflect.getMetadata(
      key,
      Object.getOwnPropertyDescriptor(StoresController.prototype, method)
        ?.value as object,
    );

  it('사업자 인증 확인은 IP · 계정마다 시간당 10건이다 — 회원가입과 같은 국세청 하루 할당량을 쓴다', () => {
    expect(methodMeta(GUARDS_METADATA, 'verifyBusiness')).toContain(
      ThrottlerGuard,
    );
    expect(methodMeta('THROTTLER:LIMITip', 'verifyBusiness')).toBe(10);
    expect(methodMeta('THROTTLER:TTLip', 'verifyBusiness')).toBe(3_600_000);
    expect(methodMeta('THROTTLER:LIMITaccount', 'verifyBusiness')).toBe(10);
    expect(methodMeta('THROTTLER:TTLaccount', 'verifyBusiness')).toBe(
      3_600_000,
    );
    expect(methodMeta('THROTTLER:TRACKERaccount', 'verifyBusiness')).toBe(
      signedInUserTracker,
    );
  });

  const options = { options: jest.fn() };
  const management = {
    list: jest.fn(),
    detail: jest.fn(),
    histories: jest.fn(),
    transitionCheck: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    verifyBusiness: jest.fn(),
    putImage: jest.fn(),
    removeImage: jest.fn(),
  };
  const excelExports = {
    request: jest.fn().mockResolvedValue({
      kind: 'file',
      fileName: '점포목록_20261014.xlsx',
      buffer: Buffer.from('PK'),
    }),
  };
  const excelSource = { menuUrl: '/stores' };
  const res = { status: jest.fn() };
  const controller = new StoresController(
    options as unknown as StoresService,
    management as unknown as StoreManagementService,
    excelExports as unknown as ExcelExportsService,
    excelSource as unknown as StoreExcelSource,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, StoresController)).toEqual([
      'admin',
    ]);
  });

  it('GET /stores/options 는 메뉴 권한 없이 업무 범위로만 거른 근무지 선택지다', async () => {
    const page = { items: [], total: 0 };
    options.options.mockResolvedValue(page);
    await expect(
      controller.options({ page: 1, pageSize: 200 }, USER),
    ).resolves.toBe(page);
    expect(options.options).toHaveBeenCalledWith(5, { page: 1, pageSize: 200 });
    expect(methodMeta(MENU_PERMISSION, 'options')).toBeUndefined();
    expect(methodMeta(GUARDS_METADATA, 'options')).toBeUndefined();
  });

  // 권한 판정은 가드가 한다 — 파이프 · 인터셉터 · 핸들러보다 먼저 돌아, 권한 없는 요청은 그 어디에도 닿지 않는다.
  it.each([
    ['list', 'read'],
    ['excel', 'read'],
    ['verifyBusiness', ['create', 'update']],
    ['detail', 'read'],
    ['histories', 'read'],
    ['transitionCheck', 'read'],
    ['create', 'create'],
    ['update', 'update'],
    ['remove', 'delete'],
    ['putImage', 'update'],
    ['removeImage', 'update'],
  ] as const)(
    '%s 은 가드가 /stores 메뉴의 %j 권한을 본다',
    (method, action) => {
      expect(methodMeta(MENU_PERMISSION, method)).toEqual({
        action,
      });
      expect(methodMeta(USER_TYPES, method)).toEqual(['admin']);
      expect(methodMeta(GUARDS_METADATA, method)).toContain(
        MenuPermissionGuard,
      );
    },
  );

  it.each([
    ['list', () => controller.list(USER, BP, { page: 1, pageSize: 20 })],
    ['detail', () => controller.detail(USER, BP, '11')],
    [
      'histories',
      () => controller.histories(USER, BP, '11', { page: 1, pageSize: 10 }),
    ],
    ['transitionCheck', () => controller.transitionCheck(USER, BP, '11')],
    ['create', () => controller.create(USER, BP, {} as never)],
    ['update', () => controller.update(USER, BP, '11', {} as never)],
    ['remove', () => controller.remove(USER, BP, '11')],
    ['verifyBusiness', () => controller.verifyBusiness(USER, BP, {} as never)],
    ['putImage', () => controller.putImage(USER, BP, '11', [])],
    ['removeImage', () => controller.removeImage(USER, BP, '11')],
  ])(
    '%s 은 서비스에 관리자 계정 id 와 대상 BP 를 넘긴다',
    async (method, call) => {
      await call();
      const [id, bp] = management[method as keyof typeof management].mock
        .calls[0] as unknown[];
      expect(id).toBe(5);
      expect(bp).toBe(BP);
    },
  );

  // 비플랫폼 계정은 서비스가 bp 를 읽지 않아, @TargetBp() 가 빠져도 BM · FM 테스트는 모두 통과한다 — 플랫폼 계정만
  // 500 이 된다. 그래서 데코레이터가 붙었는지를 라우트 인자 메타데이터로 직접 본다.
  describe('@TargetBp()', () => {
    type RouteArgs = Record<string, { index: number; factory?: unknown }>;
    const argsOf = (target: object, method: string) =>
      Object.values(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, target, method) ??
          {}) as RouteArgs,
      );
    // createParamDecorator 의 팩토리 — 같은 데코레이터면 같은 함수다(가드 spec 의 TargetBp 와 같은 방식).
    class Probe {
      handler(@TargetBp() bp: unknown) {
        return bp;
      }
    }
    const targetBpFactory = argsOf(Probe, 'handler')[0].factory;

    it.each([
      'list',
      'excel',
      'verifyBusiness',
      'detail',
      'histories',
      'transitionCheck',
      'create',
      'update',
      'remove',
      'putImage',
      'removeImage',
    ] as const)('%s 은 둘째 인자로 @TargetBp() 를 받는다', (method) => {
      expect(
        argsOf(StoresController, method).some(
          (a) => a.index === 1 && a.factory === targetBpFactory,
        ),
      ).toBe(true);
    });

    it('근무지 선택지(options)는 받지 않는다 — 메뉴 권한이 없어 가드가 대상 BP 를 정하지 않는다(500)', () => {
      expect(
        argsOf(StoresController, 'options').some(
          (a) => a.factory === targetBpFactory,
        ),
      ).toBe(false);
    });
  });

  it('경로 id 는 숫자로 바꿔 넘긴다', async () => {
    await controller.detail(USER, BP, '11');
    expect(management.detail).toHaveBeenCalledWith(5, BP, 11);
  });

  it.each(['0', 'abc', '2147483648', '1.5'])(
    '경로 id %s 는 서비스에 묻기 전에 404',
    (raw) => {
      expect(() => controller.detail(USER, BP, raw)).toThrow(NotFoundException);
      expect(management.detail).not.toHaveBeenCalled();
    },
  );

  it('대표 이미지는 받은 첫 파일을 넘기고, 없으면 undefined 를 넘긴다', async () => {
    const file = { buffer: Buffer.from('x'), size: 1, originalname: 'a.png' };
    await controller.putImage(USER, BP, '11', [file]);
    await controller.putImage(USER, BP, '11', undefined);
    expect(management.putImage.mock.calls[0][3]).toBe(file);
    expect(management.putImage.mock.calls[1][3]).toBeUndefined();
  });

  it('사업자 인증 확인은 본문을 그대로 넘긴다', async () => {
    const body = {
      bizRegistrationNumber: '1234567890',
      ceoName: '김대표',
      openDate: '2020-03-02',
    };
    await controller.verifyBusiness(USER, BP, body);
    expect(management.verifyBusiness).toHaveBeenCalledWith(5, BP, body);
  });

  it('엑셀은 공통 엑셀에 점포 소스 · 관리자 계정 id · 대상 BP · 조건을 넘기고, 파일이면 xlsx 로 내려보낸다', async () => {
    const query = { statuses: ['CLOSED'] } as never;
    const file = (await controller.excel(USER, BP, query, res as never)) as {
      getHeaders(): object;
    };
    expect(excelExports.request).toHaveBeenCalledWith(
      excelSource,
      { adminAccountId: 5, bp: BP },
      query,
    );
    expect(file.getHeaders()).toMatchObject({
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition:
        "attachment; filename*=UTF-8''%EC%A0%90%ED%8F%AC%EB%AA%A9%EB%A1%9D_20261014.xlsx",
      length: 2,
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('1만 건 이상이면 202 와 안내를 준다 — 파일은 메일 링크로 간다', async () => {
    excelExports.request.mockResolvedValueOnce({
      kind: 'scheduled',
      excelDownloadId: 41,
      rowCount: 12_480,
    });
    await expect(
      controller.excel(USER, BP, {}, res as never),
    ).resolves.toMatchObject({ excelDownloadId: 41, rowCount: 12_480 });
    expect(res.status).toHaveBeenCalledWith(202);
  });
});
