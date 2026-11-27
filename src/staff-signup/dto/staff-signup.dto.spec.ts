import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AcceptAffiliationRequestDto } from './affiliation-request.dto';
import { InvitationLookupDto } from './invitation-lookup.dto';
import { AcceptMyInvitationDto } from './my-invitation.dto';
import { StaffSignupDto } from './staff-signup.dto';

const signup = (overrides: Record<string, unknown> = {}) => ({
  phone: '01012345678',
  code: 'K7Q2M9PX',
  email: 'staff@whale.test',
  password: 'Whale2026!',
  name: '홍길동',
  birthDate: '1995-03-02',
  gender: 'FEMALE',
  zipCode: '04001',
  address: '서울 마포구 동교로 1',
  termsServiceAgreed: true,
  privacyAgreed: true,
  termsServiceVersion: 'v1.0',
  privacyVersion: 'v1.0',
  marketingVersion: 'v1.0',
  ...overrides,
});
const errorsOf = <T extends object>(cls: new () => T, plain: object) =>
  validateSync(plainToInstance(cls, plain)).map((e) => e.property);

describe('직원 가입 DTO', () => {
  it.each([
    ['termsServiceAgreed', false],
    ['termsServiceAgreed', undefined],
    ['termsServiceAgreed', 'true'],
    ['privacyAgreed', false],
    ['privacyAgreed', undefined],
  ])(
    '필수 약관 %s 가 %p 이면 받지 않는다 — true 만(ACC-23)',
    (property, value) => {
      const errors = validateSync(
        plainToInstance(StaffSignupDto, signup({ [property]: value })),
      );
      expect(errors.map((e) => e.property)).toEqual([property]);
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        '필수 약관에 동의해 주세요.',
      );
    },
  );

  it('필수 약관 두 칸이 모두 빠지면 받는다 — 약관 칸이 없던 예전 앱(동의는 홈에서 받는다)', () => {
    expect(
      errorsOf(
        StaffSignupDto,
        signup({
          termsServiceAgreed: undefined,
          privacyAgreed: undefined,
          termsServiceVersion: undefined,
          privacyVersion: undefined,
          marketingVersion: undefined,
        }),
      ),
    ).toEqual([]);
  });

  it('마케팅만 싣고 필수 둘을 빼면 받지 않는다 — 예전 앱으로 보지 않는다', () => {
    expect(
      errorsOf(
        StaffSignupDto,
        signup({
          termsServiceAgreed: undefined,
          privacyAgreed: undefined,
          marketingAgreed: true,
        }),
      ),
    ).toEqual(['termsServiceAgreed', 'privacyAgreed']);
  });

  it('약관 칸을 실으면 보인 버전 셋도 실어야 한다 — 마케팅만 null 을 받는다', () => {
    expect(
      errorsOf(
        StaffSignupDto,
        signup({ termsServiceVersion: undefined, privacyVersion: '' }),
      ),
    ).toEqual(['termsServiceVersion', 'privacyVersion']);
    expect(
      errorsOf(StaffSignupDto, signup({ marketingVersion: null })),
    ).toEqual([]);
    expect(
      errorsOf(StaffSignupDto, signup({ marketingVersion: undefined })),
    ).toEqual(['marketingVersion']);
  });

  it('약관 칸이 모두 빠지면(예전 앱) 버전도 보지 않는다', () => {
    expect(
      errorsOf(
        StaffSignupDto,
        signup({
          termsServiceAgreed: undefined,
          privacyAgreed: undefined,
          termsServiceVersion: undefined,
          privacyVersion: undefined,
          marketingVersion: undefined,
        }),
      ),
    ).toEqual([]);
  });

  it('필수 약관이 null 이면 받지 않는다 — 빠진 것과 다르다', () => {
    expect(
      errorsOf(
        StaffSignupDto,
        signup({ termsServiceAgreed: null, privacyAgreed: null }),
      ),
    ).toEqual(['termsServiceAgreed', 'privacyAgreed']);
  });

  it.each([true, false, undefined])(
    '마케팅 정보 수신은 선택 — %p 를 받는다',
    (marketingAgreed) => {
      expect(errorsOf(StaffSignupDto, signup({ marketingAgreed }))).toEqual([]);
    },
  );

  it('마케팅 정보 수신이 참 · 거짓이 아니면 받지 않는다', () => {
    expect(
      errorsOf(StaffSignupDto, signup({ marketingAgreed: 'yes' })),
    ).toEqual(['marketingAgreed']);
  });

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

  it('근무지 더하기 — 동의는 선택, 불리언만 받는다', () => {
    expect(errorsOf(AcceptMyInvitationDto, {})).toEqual([]);
    expect(
      errorsOf(AcceptMyInvitationDto, {
        hqSharingConsented: true,
        hqSharingConsentVersion: 'v1.0',
      }),
    ).toEqual([]);
    expect(
      errorsOf(AcceptMyInvitationDto, { hqSharingConsented: 'yes' }),
    ).toEqual(['hqSharingConsented']);
  });

  it('가입 — 필수만 넣어도 된다, 이메일은 소문자로 맞춘다', () => {
    const dto = plainToInstance(
      StaffSignupDto,
      signup({ email: ' Staff@Whale.Test ' }),
    );
    expect(validateSync(dto)).toEqual([]);
    expect(dto.email).toBe('staff@whale.test');
  });

  it('가입 — 성별이 없으면 받지 않는다(본인 대조가 늘 보도록 필수, ACC-23 · JOI-10, 2026-10-21 재영)', () => {
    expect(errorsOf(StaffSignupDto, signup({ gender: undefined }))).toEqual([
      'gender',
    ]);
    const [error] = validateSync(
      plainToInstance(StaffSignupDto, signup({ gender: undefined })),
    );
    expect(Object.values(error.constraints ?? {})).toEqual([
      '성별을 골라 주세요.',
    ]);
  });

  it.each([
    ['email', { email: 'not-mail' }],
    ['email', { email: '"a"@example.com' }],
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

  const asIs = (o: Record<string, unknown>) => o;
  describe.each<
    [string, new () => object, (o: Record<string, unknown>) => object]
  >([
    ['가입', StaffSignupDto, signup],
    ['근무지 더하기', AcceptMyInvitationDto, asIs],
    ['소속 추가 수락', AcceptAffiliationRequestDto, asIs],
  ])('%s — 본사 제공 동의 문구 버전(ATT-30 v252)', (_label, cls, body) => {
    it('동의하면서 버전을 실으면 비지 않은 64자 이하 문자열이어야 한다 — 아니면 400', () => {
      for (const hqSharingConsentVersion of ['', 1, 'v'.repeat(65)])
        expect(
          errorsOf(
            cls,
            body({ hqSharingConsented: true, hqSharingConsentVersion }),
          ),
        ).toEqual(['hqSharingConsentVersion']);
    });

    it('동의하면서 버전을 싣지 않아도 400 이 아니다 — 예전 앱의 동의는 남기지 않고 가입 · 수락은 마친다(ATT-30 v253)', () => {
      expect(errorsOf(cls, body({ hqSharingConsented: true }))).toEqual([]);
      // null 도 빠진 것과 같다
      expect(
        errorsOf(
          cls,
          body({ hqSharingConsented: true, hqSharingConsentVersion: null }),
        ),
      ).toEqual([]);
    });

    it('동의하지 않으면 버전은 보지 않는다', () => {
      expect(errorsOf(cls, body({ hqSharingConsented: false }))).toEqual([]);
      expect(
        errorsOf(
          cls,
          body({ hqSharingConsented: false, hqSharingConsentVersion: 1 }),
        ),
      ).toEqual([]);
      expect(errorsOf(cls, body({}))).toEqual([]);
    });
  });
});
