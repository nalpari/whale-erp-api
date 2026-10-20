import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { InvitationLookupDto } from './invitation-lookup.dto';
import { StaffSignupDto } from './staff-signup.dto';

const signup = (overrides: Record<string, unknown> = {}) => ({
  phone: '01012345678',
  code: 'K7Q2M9PX',
  email: 'staff@whale.test',
  password: 'Whale2026!',
  name: '홍길동',
  birthDate: '1995-03-02',
  zipCode: '04001',
  address: '서울 마포구 동교로 1',
  ...overrides,
});
const errorsOf = <T extends object>(cls: new () => T, plain: object) =>
  validateSync(plainToInstance(cls, plain)).map((e) => e.property);

describe('직원 가입 DTO', () => {
  it('초대 코드는 앞뒤 공백을 지우고 대문자로, 번호는 하이픈을 지운다', () => {
    const dto = plainToInstance(InvitationLookupDto, {
      code: ' k7q2m9px ',
      phone: '010-1234-5678',
    });
    expect(dto).toMatchObject({ code: 'K7Q2M9PX', phone: '01012345678' });
    expect(validateSync(dto)).toEqual([]);
  });

  it.each([
    'K7Q2M9P',
    'K7Q2M9PXX',
    'K7Q2M9P0',
    'K7Q2M9PO',
    'K7Q2M9P1',
    'K7Q2M9PI',
    '가나다라마바사아',
  ])('초대 코드 %p 는 받지 않는다 — 8자리, 0 · O · 1 · I 없음', (code) => {
    expect(errorsOf(InvitationLookupDto, { code })).toEqual(['code']);
  });

  it.each([
    ['짧음', 'A'.repeat(42)],
    ['길음', 'A'.repeat(44)],
    ['base64url 이 아님', `${'A'.repeat(42)}+`],
  ])('링크 토큰이 %s 이면 받지 않는다', (_label, token) => {
    expect(errorsOf(InvitationLookupDto, { token })).toEqual(['token']);
  });

  it.each(['token', 'phone', 'code'])(
    '%s 가 null 이면 형식 오류다 — 보내지 않은 칸만 건너뛴다(api #81 리뷰: null 이면 500)',
    (property) => {
      expect(errorsOf(InvitationLookupDto, { [property]: null })).toEqual([
        property,
      ]);
    },
  );

  it('가입 — 필수만 넣어도 된다, 이메일은 소문자로 맞춘다', () => {
    const dto = plainToInstance(
      StaffSignupDto,
      signup({ email: ' Staff@Whale.Test ' }),
    );
    expect(validateSync(dto)).toEqual([]);
    expect(dto.email).toBe('staff@whale.test');
  });

  it.each([
    ['email', { email: 'not-mail' }],
    ['birthDate', { birthDate: '19950302' }],
    ['gender', { gender: 'OTHER' }],
    ['isForeigner', { isForeigner: 'Y' }],
    ['zipCode', { zipCode: '1234' }],
    ['address', { address: '' }],
    ['name', { name: '' }],
    ['hqSharingConsented', { hqSharingConsented: 'yes' }],
  ])('%s 형식이 틀리면 받지 않는다', (property, overrides) => {
    expect(errorsOf(StaffSignupDto, signup(overrides))).toEqual([property]);
  });
});
