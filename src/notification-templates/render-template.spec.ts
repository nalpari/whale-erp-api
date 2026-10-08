import { MASK, type TemplateSource, renderTemplate } from './render-template';

describe('renderTemplate', () => {
  const template: TemplateSource = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    title: '[WHALE ERP] #{관리자이름} 님 임시 비밀번호',
    body: '<p>#{관리자이름} 님, #{관리자이름} 님</p><p>#{임시비밀번호}</p><a href="#{링크}">바로가기</a>#{추신}',
    variables: [
      { name: '관리자이름', isRequired: true },
      { name: '임시비밀번호', isRequired: true },
      { name: '링크', isRequired: true },
      { name: '추신' },
    ],
  };
  const values = {
    관리자이름: '이서준',
    임시비밀번호: 'x8Rk-2mPq',
    링크: 'https://erp.whale.test/login',
  };
  // 메일처럼 본문을 이스케이프하는 렌더
  const html = (
    t: TemplateSource,
    v: Record<string, string>,
    masked?: readonly string[],
  ) => renderTemplate(t, v, masked, { escapeBody: true });

  it('제목과 본문의 자리를 모두 치환한다', () => {
    const mail = html(template, values);

    expect(mail.subject).toBe('[WHALE ERP] 이서준 님 임시 비밀번호');
    expect(mail.body).toBe(
      '<p>이서준 님, 이서준 님</p><p>x8Rk-2mPq</p><a href="https://erp.whale.test/login">바로가기</a>',
    );
  });

  it('escapeBody 면 본문 값은 HTML 이스케이프하고 제목 값은 그대로 둔다', () => {
    const mail = html(template, {
      ...values,
      관리자이름: `<b>"O'Neil" & co</b>`,
    });

    expect(mail.subject).toBe(
      `[WHALE ERP] <b>"O'Neil" & co</b> 님 임시 비밀번호`,
    );
    expect(mail.body).toContain(
      '<p>&lt;b&gt;&quot;O&#39;Neil&quot; &amp; co&lt;/b&gt; 님',
    );
  });

  it('escapeBody 를 주지 않으면 본문 값도 그대로 넣는다', () => {
    const talk = renderTemplate(template, {
      ...values,
      관리자이름: '<b>A & B</b>',
    });

    expect(talk.body).toContain('<p><b>A & B</b> 님');
  });

  it('제목이 null 이면 subject 와 maskedSubject 도 null 이다', () => {
    const talk = renderTemplate({ ...template, title: null }, values, [
      '임시비밀번호',
    ]);

    expect(talk.subject).toBeNull();
    expect(talk.maskedSubject).toBeNull();
    expect(talk.maskedBody).toContain(`<p>${MASK}</p>`);
  });

  it('속성 안에 들어가는 값의 따옴표가 속성을 깨지 못한다', () => {
    const mail = html(template, {
      ...values,
      링크: 'https://x.test/" onclick="alert(1)',
    });

    expect(mail.body).toContain(
      '<a href="https://x.test/&quot; onclick=&quot;alert(1)">',
    );
  });

  it('값 안의 #{...} 는 다시 치환하지 않는다', () => {
    const mail = html(template, {
      ...values,
      관리자이름: '#{임시비밀번호}',
    });

    expect(mail.body).toContain('<p>#{임시비밀번호} 님');
    expect(mail.subject).toBe('[WHALE ERP] #{임시비밀번호} 님 임시 비밀번호');
  });

  it('넘기지 않은 선택 변수는 빈 문자열이고, 넘기면 값이 들어간다', () => {
    expect(html(template, values).body.endsWith('</a>')).toBe(true);
    expect(
      html(template, { ...values, 추신: '감사합니다' }).body.endsWith(
        '</a>감사합니다',
      ),
    ).toBe(true);
  });

  it('필수 변수가 빠지면 이름을 담아 던진다. 빈 문자열은 값이다', () => {
    // 구조 분해로 빼면 버린 변수가 no-unused-vars 에 걸린다.
    const rest = { 관리자이름: values.관리자이름, 링크: values.링크 };

    expect(() => html(template, rest)).toThrow('임시비밀번호');
    expect(() => html(template, { ...values, 임시비밀번호: '' })).not.toThrow();
  });

  it('템플릿에 없는 변수를 넘기면 던진다', () => {
    expect(() => html(template, { ...values, 오타: 'x' })).toThrow('오타');
  });

  it('선언되지 않은 자리는 상속 속성을 값으로 쓰지 않고 던진다', () => {
    const broken = { ...template, body: '<p>#{toString}</p>' };

    expect(() => html(broken, values)).toThrow('toString');
  });

  it('가림본은 지정한 변수만 MASK 로 바꾸고, 제목에도 적용한다', () => {
    const mail = html(template, values, ['임시비밀번호', '관리자이름']);

    expect(mail.body).toContain('<p>x8Rk-2mPq</p>');
    expect(mail.maskedBody).toBe(
      `<p>${MASK} 님, ${MASK} 님</p><p>${MASK}</p><a href="https://erp.whale.test/login">바로가기</a>`,
    );
    expect(mail.maskedSubject).toBe(`[WHALE ERP] ${MASK} 님 임시 비밀번호`);
  });

  it('가리지 않으면 가림본은 보낼 것과 같다', () => {
    const mail = html(template, values);

    expect(mail.maskedBody).toBe(mail.body);
    expect(mail.maskedSubject).toBe(mail.subject);
  });

  it('템플릿에 없는 가림 이름은 던진다 — 오타로 평문이 남지 않게', () => {
    expect(() => html(template, values, ['임시비번'])).toThrow('임시비번');
  });

  it('오류 메시지에 값은 담지 않는다', () => {
    const run = () => html(template, { ...values, 오타: 'secret-value' });

    expect(run).toThrow('오타');
    expect(run).not.toThrow('secret-value');
  });
});
