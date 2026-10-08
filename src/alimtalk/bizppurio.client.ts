import type { BizppurioConfig } from './bizppurio.config';

/**
 * 비즈뿌리오 호출 실패. `code` 는 비즈뿌리오 응답 코드(1000 성공, 2000 메시지
 * 오류, 3001 계정 오류, 3002 토큰 무효 …), `httpStatus` 는 HTTP 상태다.
 * 응답을 받기 전에 실패하면(네트워크, 타임아웃) 둘 다 없다. 헤더를 받은 뒤
 * 본문을 읽다 끊기면 `httpStatus` 만 있다. 어느 쪽이든 원인은 `cause` 에 있다.
 */
export class BizppurioError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly httpStatus?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BizppurioError';
  }
}

/**
 * POST /v3/message 요청 본문. 지금은 알림톡(at)만 보낸다. `resend` · `recontent` 를
 * 넣으면 알림톡이 실패했을 때 비즈뿌리오가 문자로 대신 보낸다. 그때 `from` 이
 * 발신번호다(사전 등록 번호).
 */
export type BizppurioMessage = {
  account: string;
  type: 'at';
  refkey: string;
  from?: string;
  to: string;
  content: {
    at: {
      senderkey: string;
      templatecode: string;
      message: string;
      title?: string;
    };
  };
  resend?: { first: 'sms' | 'lms' };
  recontent?: {
    /** EUC-KR 90바이트까지 */
    sms?: { message: string };
    /** 제목 64바이트 · 본문 2000바이트까지 */
    lms?: { subject: string; message: string };
  };
};

export type BizppurioSendResponse = {
  code: number;
  description?: string;
  refkey?: string;
  messagekey?: string;
};

type IssuedToken = { accesstoken: string; expired: string };

const SUCCESS = 1000;
const TOKEN_INVALID = 3002;
// 토큰은 24시간 유효하다. 만료 직전에 보낸 요청이 도중에 3002 를 받지 않게
// 10분 앞서 새로 받는다.
const REFRESH_BEFORE_MS = 10 * 60_000;
// 기본 fetch(undici)는 헤더와 본문을 각각 5분까지 기다려, 비즈뿌리오가 멈추면
// 호출부도 그만큼 묶인다.
const TIMEOUT_MS = 30_000;

/**
 * 비즈뿌리오 REST API 래퍼. 토큰 발급·캐시·재발급을 여기서 감추고, 호출부는
 * 보낼 메시지만 넘긴다.
 */
export class BizppurioClient {
  private token?: { value: string; expiresAt: number };
  // 동시 요청이 몰려도 발급은 한 번만 하도록 진행 중인 발급을 공유한다.
  private issuing?: Promise<string>;

  constructor(
    private readonly config: BizppurioConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 메시지를 접수시킨다. 접수(code 1000)가 아니면 BizppurioError 를 던진다. */
  async sendMessage(message: BizppurioMessage): Promise<BizppurioSendResponse> {
    try {
      return await this.postMessage(message, await this.getToken());
    } catch (e) {
      // 3002 는 토큰만 새로 받으면 풀린다. 한 번만 다시 시도한다.
      // 3001(계정 오류)은 재발급으로 풀리지 않으니 여기서 다루지 않는다.
      if (!(e instanceof BizppurioError) || e.code !== TOKEN_INVALID) throw e;
      this.token = undefined;
      return this.postMessage(message, await this.getToken());
    }
  }

  private async postMessage(
    message: BizppurioMessage,
    token: string,
  ): Promise<BizppurioSendResponse> {
    const response = await this.request<BizppurioSendResponse>(
      '/v3/message',
      `Bearer ${token}`,
      message,
    );
    if (response.code !== SUCCESS)
      throw new BizppurioError(
        `sendMessage failed: code=${response.code} description=${response.description}`,
        response.code,
        200,
      );
    return response;
  }

  private getToken(): Promise<string> {
    if (
      this.token &&
      this.now().getTime() < this.token.expiresAt - REFRESH_BEFORE_MS
    )
      return Promise.resolve(this.token.value);
    this.issuing ??= this.issueToken().finally(() => {
      this.issuing = undefined;
    });
    return this.issuing;
  }

  private async issueToken(): Promise<string> {
    const basic = Buffer.from(
      `${this.config.account}:${this.config.password}`,
    ).toString('base64');
    const issued = await this.request<IssuedToken & { code?: number }>(
      '/v1/token',
      `Basic ${basic}`,
    );
    // 200 에 오류 코드만 실려 오면 토큰 없이 캐시돼 `Bearer undefined` 로 나간다.
    if (!issued.accesstoken)
      throw new BizppurioError('/v1/token returned no token', issued.code, 200);
    this.token = {
      value: issued.accesstoken,
      expiresAt: parseExpired(issued.expired),
    };
    return issued.accesstoken;
  }

  private async request<T>(
    path: string,
    authorization: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new BizppurioError(
        `${path} failed: ${(e as Error).message}${causeOf(e)}`,
        undefined,
        undefined,
        { cause: e },
      );
    }
    // 본문 읽기에도 timeout signal 이 걸린다. 여기서 끊긴 것을 "본문 없음"으로
    // 삼키면 접수됐을 수도 있는 타임아웃이 엉뚱한 오류로 보인다.
    let text: string;
    try {
      text = await response.text();
    } catch (e) {
      throw new BizppurioError(
        `${path} body read failed: ${(e as Error).message}${causeOf(e)}`,
        undefined,
        response.status,
        { cause: e },
      );
    }
    const payload = parseJson(text) as (T & { code?: number }) | undefined;
    if (!response.ok)
      throw new BizppurioError(
        `${path} failed: http=${response.status} code=${payload?.code}`,
        payload?.code,
        response.status,
      );
    if (payload === undefined)
      throw new BizppurioError(`${path} returned no body`, undefined, 200);
    return payload;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** YYYYMMDDHHmmss (KST) → epoch ms. 형식이 깨졌으면 0 이라 다음 호출에서 다시 받는다. */
function parseExpired(expired: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(expired);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
}

/**
 * fetch(undici)는 실패를 'fetch failed' 하나로 감싸고 진짜 원인(ECONNREFUSED ·
 * ENOTFOUND · 인증서 오류 · 연결 타임아웃)은 cause 에 둔다. 메시지만 남기면 이력과 로그에서
 * 원인이 모두 같아 보이므로 원인의 코드와 메시지를 붙인다(객체 전체는 붙이지 않는다).
 */
function causeOf(e: unknown): string {
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (!(cause instanceof Error)) return '';
  const { code } = cause as { code?: string };
  return ` (${code ?? cause.name}: ${cause.message})`;
}
