import { MASK, type TemplateSource, renderTemplate } from './render-template';

describe('renderTemplate', () => {
  const template: TemplateSource = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    title: '[WHALE ERP] #{관리자이름} 님 임시 비밀번호',
    body: '#{관리자이름} 님, #{관리자이름} 님\n\n임시 비밀번호: #{임시비밀번호}#{추신}',
    variables: [
      { name: '관리자이름', isRequired: true },
      { name: '임시비밀번호', isRequired: true },
      { name: '링크', isRequired: true, isButtonLink: true },
      { name: '추신' },
    ],
  };
  const values = {
    관리자이름: '이서준',
    임시비밀번호: 'x8Rk-2mPq',
    링크: 'https://erp.whale.test/login?token=t0ken',
  };

  it('제목과 본문의 자리를 모두 치환한다', () => {
    const mail = renderTemplate(template, values);

    expect(mail.subject).toBe('[WHALE ERP] 이서준 님 임시 비밀번호');
    expect(mail.body).toBe('이서준 님, 이서준 님\n\n임시 비밀번호: x8Rk-2mPq');
  });

  it('값은 이스케이프하지 않는다 — HTML 은 메일이 본문 전체를 이스케이프해 만든다', () => {
    const mail = renderTemplate(template, {
      ...values,
      관리자이름: `<b>"O'Neil" & co</b>`,
    });

    expect(mail.subject).toBe(
      `[WHALE ERP] <b>"O'Neil" & co</b> 님 임시 비밀번호`,
    );
    expect(mail.body).toContain(`<b>"O'Neil" & co</b> 님`);
  });

  it('제목이 null 이면 subject 와 maskedSubject 도 null 이다', () => {
    const talk = renderTemplate({ ...template, title: null }, values, [
      '임시비밀번호',
    ]);

    expect(talk.subject).toBeNull();
    expect(talk.maskedSubject).toBeNull();
    expect(talk.maskedBody).toContain(`임시 비밀번호: ${MASK}`);
  });

  it('값 안의 #{...} 는 다시 치환하지 않는다', () => {
    const mail = renderTemplate(template, {
      ...values,
      관리자이름: '#{임시비밀번호}',
    });

    expect(mail.body).toContain('#{임시비밀번호} 님');
    expect(mail.subject).toBe('[WHALE ERP] #{임시비밀번호} 님 임시 비밀번호');
  });

  it('넘기지 않은 선택 변수는 빈 문자열이고, 넘기면 값이 들어간다', () => {
    expect(renderTemplate(template, values).body.endsWith('x8Rk-2mPq')).toBe(
      true,
    );
    expect(
      renderTemplate(template, { ...values, 추신: '감사합니다' }).body.endsWith(
        'x8Rk-2mPq감사합니다',
      ),
    ).toBe(true);
  });

  it('필수 변수가 빠지면 이름을 담아 던진다. 빈 문자열은 값이다', () => {
    // 구조 분해로 빼면 버린 변수가 no-unused-vars 에 걸린다.
    const rest = { 관리자이름: values.관리자이름, 링크: values.링크 };

    expect(() => renderTemplate(template, rest)).toThrow('임시비밀번호');
    expect(() =>
      renderTemplate(template, { ...values, 임시비밀번호: '' }),
    ).not.toThrow();
  });

  it('필수 버튼 링크가 빠져도 던진다', () => {
    const rest = { 관리자이름: values.관리자이름, 임시비밀번호: 'x' };

    expect(() => renderTemplate(template, rest)).toThrow('링크');
  });

  it('템플릿에 없는 변수를 넘기면 던진다', () => {
    expect(() => renderTemplate(template, { ...values, 오타: 'x' })).toThrow(
      '오타',
    );
  });

  it('선언되지 않은 자리는 상속 속성을 값으로 쓰지 않고 던진다', () => {
    const broken = { ...template, body: '#{toString}' };

    expect(() => renderTemplate(broken, values)).toThrow('toString');
  });

  it('가림본은 지정한 변수만 MASK 로 바꾸고, 제목에도 적용한다', () => {
    const mail = renderTemplate(template, values, [
      '임시비밀번호',
      '관리자이름',
    ]);

    expect(mail.body).toContain('x8Rk-2mPq');
    expect(mail.maskedBody).toBe(
      `${MASK} 님, ${MASK} 님\n\n임시 비밀번호: ${MASK}`,
    );
    expect(mail.maskedSubject).toBe(`[WHALE ERP] ${MASK} 님 임시 비밀번호`);
  });

  it('가리지 않으면 가림본은 보낼 것과 같다', () => {
    const mail = renderTemplate(template, values);

    expect(mail.maskedBody).toBe(mail.body);
    expect(mail.maskedSubject).toBe(mail.subject);
  });

  it('버튼 링크 변수는 maskedVariables 에 없어도 가림본에서 가린다 — 링크에는 토큰이 들어간다', () => {
    const inBody = { ...template, body: '#{임시비밀번호} #{링크}' };

    const mail = renderTemplate(inBody, values);

    expect(mail.body).toBe(
      'x8Rk-2mPq https://erp.whale.test/login?token=t0ken',
    );
    expect(mail.maskedBody).toBe(`x8Rk-2mPq ${MASK}`);
  });

  it('links 는 넘긴 버튼 링크 값을 선언 순서로 담고, 비었거나 넘기지 않은 것은 뺀다', () => {
    const two = {
      ...template,
      variables: [
        ...template.variables,
        { name: '앱링크', isButtonLink: true },
        { name: '빈링크', isButtonLink: true },
      ],
    };

    expect(
      renderTemplate(two, { ...values, 빈링크: '', 앱링크: 'https://app' })
        .links,
    ).toEqual(['https://erp.whale.test/login?token=t0ken', 'https://app']);
    const noLink = {
      ...template,
      variables: template.variables.filter((v) => !v.isButtonLink),
    };
    expect(
      renderTemplate(noLink, { 관리자이름: 'a', 임시비밀번호: 'b' }).links,
    ).toEqual([]);
  });

  it('템플릿에 없는 가림 이름은 던진다 — 오타로 평문이 남지 않게', () => {
    expect(() => renderTemplate(template, values, ['임시비번'])).toThrow(
      '임시비번',
    );
  });

  it('오류 메시지에 값은 담지 않는다', () => {
    const run = () =>
      renderTemplate(template, { ...values, 오타: 'secret-value' });

    expect(run).toThrow('오타');
    expect(run).not.toThrow('secret-value');
  });
});
