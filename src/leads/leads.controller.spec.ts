import { ThrottlerGuard } from '@nestjs/throttler';
import { IS_PUBLIC } from '../auth/auth.decorators';
import { LeadsController } from './leads.controller';

// 이 경로를 지키는 것은 데코레이터뿐이다. 이름(ip · account)을 틀리게 쓰면 오류 없이 기본
// 한도(분당 60건)로 돌므로 메타데이터로 고정한다. 키는 @nestjs/throttler 내부 상수다.
describe('LeadsController', () => {
  const meta = (key: string): unknown =>
    Reflect.getMetadata(key, LeadsController);

  it('로그인 없이 받는다', () => {
    expect(meta(IS_PUBLIC)).toBe(true);
  });

  it('같은 IP 는 시간당 5건까지 받는다', () => {
    expect(meta('__guards__')).toContain(ThrottlerGuard);
    expect(meta('THROTTLER:LIMITip')).toBe(5);
    expect(meta('THROTTLER:TTLip')).toBe(3_600_000);
  });

  it('로그인용 계정 축은 쓰지 않는다', () => {
    expect(meta('THROTTLER:SKIPaccount')).toBe(true);
  });
});
