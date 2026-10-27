import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BpProfileUpdateDto } from './bp-profile-update.dto';

// 대표자 연락처는 점포 연락처와 같은 9~12자리(050X 평생번호 포함)다.
describe('BpProfileUpdateDto bizCeoPhone', () => {
  const phoneErrors = (bizCeoPhone: unknown) =>
    validateSync(plainToInstance(BpProfileUpdateDto, { bizCeoPhone }))
      .filter((e) => e.property === 'bizCeoPhone')
      .flatMap((e) => Object.values(e.constraints ?? {}));

  it.each(['021234567', '01012345678', '050720331334'])('%s 는 받는다', (p) => {
    expect(phoneErrors(p)).toEqual([]);
  });

  it.each(['02123456', '0507203313345', '010-1234-5678'])(
    '%s 는 400 — 숫자 9~12자리만',
    (p) => {
      expect(phoneErrors(p)).toEqual(['대표자 연락처는 숫자 9~12자리입니다']);
    },
  );
});
