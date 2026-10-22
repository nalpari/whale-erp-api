import { assertUtcSessionTimeZone } from './pg-session-timezone';

describe('assertUtcSessionTimeZone — 부팅 때 세션 시간대 확인', () => {
  it('UTC 면 통과', () => {
    expect(() => assertUtcSessionTimeZone('UTC')).not.toThrow();
    expect(() => assertUtcSessionTimeZone('Etc/UTC')).not.toThrow();
  });

  it('UTC 가 아니면 실제 값과 고칠 곳을 담아 던진다', () => {
    expect(() => assertUtcSessionTimeZone('Asia/Seoul')).toThrow(
      /세션 TimeZone 이 'Asia\/Seoul' 다/,
    );
    expect(() => assertUtcSessionTimeZone('Asia/Seoul')).toThrow(
      /\(1\) DATABASE_URL 에 \?options= 가 있으면 .*빼거나 그 안에 -c TimeZone=UTC 를 넣는다\./,
    );
    expect(() => assertUtcSessionTimeZone('Asia/Seoul')).toThrow(
      /\(2\) 서버 · 풀러가 시작 옵션을 무시하면 DB 기본 timezone 을 UTC 로 둔다\./,
    );
  });

  it('값을 못 읽으면 (읽지 못함) 으로 보인다', () => {
    expect(() => assertUtcSessionTimeZone(undefined)).toThrow(
      /세션 TimeZone 이 \(읽지 못함\) 다/,
    );
    expect(() => assertUtcSessionTimeZone(undefined)).not.toThrow(/undefined/);
  });

  it('오류 메시지에 연결 URL · 비밀번호를 싣지 않는다', () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://user:s3cret@db.example:5432/whale';
    try {
      let message = '';
      try {
        assertUtcSessionTimeZone('Asia/Seoul');
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/세션 TimeZone/);
      expect(message).not.toMatch(/s3cret|db\.example|postgresql:/);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});
