import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBpAdminDto } from './save-bp-admin.dto';

// BP 관리자 연락처는 점포 연락처와 같은 9~12자리다(DB CHECK admin_accounts_phone_format).
describe('CreateBpAdminDto phone', () => {
  const phoneErrors = (phone: unknown) =>
    validateSync(plainToInstance(CreateBpAdminDto, { phone }))
      .filter((e) => e.property === 'phone')
      .flatMap((e) => Object.values(e.constraints ?? {}));

  it.each(['021234567', '01012345678', '050720331334'])('%s 는 받는다', (p) => {
    expect(phoneErrors(p)).toEqual([]);
  });

  it.each(['02123456', '0507203313345', '010-1234-5678'])(
    '%s 는 400 — 숫자 9~12자리만',
    (p) => {
      expect(phoneErrors(p)).toEqual(['연락처는 숫자 9~12자리입니다.']);
    },
  );
});
