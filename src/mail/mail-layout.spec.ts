import { bodyBlocks, mailHeading, mailHtml, sentences } from './mail.service';

describe('bodyBlocks', () => {
  it('「- 항목: 값」 줄은 정보 표로, 「※」 줄은 안내로, 나머지는 문단으로 나눈다', () => {
    const body = [
      '통합관리자 님의 관리자 계정이 만들어졌습니다.',
      '',
      '- 로그인 아이디: it1118a',
      '- 임시 비밀번호: R4b:KR5',
      '',
      '※ 처음 로그인할 때 비밀번호를 변경해 주세요.',
      '둘째 문단',
      '이어지는 줄',
    ].join('\n');
    expect(bodyBlocks(body)).toEqual([
      {
        kind: 'text',
        lines: ['통합관리자 님의 관리자 계정이 만들어졌습니다.'],
      },
      // 값 안의 콜론은 값에 남는다(첫 콜론에서만 가른다)
      {
        kind: 'info',
        rows: [
          ['로그인 아이디', 'it1118a'],
          ['임시 비밀번호', 'R4b:KR5'],
        ],
      },
      { kind: 'notice', lines: ['처음 로그인할 때 비밀번호를 변경해 주세요.'] },
      { kind: 'text', lines: ['둘째 문단', '이어지는 줄'] },
    ]);
  });

  it('콜론 없는 「- 」 줄 · 항목이 너무 긴 줄은 표가 아니라 문단이다', () => {
    const long = '- ' + '가'.repeat(31) + ': 값';
    expect(bodyBlocks(`- 그냥 목록\n${long}`)).toEqual([
      { kind: 'text', lines: ['- 그냥 목록', long] },
    ]);
  });

  it('줄바꿈이 CRLF 여도 같게 나눈다', () => {
    expect(bodyBlocks('첫 줄\r\n\r\n- 아이디: a')).toEqual([
      { kind: 'text', lines: ['첫 줄'] },
      { kind: 'info', rows: [['아이디', 'a']] },
    ]);
  });

  it('빈 본문은 블록이 없다', () => {
    expect(bodyBlocks('\n\n')).toEqual([]);
  });
});

describe('mailHeading', () => {
  it('앞의 [WHALE ERP] 를 뗀다. 떼고 남는 게 없으면 제목 그대로', () => {
    expect(mailHeading('[WHALE ERP] 관리자 계정 생성')).toBe(
      '관리자 계정 생성',
    );
    expect(mailHeading('[whale erp]신규 BP 가입')).toBe('신규 BP 가입');
    expect(mailHeading('급여명세서 발송')).toBe('급여명세서 발송');
    expect(mailHeading('[WHALE ERP]')).toBe('[WHALE ERP]');
  });
});

describe('sentences', () => {
  it('문장 끝(. ? !) 뒤 빈칸에서만 나눈다', () => {
    expect(
      sentences(
        '계정이 만들어졌습니다. 로그인해 주세요! 비밀번호는 바꾸셨나요? 끝',
      ),
    ).toEqual([
      '계정이 만들어졌습니다.',
      '로그인해 주세요!',
      '비밀번호는 바꾸셨나요?',
      '끝',
    ]);
  });

  it('3.3% · 1.5배 · 주소 · 닫는 따옴표', () => {
    expect(
      sentences('3.3% 원천징수입니다. https://a.b/c.d 를 여세요.'),
    ).toEqual(['3.3% 원천징수입니다.', 'https://a.b/c.d 를 여세요.']);
    expect(sentences('「저장」을 누르세요.」 다음')).toEqual([
      '「저장」을 누르세요.」',
      '다음',
    ]);
  });
});

describe('mailHtml', () => {
  it('문단 · 안내 상자의 글은 문장마다 줄을 바꾼다', () => {
    const html = mailHtml(
      '[WHALE ERP] 안내',
      '첫 문장입니다. 둘째 문장입니다.\n※ 안내 하나. 안내 둘.',
      [],
    );
    expect(html).toContain('첫 문장입니다.<br>둘째 문장입니다.</p>');
    expect(html).toContain('안내 하나.<br>안내 둘.</td>');
  });

  it('MAIL_LOGO_URL 이 있으면 띠에 로고 그림을 넣고, 값 · 제목 · 로고 주소를 모두 이스케이프한다', () => {
    const html = mailHtml(
      '[WHALE ERP] <b>제목</b>',
      '- 아이디: <script>x</script>',
      [],
      'https://erp.whale.test/mail/logo.png?a=1&b="2"',
    );
    expect(html).toContain(
      '<img src="https://erp.whale.test/mail/logo.png?a=1&amp;b=&quot;2&quot;"',
    );
    expect(html).toContain('&lt;b&gt;제목&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('정보 표 · 안내 상자를 그리고, 띠 · 버튼 색은 bgcolor 로도 적는다', () => {
    const html = mailHtml(
      '[WHALE ERP] 관리자 계정 생성',
      '- 로그인 아이디: it1118a\n※ 처음 로그인할 때 비밀번호를 변경해 주세요.',
      ['https://erp.whale.test/login'],
    );
    expect(html).toContain('>로그인 아이디</td>');
    expect(html).toContain('>it1118a</td>');
    expect(html).toContain('처음 로그인할 때 비밀번호를 변경해 주세요.</td>');
    expect(html).toContain('bgcolor="#282f37"');
    expect(html).toContain('bgcolor="#4a7ae0"');
  });
});
