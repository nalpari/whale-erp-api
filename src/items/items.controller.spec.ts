import 'reflect-metadata';
import { USER_TYPES } from '../auth/auth.decorators';
import { ItemsController } from './items.controller';

describe('ItemsController', () => {
  it('직원 토큰만 허용한다', () => {
    // 품목 마스터는 직원용이다. 전역 가드는 "인증됐는가"만 보므로 이 표시가
    // 없으면 고객 토큰으로도 조회·수정·삭제·재고이동이 전부 열린다.
    expect(Reflect.getMetadata(USER_TYPES, ItemsController)).toEqual(['staff']);
  });
});
