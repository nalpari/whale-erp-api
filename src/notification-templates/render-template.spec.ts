import { renderTemplate } from './render-template';

describe('renderTemplate', () => {
  it('#{변수} 를 값으로 바꾼다', () => {
    expect(
      renderTemplate('#{name}님 #{date}', { name: 'a', date: 'b' }, 'T1'),
    ).toBe('a님 b');
  });

  it('값 안의 #{...} 는 다시 치환하지 않는다', () => {
    expect(
      renderTemplate('#{name} #{date}', { name: '#{date}', date: 'x' }, 'T1'),
    ).toBe('#{date} x');
  });

  it('비어 있는 변수가 있으면 이름을 모두 담아 던진다', () => {
    expect(() => renderTemplate('#{a} #{b} #{c}', { b: 'x' }, 'T1')).toThrow(
      /T1 .*a, c/,
    );
  });
});
