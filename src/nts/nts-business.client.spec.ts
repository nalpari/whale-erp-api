import {
  NtsBusinessClient,
  NtsUnavailableError,
  type BizIdentity,
} from './nts-business.client';

const identity: BizIdentity = {
  bizRegistrationNumber: '1234567890',
  bizCeoName: '정하윤',
  bizOpenDate: '2020-03-02',
};

const respond = (body: unknown, status = 200) =>
  jest.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

describe('NtsBusinessClient', () => {
  it('국세청 validate 에 b_no · start_dt(하이픈 없이) · p_nm 을 POST 한다', async () => {
    const fetchFn = respond({ data: [{ valid: '01' }] });
    await new NtsBusinessClient('key', fetchFn).verify(identity);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(
      /^https:\/\/api\.odcloud\.kr\/api\/nts-businessman\/v1\/validate\?serviceKey=/,
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      businesses: [
        { b_no: '1234567890', start_dt: '20200302', p_nm: '정하윤' },
      ],
    });
    expect(init.signal).toBeDefined();
  });

  it('valid 01 은 MATCH, 02 는 MISMATCH', async () => {
    await expect(
      new NtsBusinessClient('key', respond({ data: [{ valid: '01' }] })).verify(
        identity,
      ),
    ).resolves.toBe('MATCH');
    await expect(
      new NtsBusinessClient('key', respond({ data: [{ valid: '02' }] })).verify(
        identity,
      ),
    ).resolves.toBe('MISMATCH');
  });

  it.each([{}, { data: [] }, { data: [{ valid: '03' }] }])(
    '200 이어도 data · valid 가 뜻밖이면 NtsUnavailableError: %p',
    async (body) => {
      await expect(
        new NtsBusinessClient('key', respond(body)).verify(identity),
      ).rejects.toBeInstanceOf(NtsUnavailableError);
    },
  );

  it('2XX 가 아니면 NtsUnavailableError', async () => {
    await expect(
      new NtsBusinessClient('key', respond({ msg: 'x' }, 500)).verify(identity),
    ).rejects.toBeInstanceOf(NtsUnavailableError);
  });

  it('fetch 가 실패(시간 초과 포함)하면 NtsUnavailableError', async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('t'), { name: 'TimeoutError' }),
      );
    await expect(
      new NtsBusinessClient('key', fetchFn).verify(identity),
    ).rejects.toBeInstanceOf(NtsUnavailableError);
  });

  it.each(['', undefined])(
    '키가 비어 있으면(%p) 부르지 않고 NtsUnavailableError',
    async (key) => {
      const fetchFn = respond({ data: [{ valid: '01' }] });
      await expect(
        new NtsBusinessClient(key, fetchFn).verify(identity),
      ).rejects.toBeInstanceOf(NtsUnavailableError);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('Decoding 키는 인코딩하고, % 가 든 Encoding 키는 그대로 쓴다', async () => {
    const decoded = respond({ data: [{ valid: '01' }] });
    await new NtsBusinessClient('a+b/c==', decoded).verify(identity);
    expect((decoded.mock.calls[0] as [string])[0]).toMatch(
      /serviceKey=a%2Bb%2Fc%3D%3D$/,
    );

    const encoded = respond({ data: [{ valid: '01' }] });
    await new NtsBusinessClient('a%2Bb', encoded).verify(identity);
    expect((encoded.mock.calls[0] as [string])[0]).toMatch(/serviceKey=a%2Bb$/);
  });

  const failure = async (client: NtsBusinessClient) =>
    (await client.verify(identity).catch((e: unknown) => e)) as Error;

  it('fetch 실패는 원인 코드를 남기되 키가 섞인 원래 메시지는 버린다', async () => {
    const fetchFn = jest.fn().mockRejectedValue(
      new TypeError(
        'fetch failed https://api.odcloud.kr/?serviceKey=secret-key',
        {
          cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
        },
      ),
    );
    const error = await failure(new NtsBusinessClient('secret-key', fetchFn));
    expect(error).toBeInstanceOf(NtsUnavailableError);
    expect(error.message).toContain('ENOTFOUND');
    expect(error.message).not.toContain('secret-key');
  });

  it('2XX 가 아니면 본문의 code · msg 를 남긴다 — 키 미등록 · 할당량 초과를 장애와 가르게', async () => {
    const error = await failure(
      new NtsBusinessClient(
        'key',
        respond({ code: -4, msg: '등록되지 않은 인증키 입니다.' }, 401),
      ),
    );
    expect(error.message).toContain('HTTP 401');
    expect(error.message).toContain('-4');
    expect(error.message).toContain('등록되지 않은 인증키');
  });

  it('200 인데 본문이 JSON 이 아니면 그렇다고 남긴다', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      new Response('<OpenAPI_ServiceResponse>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      }),
    );
    const error = await failure(new NtsBusinessClient('key', fetchFn));
    expect(error).toBeInstanceOf(NtsUnavailableError);
    expect(error.message).toContain('JSON');
    expect(error.message).toContain('text/xml');
  });

  it('2XX 가 아닌 본문의 원문은 남기지 않는다 — 오류 페이지가 요청 주소(키)를 되비출 수 있다', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      new Response('<html>GET /validate?serviceKey=secret-key</html>', {
        status: 502,
      }),
    );
    const error = await failure(new NtsBusinessClient('secret-key', fetchFn));
    expect(error.message).toContain('HTTP 502');
    expect(error.message).not.toContain('secret-key');
  });

  it('오류 메시지에 키를 넣지 않는다', async () => {
    const error = (await new NtsBusinessClient('secret-key', respond({}, 500))
      .verify(identity)
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NtsUnavailableError);
    expect(error.message).not.toContain('secret-key');
  });

  it('키가 있어야 isConfigured — 빈 키는 없는 것이다(공백은 NtsModule 이 지운다)', () => {
    expect(new NtsBusinessClient('key').isConfigured).toBe(true);
    expect(new NtsBusinessClient(undefined).isConfigured).toBe(false);
    expect(new NtsBusinessClient('').isConfigured).toBe(false);
  });
});
