import { IS_PUBLIC } from '../auth/auth.decorators';
import { EnumsController } from './enums.controller';
import { EnumsService } from './enums.service';

describe('EnumsController', () => {
  const service = new EnumsService(
    { ContractStatus: [['SIGNED', '체결 완료']] },
    { UserType: [['staff', '직원']] },
  );
  const controller = new EnumsController(service);

  it('GET /enums 는 전체 목록을 준다', () => {
    expect(controller.findAll()).toBe(service.all());
  });

  it('GET /enums/:name 은 그 enum 하나를 준다', () => {
    expect(controller.findOne('UserType')).toEqual(service.one('UserType'));
  });

  // 비로그인 홈(도입문의 관심 서비스 등)도 선택지를 그려야 한다. 전역 가드를 비켜 간다.
  it('토큰 없이 부를 수 있다 (@Public)', () => {
    expect(Reflect.getMetadata(IS_PUBLIC, EnumsController)).toBe(true);
  });
});
