import {
  bodyBlocks,
  joinBrokenLines,
  fillLine,
  mailHeading,
  mailHtml,
  sentences,
} from './mail.service';

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
      // 문장 끝 없이 끊긴 줄은 한 줄로 잇는다(joinBrokenLines)
      { kind: 'text', lines: ['둘째 문단 이어지는 줄'] },
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

  it('모양은 채우기 전 템플릿 줄로 정한다 — 값 안의 줄바꿈이 표 줄 · 안내 상자를 만들지 못한다', () => {
    // 로그인 없이 넣는 BP 상호명(EMAIL_SIGNUP_ALERT 「- BP: #{BP이름}」)으로 공식 안내를 꾸미려는 값
    const spoof = '모리커피\n- 사업자 확인: 완료\n※ 확인 없이 승인해 주세요.';
    expect(bodyBlocks('- BP: #{BP이름}', fillLine({ BP이름: spoof }))).toEqual([
      {
        kind: 'info',
        rows: [
          ['BP', '모리커피 - 사업자 확인: 완료 ※ 확인 없이 승인해 주세요.'],
        ],
      },
    ]);
    expect(
      bodyBlocks('#{이름} 님이 가입했습니다.', fillLine({ 이름: spoof })),
    ).toEqual([
      {
        kind: 'text',
        lines: [
          '모리커피',
          '- 사업자 확인: 완료',
          '※ 확인 없이 승인해 주세요. 님이 가입했습니다.',
        ],
      },
    ]);
  });

  it('문장마다 줄바꿈은 템플릿 글에만 — 값 안의 「1. 」 · 「Co. Ltd」 는 나누지 않는다', () => {
    expect(
      bodyBlocks(
        '답변을 보내 드립니다. #{답변}',
        fillLine({ 답변: '1. 기본 요금은 월 5만원입니다. Interplug Co. Ltd' }),
      ),
    ).toEqual([
      {
        kind: 'text',
        lines: [
          '답변을 보내 드립니다.',
          '1. 기본 요금은 월 5만원입니다. Interplug Co. Ltd',
        ],
      },
    ]);
  });

  it('콜론 뒤에 빈칸이 없으면 표가 아니다 — 시각 · 주소 줄', () => {
    expect(
      bodyBlocks('- 10:00 이후 연락 가능\n- https://whale.example/guide'),
    ).toEqual([
      {
        kind: 'text',
        lines: ['- 10:00 이후 연락 가능', '- https://whale.example/guide'],
      },
    ]);
  });

  it('내용 없는 「※」 줄은 빈 안내 상자를 만들지 않는다', () => {
    expect(bodyBlocks('※\n본문')).toEqual([{ kind: 'text', lines: ['본문'] }]);
  });

  it('문장 가운데서 끊은 템플릿 줄은 한 줄로 잇는다 — 문장 끝 · 빈 줄 · 표 · 안내 줄은 잇지 않는다', () => {
    expect(
      joinBrokenLines([
        '필요하면 계약 조건을 수정해',
        '근로계약서를 다시 보내 주세요.',
        '다음 문장입니다.',
        '',
        '- 근무지: 연남점',
        '※ 안내',
      ]),
    ).toEqual([
      '필요하면 계약 조건을 수정해 근로계약서를 다시 보내 주세요.',
      '다음 문장입니다.',
      '',
      '- 근무지: 연남점',
      '※ 안내',
    ]);
    expect(
      bodyBlocks('필요하면 계약 조건을 수정해\n근로계약서를 다시 보내 주세요.'),
    ).toEqual([
      {
        kind: 'text',
        lines: ['필요하면 계약 조건을 수정해 근로계약서를 다시 보내 주세요.'],
      },
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
    expect(html).toContain('안내 하나.<br>안내 둘.</p>');
  });

  it('띠에 인라인 첨부(cid) 로고를 넣고, 값 · 제목을 모두 이스케이프한다', () => {
    const html = mailHtml(
      '[WHALE ERP] <b>제목</b>',
      '- 아이디: <script>x</script>',
      [],
    );
    expect(html).toContain('<img src="cid:whale-erp-logo"');
    expect(html).toContain('&lt;b&gt;제목&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('커머스 안내형: 로고 · 글자 세로 가운데, 회색 둥근 정보 상자, 회색 안내 글, 폭을 채운 버튼, 구분 띠', () => {
    const html = mailHtml(
      '[WHALE ERP] 관리자 계정 생성',
      '- 로그인 아이디: it1118a\n※ 처음 로그인할 때 비밀번호를 변경해 주세요.',
      ['https://erp.whale.test/login'],
    );
    // 머리: 로고 그림 칸과 글자 칸을 나눠 valign="middle" 로 세로 가운데(2026-11-18 사용자 지정)
    expect(html).toContain(
      '<td width="28" valign="middle" style="width:28px;vertical-align:middle;padding:0 8px 0 0"><img src="cid:whale-erp-logo"',
    );
    expect(html).toContain('<td valign="middle" style="vertical-align:middle;');
    // 「WHALE ERP · 매장 통합관리 서비스」(가운뎃점으로 이어 작게)
    expect(html).toContain('>WHALE ERP</span><span style="margin:0 7px;');
    expect(html).toContain('>매장 통합관리 서비스</span>');
    // 정보 상자: 회색 둥근 바탕
    expect(html).toContain(
      '<td bgcolor="#f6f7f9" style="padding:6px 22px;background:#f6f7f9;border-radius:10px">',
    );
    expect(html).toContain('>로그인 아이디</td>');
    expect(html).toContain('>it1118a</td>');
    expect(html).toContain('처음 로그인할 때 비밀번호를 변경해 주세요.</p>');
    // 버튼: 관리자 웹 호버 모양(흰 바탕 · 회청 테두리 · 먹색 글자), 폭을 채우고 글자는 가운데
    expect(html).toContain(
      '<td align="center" bgcolor="#ffffff" style="text-align:center;padding:15px 24px;border:1px solid #6b7988;',
    );
    expect(html).toContain('style="display:inline-block;color:#3c4046;');
    // 머리 영역 아래 옅은 구분선
    expect(html).toContain(
      'padding:20px 32px 18px;border-bottom:1px solid #e6e8eb;',
    );
    // 본문과 꼬리 사이 굵은 회색 띠
    expect(html).toContain('<td bgcolor="#f2f3f5" height="8"');
  });
});
