import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateLeadDto } from './create-lead.dto';

const valid = {
  contactName: ' 김도윤 ',
  industryCode: 'CAFE',
  phone: '02-1234-5678',
  email: ' DoYun@Example.com ',
  interests: ['STORE_OPERATION'],
  body: '도입 비용이 궁금합니다',
  privacyAgreed: true,
};

const parse = (over: Record<string, unknown> = {}) => {
  const dto = plainToInstance(CreateLeadDto, { ...valid, ...over });
  return { dto, errors: validateSync(dto).map((e) => e.property) };
};

describe('CreateLeadDto', () => {
  it('이름은 다듬고 전화번호는 숫자만, 이메일은 소문자로 받는다', () => {
    const { dto, errors } = parse();

    expect(errors).toEqual([]);
    expect(dto).toMatchObject({
      contactName: '김도윤',
      phone: '0212345678',
      email: 'doyun@example.com',
    });
  });

  it.each([
    ['contactName', '  '],
    ['industryCode', undefined],
    ['phone', undefined],
    ['email', undefined],
    ['interests', []],
    ['body', ' '],
  ])('필수 항목 %s 가 비면 거른다', (field, value) => {
    expect(parse({ [field]: value }).errors).toContain(field);
  });

  it.each(['1588-1234', '010-1234-5678', '031 123 4567'])(
    '대표번호 · 휴대전화 · 지역번호를 받는다: %s',
    (phone) => {
      expect(parse({ phone }).errors).toEqual([]);
    },
  );

  it.each(['1234', '010-1234-56789', '1012345678', '1988-1234', '전화번호'])(
    '전화번호 꼴이 틀리면 거른다: %s',
    (phone) => {
      expect(parse({ phone }).errors).toContain('phone');
    },
  );

  it('이메일 꼴이 틀리면 거른다', () => {
    expect(parse({ email: 'doyun@' }).errors).toContain('email');
  });

  it('없는 관심 서비스는 거른다', () => {
    expect(parse({ interests: ['DELIVERY'] }).errors).toContain('interests');
  });

  it.each([false, undefined, 'true'])(
    '개인정보 수집·이용에 동의하지 않으면 거른다: %s',
    (privacyAgreed) => {
      expect(parse({ privacyAgreed }).errors).toContain('privacyAgreed');
    },
  );

  it('업종이 기타면 직접 입력이 필요하다', () => {
    expect(parse({ industryCode: 'ETC' }).errors).toContain('industryDetail');
    expect(
      parse({ industryCode: 'ETC', industryDetail: '꽃집' }).errors,
    ).toEqual([]);
  });
});
