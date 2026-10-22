import {
  assertUtcSessionTimeZone,
  pgConnectionConfig,
  withUtcTimeZone,
} from './pg-session-timezone';

// pg 가 실제로 쓰는 병합(connection-parameters.js: config 위에 connectionString 을 덮어쓴다)으로 확인한다.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ConnectionParameters = require('pg/lib/connection-parameters') as new (
  config: object,
) => {
  options?: string;
  host?: string;
  database?: string;
  password?: string;
};

const BASE = 'postgresql://u:p%40ss@localhost:5432/whale';

describe('withUtcTimeZone — 연결 options 에 TimeZone=UTC 를 덧붙인다', () => {
  it('options 가 없으면 UTC 하나', () => {
    expect(withUtcTimeZone(undefined)).toBe('-c TimeZone=UTC');
    expect(withUtcTimeZone('')).toBe('-c TimeZone=UTC');
  });

  it('search_path 만 있으면 그대로 두고 뒤에 UTC', () => {
    expect(withUtcTimeZone('-c search_path=public')).toBe(
      '-c search_path=public -c TimeZone=UTC',
    );
  });

  it('TimeZone 이 다른 값이면 빼고 UTC 로 — -c 띄움 · -c 붙임 · -- 형식, 이름 대소문자 무관', () => {
    expect(
      withUtcTimeZone('-c TimeZone=Asia/Seoul -c search_path=public'),
    ).toBe('-c search_path=public -c TimeZone=UTC');
    expect(withUtcTimeZone('-ctimezone=Asia/Seoul')).toBe('-c TimeZone=UTC');
    expect(withUtcTimeZone('--TIMEZONE=Asia/Seoul -c work_mem=4MB')).toBe(
      '-c work_mem=4MB -c TimeZone=UTC',
    );
  });

  it('이미 UTC 면 한 번만 남는다', () => {
    expect(withUtcTimeZone('-c TimeZone=UTC')).toBe('-c TimeZone=UTC');
  });

  it('역슬래시로 띄운 값은 한 덩어리로 지킨다', () => {
    expect(withUtcTimeZone('-c application_name=a\\ b')).toBe(
      '-c application_name=a\\ b -c TimeZone=UTC',
    );
  });
});

describe('pgConnectionConfig — URL options 가 덮어써도 UTC 가 남는다', () => {
  const effective = (url: string | undefined) =>
    new ConnectionParameters(pgConnectionConfig(url));

  it('URL 에 options 가 없으면 URL 은 그대로, options 로 UTC', () => {
    const config = pgConnectionConfig(BASE);
    expect(config).toEqual({
      connectionString: BASE,
      options: '-c TimeZone=UTC',
    });
    expect(effective(BASE).options).toBe('-c TimeZone=UTC');
  });

  it('URL 이 search_path 만 주면 그 값에 UTC 를 덧붙인다 — pg 는 URL 의 options 를 config 보다 앞세우므로', () => {
    const url = `${BASE}?options=-c%20search_path%3Dpublic&sslmode=disable`;
    const params = effective(url);
    expect(params.options).toBe('-c search_path=public -c TimeZone=UTC');
    expect(params.host).toBe('localhost');
    expect(params.database).toBe('whale');
    expect(params.password).toBe('p@ss');
  });

  it('URL 에 TimeZone 이 다른 값이면 UTC 로 바꾼다', () => {
    const url = `${BASE}?options=${encodeURIComponent('-c TimeZone=Asia/Seoul')}`;
    expect(effective(url).options).toBe('-c TimeZone=UTC');
  });

  it('URL 에 이미 UTC 면 한 번만', () => {
    const url = `${BASE}?options=${encodeURIComponent('-c TimeZone=UTC')}`;
    expect(effective(url).options).toBe('-c TimeZone=UTC');
  });

  // pg 가 원래 URL 을 읽은 결과와 options 말고는 같아야 한다(비밀번호는 열거되지 않는 속성이라 따로 본다).
  const sameAsPgExceptOptions = (url: string) => {
    const ours = effective(url) as unknown as Record<string, unknown>;
    const pgs = new ConnectionParameters({
      connectionString: url,
    }) as unknown as Record<string, unknown>;
    expect({ ...ours, options: null }).toEqual({ ...pgs, options: null });
    expect(ours.password).toBe(pgs.password);
  };

  it('빈 호스트 + ?host= 소켓 URL 은 options 가 없으면 그대로 넘긴다 — new URL() 로 다시 읽지 않는다', () => {
    const url = 'postgresql://u:p@/db?host=/var/run/postgresql';
    expect(pgConnectionConfig(url)).toEqual({
      connectionString: url,
      options: '-c TimeZone=UTC',
    });
    const params = effective(url);
    expect(params.host).toBe('/var/run/postgresql');
    expect(params.options).toBe('-c TimeZone=UTC');
  });

  it('libpq 소켓 형식(/경로 db)도 그대로 넘긴다', () => {
    const url = '/var/run/postgresql whale';
    expect(pgConnectionConfig(url).connectionString).toBe(url);
    const params = effective(url);
    expect(params.host).toBe('/var/run/postgresql');
    expect(params.database).toBe('whale');
    expect(params.options).toBe('-c TimeZone=UTC');
  });

  it('빈 호스트 소켓 URL 에 options 가 있으면 pg 와 같은 파서로 읽어 options 만 바꾼다', () => {
    const url =
      'postgresql://u:p%40ss@/db?host=/var/run/postgresql&options=-c%20search_path%3Dpublic';
    expect(effective(url).options).toBe(
      '-c search_path=public -c TimeZone=UTC',
    );
    expect(effective(url).host).toBe('/var/run/postgresql');
    sameAsPgExceptOptions(url);
  });

  it('options 를 바꿔도 나머지 연결 값은 pg 가 원래 URL 을 읽은 것과 같다', () => {
    sameAsPgExceptOptions(
      `${BASE}?options=-c%20search_path%3Dpublic&application_name=whale`,
    );
  });

  it('DATABASE_URL 이 없으면 options 만 — 연결 실패는 pg 가 낸다', () => {
    expect(pgConnectionConfig(undefined)).toEqual({
      connectionString: undefined,
      options: '-c TimeZone=UTC',
    });
  });
});

describe('assertUtcSessionTimeZone — 부팅 때 세션 시간대 확인', () => {
  it('UTC 면 통과', () => {
    expect(() => assertUtcSessionTimeZone('UTC')).not.toThrow();
    expect(() => assertUtcSessionTimeZone('Etc/UTC')).not.toThrow();
  });

  it('UTC 가 아니면 이유를 담아 던진다', () => {
    expect(() => assertUtcSessionTimeZone('Asia/Seoul')).toThrow(
      /TimeZone 이 UTC 가 아니라 'Asia\/Seoul'/,
    );
    expect(() => assertUtcSessionTimeZone(undefined)).toThrow(/UTC 가 아니라/);
  });
});
