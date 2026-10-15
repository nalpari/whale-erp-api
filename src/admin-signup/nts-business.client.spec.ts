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

  it('오류 메시지에 키를 넣지 않는다', async () => {
    const error = (await new NtsBusinessClient('secret-key', respond({}, 500))
      .verify(identity)
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NtsUnavailableError);
    expect(error.message).not.toContain('secret-key');
  });
});
