import { BizppurioClient, BizppurioError } from './bizppurio.client';
import type { BizppurioConfig } from './bizppurio.config';

const config: BizppurioConfig = {
  baseUrl: 'https://dev-api.bizppurio.com',
  account: 'whale',
  password: 'secret',
  senderKey: 'sender-key',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// 비즈뿌리오 만료 시각은 KST 의 YYYYMMDDHHmmss 다.
const token = (accesstoken: string, expired = '20261007120000') =>
  json(200, { accesstoken, type: 'Bearer', expired });
const accepted = () =>
  json(200, {
    code: 1000,
    description: 'success',
    refkey: 'ref',
    messagekey: 'mk',
  });

const message = {
  account: 'whale',
  type: 'at' as const,
  refkey: 'ref',
  to: '01012345678',
  content: {
    at: { senderkey: 'sender-key', templatecode: 'T1', message: 'hi' },
  },
};

describe('BizppurioClient', () => {
  let fetchFn: jest.Mock<Promise<Response>, [string, RequestInit]>;
  // 2026-10-07 09:00 KST — 토큰 만료(12:00 KST) 3시간 전
  let now = new Date('2026-10-07T00:00:00Z');
  let client: BizppurioClient;

  beforeEach(() => {
    fetchFn = jest.fn<Promise<Response>, [string, RequestInit]>();
    now = new Date('2026-10-07T00:00:00Z');
    client = new BizppurioClient(config, fetchFn, () => now);
  });

  const urls = () => fetchFn.mock.calls.map(([url]) => url);
  const headerOf = (i: number) =>
    (fetchFn.mock.calls[i][1].headers as Record<string, string>).Authorization;

  it('Basic 인증으로 토큰을 받아 Bearer 로 발송하고 응답을 돌려준다', async () => {
    fetchFn
      .mockResolvedValueOnce(token('t1'))
      .mockResolvedValueOnce(accepted());

    await expect(client.sendMessage(message)).resolves.toMatchObject({
      code: 1000,
      messagekey: 'mk',
    });
    expect(urls()).toEqual([
      'https://dev-api.bizppurio.com/v1/token',
      'https://dev-api.bizppurio.com/v3/message',
    ]);
    expect(headerOf(0)).toBe(
      `Basic ${Buffer.from('whale:secret').toString('base64')}`,
    );
    expect(headerOf(1)).toBe('Bearer t1');
    expect(JSON.parse(fetchFn.mock.calls[1][1].body as string)).toEqual(
      message,
    );
  });

  it('토큰을 캐시해 두 번째 발송에서는 다시 받지 않는다', async () => {
    fetchFn
      .mockResolvedValueOnce(token('t1'))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(accepted());

    await client.sendMessage(message);
    await client.sendMessage(message);

    expect(urls().filter((u) => u.endsWith('/v1/token'))).toHaveLength(1);
  });

  it('만료 10분 전부터는 토큰을 새로 받는다', async () => {
    fetchFn
      .mockResolvedValueOnce(token('t1'))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(token('t2'))
      .mockResolvedValueOnce(accepted());

    await client.sendMessage(message);
    now = new Date('2026-10-07T02:50:00Z'); // 11:50 KST
    await client.sendMessage(message);

    expect(headerOf(3)).toBe('Bearer t2');
  });

  it('동시에 발송해도 토큰은 한 번만 받는다', async () => {
    fetchFn.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/v1/token') ? token('t1') : accepted()),
    );

    await Promise.all([
      client.sendMessage(message),
      client.sendMessage(message),
    ]);

    expect(urls().filter((u) => u.endsWith('/v1/token'))).toHaveLength(1);
  });

  it('토큰 무효(3002)면 새 토큰으로 한 번만 다시 보낸다', async () => {
    fetchFn
      .mockResolvedValueOnce(token('t1'))
      .mockResolvedValueOnce(json(401, { code: 3002, description: 'invalid' }))
      .mockResolvedValueOnce(token('t2'))
      .mockResolvedValueOnce(accepted());

    await expect(client.sendMessage(message)).resolves.toMatchObject({
      messagekey: 'mk',
    });
    expect(headerOf(3)).toBe('Bearer t2');
  });

  it('재시도에서도 3002 면 더 시도하지 않고 던진다', async () => {
    fetchFn
      .mockResolvedValueOnce(token('t1'))
      .mockResolvedValueOnce(json(401, { code: 3002 }))
      .mockResolvedValueOnce(token('t2'))
      .mockResolvedValueOnce(json(401, { code: 3002 }));

    await expect(client.sendMessage(message)).rejects.toMatchObject({
      code: 3002,
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('HTTP 200 이어도 code 가 1000 이 아니면 그 코드로 던진다', async () => {
    fetchFn
      .mockResolvedValueOnce(token('t1'))
      .mockResolvedValueOnce(json(200, { code: 2000, description: 'bad' }));

    const error = await client.sendMessage(message).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BizppurioError);
    expect(error).toMatchObject({ code: 2000, httpStatus: 200 });
    // 템플릿 불일치 같은 구체적 사유는 description 에만 있다.
    expect((error as Error).message).toContain('bad');
  });

  it('메시지 단계의 네트워크 오류·타임아웃은 다시 보내지 않는다', async () => {
    // 이미 접수됐을 수 있어, 다시 보내면 같은 알림톡이 두 번 간다.
    fetchFn
      .mockResolvedValueOnce(token('t1'))
      .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));

    await expect(client.sendMessage(message)).rejects.toBeInstanceOf(
      BizppurioError,
    );
    expect(urls()).toEqual([
      'https://dev-api.bizppurio.com/v1/token',
      'https://dev-api.bizppurio.com/v3/message',
    ]);
  });

  it('본문을 읽다 끊기면 본문 없음이 아니라 그 원인으로 던진다', async () => {
    const cause = new DOMException('timeout', 'TimeoutError');
    const broken = new Response(
      new ReadableStream({ start: (c) => c.error(cause) }),
      { status: 200 },
    );
    fetchFn.mockResolvedValueOnce(token('t1')).mockResolvedValueOnce(broken);

    const error = await client.sendMessage(message).catch((e: unknown) => e);

    expect(error).toMatchObject({
      name: 'BizppurioError',
      code: undefined,
      httpStatus: 200,
      cause,
    });
    expect((error as Error).message).not.toContain('no body');
  });

  it('토큰 발급 실패는 응답 코드와 HTTP 상태를 담아 던진다', async () => {
    fetchFn.mockResolvedValueOnce(json(401, { code: 3001, description: 'x' }));

    await expect(client.sendMessage(message)).rejects.toMatchObject({
      code: 3001,
      httpStatus: 401,
    });
  });

  it('HTTP 200 이어도 토큰이 없으면 발송하지 않고 그 코드로 던진다', async () => {
    fetchFn.mockResolvedValueOnce(json(200, { code: 3001, description: 'x' }));

    await expect(client.sendMessage(message)).rejects.toMatchObject({
      name: 'BizppurioError',
      code: 3001,
      httpStatus: 200,
    });
    expect(urls()).toEqual(['https://dev-api.bizppurio.com/v1/token']);
  });

  it('네트워크 오류는 코드 없이 BizppurioError 로 감싼다', async () => {
    fetchFn.mockRejectedValueOnce(new TypeError('fetch failed'));

    const error = await client.sendMessage(message).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BizppurioError);
    expect(error).toMatchObject({ code: undefined, httpStatus: undefined });
    // ECONNREFUSED·인증서 오류 같은 진짜 원인은 cause 에 있다.
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it('토큰 발급이 실패하면 다음 호출에서 다시 받는다', async () => {
    fetchFn
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(token('t1'))
      .mockResolvedValueOnce(accepted());

    await expect(client.sendMessage(message)).rejects.toBeInstanceOf(
      BizppurioError,
    );
    await expect(client.sendMessage(message)).resolves.toMatchObject({
      code: 1000,
    });
  });

  it('응답이 늦으면 끊도록 요청마다 timeout signal 을 건다', async () => {
    fetchFn
      .mockResolvedValueOnce(token('t1'))
      .mockResolvedValueOnce(accepted());

    await client.sendMessage(message);

    for (const [, init] of fetchFn.mock.calls)
      expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
