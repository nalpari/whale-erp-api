import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminProfileEmailAvailabilityQueryDto } from './admin-profile-email-availability-query.dto';
import { AdminProfileUpdateDto } from './admin-profile-update.dto';

// 중복 확인(email-availability)은 저장(PATCH .../me)이 받을 값을 미리 묻는 것이다. 정규화나 형식이
// 저장과 다르면 「사용 가능」이라던 이메일이 저장에서 400 이 될 수 있다 — admin-signup 의 같은 검사와
// 같은 이유(availability.dto.spec.ts).
const saveField = (email: string) => {
  const dto = plainToInstance(AdminProfileUpdateDto, {
    name: '이서준',
    phone: '01012345678',
    email,
  });
  const failed = validateSync(dto).some((e) => e.property === 'email');
  return { value: dto.email, failed };
};

describe('AdminProfileEmailAvailabilityQueryDto', () => {
  const check = (email: unknown) => {
    const dto = plainToInstance(AdminProfileEmailAvailabilityQueryDto, {
      email,
    });
    return { value: dto.email, failed: validateSync(dto).length > 0 };
  };

  it.each([' HaYoon@Hangang.co.kr ', 'hayoon@hangang.co.kr', 'not-an-email'])(
    '저장과 같게 정규화하고 같게 거른다: %p',
    (email) => expect(check(email)).toEqual(saveField(email)),
  );

  it('대문자 · 앞뒤 공백이 있어도 소문자로 본다', () =>
    expect(check(' HaYoon@Hangang.co.kr ')).toEqual({
      value: 'hayoon@hangang.co.kr',
      failed: false,
    }));

  // DTO 없이 @Query('email') 로 받던 때는 없는 값이 email.toLowerCase() 에서 500 이 났다(코드 리뷰로 찾음).
  it('email 이 없으면 400(검증 실패) — 500 이 아니다', () =>
    expect(check(undefined).failed).toBe(true));

  it('email 을 두 번 실으면(배열) 400 — 배열은 class-validator 가 거른다', () =>
    expect(check(['a@b.com', 'c@d.com']).failed).toBe(true));
});
