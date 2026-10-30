import { alimtalkButtonOf, alimtalkButtonProblem } from './alimtalk-buttons';

describe('alimtalk-buttons', () => {
  it('버튼을 다는 템플릿 코드의 버튼 이름 · 링크 변수 — 없거나 상속 키면 undefined', () => {
    expect(alimtalkButtonOf('TALK_STAFF_INVITATION')).toEqual({
      name: '가입하기',
      link: '링크',
    });
    expect(alimtalkButtonOf('TALK_STAFF_AFFILIATION_REQUEST')).toEqual({
      name: '요청 확인하기',
      link: '링크',
    });
    expect(alimtalkButtonOf('TALK_X')).toBeUndefined();
    expect(alimtalkButtonOf('toString')).toBeUndefined();
  });

  it('버튼을 다는 템플릿은 정해진 링크 변수 하나에만 버튼 링크 표시가 있어야 한다', () => {
    const code = 'TALK_STAFF_INVITATION';
    const link = { name: '링크', isButtonLink: true };
    expect(
      alimtalkButtonProblem(code, [{ name: '초대코드' }, link]),
    ).toBeNull();
    // 표시가 없음 · 다른 변수로 옮김 · 둘 이상(api #219 리뷰)
    expect(alimtalkButtonProblem(code, [{ name: '링크' }])).toEqual({
      kind: 'LINK_MISMATCH',
      link: '링크',
      marked: [],
    });
    expect(
      alimtalkButtonProblem(code, [
        { name: '링크' },
        { name: '초대코드', isButtonLink: true },
      ]),
    ).toEqual({ kind: 'LINK_MISMATCH', link: '링크', marked: ['초대코드'] });
    expect(
      alimtalkButtonProblem(code, [
        link,
        { name: '근무지', isButtonLink: true },
      ]),
    ).toEqual({
      kind: 'LINK_MISMATCH',
      link: '링크',
      marked: ['링크', '근무지'],
    });
  });

  it('버튼을 달지 않는 템플릿에는 버튼 링크 변수가 없어야 한다', () => {
    expect(alimtalkButtonProblem('TALK_X', [{ name: 'a' }])).toBeNull();
    expect(
      alimtalkButtonProblem('TALK_X', [{ name: 'a', isButtonLink: true }]),
    ).toEqual({ kind: 'NO_BUTTON_NAME', marked: ['a'] });
  });
});
