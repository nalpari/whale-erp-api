import { validateTemplate, type TemplateInput } from './validate-template';

const mail = (over: Partial<TemplateInput> = {}): TemplateInput => ({
  channel: 'EMAIL',
  templateName: '근로계약 날인 알림',
  templateCode: 'EMAIL_CONTRACT_SIGNED',
  preferenceCategory: null,
  title: '#{직원이름} 님이 날인했습니다',
  body: '근무지 #{근무지}',
  kakaoTemplateCode: null,
  variables: [
    {
      name: '직원이름',
      label: '직원 이름',
      isRequired: true,
      sampleValue: '문태경',
    },
    {
      name: '근무지',
      label: '근무지',
      isRequired: false,
      sampleValue: '판교점',
    },
    {
      name: '링크',
      label: '바로가기',
      isRequired: true,
      sampleValue: 'https://x',
      isButtonLink: true,
    },
  ],
  ...over,
});

describe('validateTemplate', () => {
  it('맞는 메일 템플릿은 오류가 없다 — 버튼 링크 변수는 본문에 없어도 된다', () => {
    expect(validateTemplate(mail())).toEqual([]);
  });

  it('템플릿 이름 · 코드 · 본문이 비면 막는다', () => {
    expect(
      validateTemplate(mail({ templateName: ' ', templateCode: '', body: '' })),
    ).toEqual(
      expect.arrayContaining([
        '템플릿 이름을 넣어 주세요.',
        '템플릿 코드를 넣어 주세요.',
        '본문을 넣어 주세요.',
      ]),
    );
  });

  it('템플릿 코드는 영문 대문자로 시작하고 대문자 · 숫자 · 밑줄만', () => {
    for (const templateCode of ['email_x', '1EMAIL', 'EMAIL-X', 'EMAIL X'])
      expect(validateTemplate(mail({ templateCode }))).toContain(
        '템플릿 코드는 영문 대문자로 시작하고 대문자 · 숫자 · 밑줄만 씁니다.',
      );
  });

  it('운영 알림 · 앱 푸시 · 메일은 제목이 필수다', () => {
    expect(validateTemplate(mail({ title: null }))).toContain(
      '제목을 넣어 주세요.',
    );
  });

  it('알림톡은 제목을 받지 않고 카카오 템플릿 코드가 필수다', () => {
    const talk = mail({
      channel: 'ALIMTALK',
      templateCode: 'TALK_X',
      title: '제목',
      kakaoTemplateCode: null,
    });
    expect(validateTemplate(talk)).toEqual(
      expect.arrayContaining([
        '알림톡은 제목을 쓰지 않습니다.',
        '카카오 템플릿 코드를 넣어 주세요.',
      ]),
    );
  });

  it('알림톡이 아니면 카카오 템플릿 코드를 받지 않는다', () => {
    expect(validateTemplate(mail({ kakaoTemplateCode: 'K1' }))).toContain(
      '카카오 템플릿 코드는 알림톡에만 넣습니다.',
    );
  });

  it('앱 푸시만 수신 설정 묶음이 필수이고, 제목 40자 · 본문 100자를 넘지 않는다 (NOTIFY-4)', () => {
    const push = mail({
      channel: 'PUSH',
      templateCode: 'PUSH_X',
      title: '가'.repeat(41),
      body: '나'.repeat(101),
      preferenceCategory: null,
      variables: [],
    });
    expect(validateTemplate(push)).toEqual(
      expect.arrayContaining([
        '앱 푸시는 수신 설정 묶음을 골라 주세요.',
        '제목은 40자를 넘을 수 없습니다(지금 41자).',
        '본문은 100자를 넘을 수 없습니다(지금 101자).',
      ]),
    );
    expect(
      validateTemplate(mail({ preferenceCategory: 'CONTRACT' })),
    ).toContain('수신 설정 묶음은 앱 푸시에만 고릅니다.');
  });

  it('제목 · 본문에 목록에 없는 변수가 있으면 몇째 줄인지 알려 준다', () => {
    expect(
      validateTemplate(mail({ body: '첫 줄\n둘째 줄 #{없는변수}' })),
    ).toContain('본문 2번째 줄: #{없는변수} 는 변수 목록에 없습니다.');
  });

  it('닫히지 않은 #{ 를 막는다', () => {
    expect(validateTemplate(mail({ body: '근무지 #{근무지' }))).toContain(
      '본문 1번째 줄: 닫히지 않은 #{ 가 있습니다.',
    );
  });

  it('필수 변수가 제목 · 본문 어디에도 없으면 막는다 — 버튼 링크는 빼고', () => {
    expect(validateTemplate(mail({ title: '날인했습니다' }))).toContain(
      '필수 변수 #{직원이름} 가 제목 · 본문에 없습니다.',
    );
  });

  it('변수 이름은 비지 않고 겹치지 않으며 # · 중괄호 · 공백이 없다. 표시 이름도 필수', () => {
    const errors = validateTemplate(
      mail({
        body: '본문',
        title: '제목 #{직원이름}',
        variables: [
          {
            name: '직원이름',
            label: '직원 이름',
            isRequired: true,
            sampleValue: '',
          },
          {
            name: '직원이름',
            label: '중복',
            isRequired: false,
            sampleValue: '',
          },
          { name: '이 름', label: '', isRequired: false, sampleValue: '' },
          { name: '', label: '빈', isRequired: false, sampleValue: '' },
        ],
      }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        '변수 목록 2번째 줄: 변수 이름 직원이름 이 겹칩니다.',
        '변수 목록 3번째 줄: 변수 이름에 # · 중괄호 · 공백을 쓸 수 없습니다.',
        '변수 목록 3번째 줄: 표시 이름을 넣어 주세요.',
        '변수 목록 4번째 줄: 변수 이름을 넣어 주세요.',
      ]),
    );
  });

  it('버튼 링크 표시는 메일 · 알림톡 변수에만 (NOTIFY-20)', () => {
    const push = mail({
      channel: 'PUSH',
      templateCode: 'PUSH_X',
      preferenceCategory: 'CONTRACT',
      title: '#{직원이름}',
    });
    expect(validateTemplate(push)).toContain(
      '변수 목록 3번째 줄: 버튼 링크는 메일 · 알림톡 변수에만 씁니다.',
    );
  });

  it('NUL 이 든 값은 받지 않는다', () => {
    expect(validateTemplate(mail({ body: '근무지\u0000' }))).toContain(
      '제어 문자(NUL)는 쓸 수 없습니다.',
    );
  });
});
