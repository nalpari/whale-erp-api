import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { ContractSendController } from './contract-send.controller';
import { ContractsController } from './contracts.controller';

/** 핸들러에 붙은 메뉴 권한 표시 — 경로 방식이라 메뉴는 컨트롤러 경로(/contracts — 근로계약 관리)로 찾는다 */
const permissionOf = (controller: { prototype: object }, method: string) => {
  const handler = Object.getOwnPropertyDescriptor(controller.prototype, method)!
    .value as object;
  return {
    meta: Reflect.getMetadata(MENU_PERMISSION, handler) as unknown,
    guards: Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[],
  };
};

// 근로계약 api 의 메뉴 권한(WHALEERP-592) — 관리자 웹 화면 버튼과 같은 대응이다(front ContractPermission)
describe('근로계약 api 메뉴 권한', () => {
  it.each<[string, unknown]>([
    ['list', 'read'],
    ['storeOptions', ['create', 'update']],
    ['create', 'create'],
    ['createPaper', 'create'],
    ['minimumWages', ['create', 'update']],
    ['findOne', 'read'],
    ['update', ['create', 'update']],
    ['updateWorker', 'update'],
    ['updatePaper', ['create', 'update']],
    ['documentDownloadUrl', 'read'],
    ['remove', 'delete'],
  ])('ContractsController.%s → %j', (method, action) => {
    const { meta, guards } = permissionOf(ContractsController, method);
    expect(meta).toEqual({ action });
    expect(guards).toContain(MenuPermissionGuard);
  });

  // 재발송 · 종료는 상태를 바꾸는 동작이라 수정 권한이다(WHALEERP-157 — 역할이 아니라 메뉴 권한으로 막는다)
  it.each(['send', 'end'])('ContractSendController.%s → update', (method) => {
    const { meta, guards } = permissionOf(ContractSendController, method);
    expect(meta).toEqual({ action: 'update' });
    expect(guards).toContain(MenuPermissionGuard);
  });

  it('권한 표시가 없는 경로가 없다 — 새 경로를 더하면 이 표에도 더한다', () => {
    for (const controller of [ContractsController, ContractSendController]) {
      const names = Object.getOwnPropertyNames(controller.prototype).filter(
        (name) => name !== 'constructor',
      );
      for (const name of names)
        expect([name, permissionOf(controller, name).meta]).toEqual([
          name,
          expect.anything(),
        ]);
    }
  });
});
