import { validateNewPassword } from './password-policy';

// 명세: [API] 비밀번호 규칙과 변경(WHALEERP-192). 가입·내 정보 변경·재설정·관리자 초기화 링크가 같이 쓴다.
describe('validateNewPassword', () => {
  const email = 'Staff.Kim@example.com';
  const check = (password: string) => validateNewPassword(password, email);

  describe('문자 종류와 길이', () => {
    it('네 종류를 섞으면 8자부터 받는다', () => {
      expect(check('Abcde1!x')).toBeNull();
    });

    it('세 종류를 섞으면 8자부터 받는다', () => {
      expect(check('Abcdefg1')).toBeNull();
      expect(check('abcdef1!')).toBeNull();
    });

    it('세 종류 이상이어도 7자는 받지 않는다', () => {
      expect(check('Abcde1!')).not.toBeNull();
    });

    it('두 종류만 쓰면 10자부터 받는다', () => {
      expect(check('abcdefgh12')).toBeNull();
      expect(check('abcdefghi1')).toBeNull();
    });

    it('두 종류는 9자를 받지 않는다', () => {
      expect(check('abcdefgh1')).not.toBeNull();
    });

    it('한 종류만 쓰면 길이와 상관없이 받지 않는다', () => {
      expect(check('abcdefghijklmnop')).not.toBeNull();
      expect(check('12345678901234')).not.toBeNull();
    });

    it('20자까지 받고 21자는 받지 않는다', () => {
      expect(check('Abcdefghij1234567890')).toBeNull();
      expect(check('Abcdefghij12345678901')).not.toBeNull();
    });

    it('영문 대문자·소문자·숫자 말고는 모두 특수문자로 센다', () => {
      // 두 종류(소문자 + 특수)로 세어 10자 미만이면 거부, 10자면 통과.
      expect(check('abcdefgh!')).not.toBeNull();
      expect(check('abcdefghi!')).toBeNull();
      // 공백도 특수문자다.
      expect(check('abcdefghi ')).toBeNull();
    });
  });

  describe('아이디로 쓰는 이메일', () => {
    it('이메일과 같은 값은 받지 않는다 — 대소문자를 가리지 않는다', () => {
      expect(
        validateNewPassword('staff.kim@example.com', email),
      ).not.toBeNull();
      expect(
        validateNewPassword('STAFF.KIM@EXAMPLE.COM', email),
      ).not.toBeNull();
    });

    it('이메일의 앞부분을 그대로 쓴 값은 받지 않는다', () => {
      expect(
        validateNewPassword('Staff.Kim', 'Staff.Kim@example.com'),
      ).not.toBeNull();
      expect(
        validateNewPassword('staff.kim', 'Staff.Kim@example.com'),
      ).not.toBeNull();
    });

    it('앞부분이 들어 있어도 다른 값이 더해지면 받는다', () => {
      expect(
        validateNewPassword('Staff.Kim!2026', 'Staff.Kim@example.com'),
      ).toBeNull();
    });
  });

  it('거부하면 사유를 한국어 문장으로 준다', () => {
    const reason = check('abc');
    expect(typeof reason).toBe('string');
    expect(reason!.length).toBeGreaterThan(5);
  });

  it('사유는 어느 규칙에 걸렸는지 구분한다', () => {
    const reasons = new Set([
      check('abcdefghijklmnop'), // 한 종류
      check('Abcde1!'), // 세 종류인데 짧음
      check('abcdefgh1'), // 두 종류인데 짧음
      check('Abcdefghij12345678901'), // 길다
      check('staff.kim@example.com'), // 이메일
    ]);
    expect(reasons.size).toBe(5);
  });

  it('글자 수는 코드포인트로 센다 — 이모지 하나를 두 글자로 세지 않는다', () => {
    // 3 + 17 = 20자. UTF-16 단위로 세면 37 이라 20자 제한에 걸린다.
    expect(validateNewPassword(`Ab1${'😀'.repeat(17)}`, 'a@b.c')).toBeNull();
    expect(
      validateNewPassword(`Ab1${'😀'.repeat(18)}`, 'a@b.c'),
    ).not.toBeNull();
    // 3 + 4 = 7자. 단위로 세면 11 이라 8자 하한을 통과해 버린다.
    expect(validateNewPassword(`Ab1${'😀'.repeat(4)}`, 'a@b.c')).not.toBeNull();
  });
});
