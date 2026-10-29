import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminPasswordVerificationDto } from './admin-password-verification.dto';

describe('AdminPasswordVerificationDto', () => {
  const failed = (body: object) =>
    validateSync(plainToInstance(AdminPasswordVerificationDto, body)).map(
      (e) => e.property,
    );

  it('현재 비밀번호를 받는다', () =>
    expect(failed({ currentPassword: 'Own-pass-1!' })).toEqual([]));

  it.each([[{}], [{ currentPassword: '' }], [{ currentPassword: 1 }]])(
    '%p 는 400',
    (body) => expect(failed(body)).toEqual(['currentPassword']),
  );
});
