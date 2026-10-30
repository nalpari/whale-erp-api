import {
  alimtalkButtonNameOf,
  alimtalkButtonProblem,
} from './alimtalk-buttons';

describe('alimtalk-buttons', () => {
  it('정해진 템플릿 코드의 버튼 이름 — 없거나 상속 키면 undefined', () => {
    expect(alimtalkButtonNameOf('TALK_STAFF_INVITATION')).toBe('가입하기');
    expect(alimtalkButtonNameOf('TALK_STAFF_AFFILIATION_REQUEST')).toBe(
      '요청 확인하기',
    );
    expect(alimtalkButtonNameOf('TALK_X')).toBeUndefined();
    expect(alimtalkButtonNameOf('toString')).toBeUndefined();
  });

  it('버튼 링크가 없으면 문제없고, 하나면 이름이 있어야 하고, 둘 이상이면 안 된다', () => {
    const link = { isButtonLink: true };
    expect(alimtalkButtonProblem('TALK_X', [{}])).toBeNull();
    expect(
      alimtalkButtonProblem('TALK_STAFF_INVITATION', [{}, link]),
    ).toBeNull();
    expect(alimtalkButtonProblem('TALK_X', [link])).toBe('NO_BUTTON_NAME');
    expect(alimtalkButtonProblem('TALK_STAFF_INVITATION', [link, link])).toBe(
      'MULTIPLE_LINKS',
    );
  });
});
