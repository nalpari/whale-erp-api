import {
  HOLIDAY_API_TIMEOUT_MS,
  HolidayApiClient,
  HolidayApiUnavailableError,
} from './holiday-api.client';

const KEY = 'abc+def/ghi==';

/** 성공하면 테스트를 깨고, 실패면 그 오류를 돌려준다 */
const mustFail = (): Error => {
  throw new Error('실패해야 한다');
};

/** 포털이 _type=json 으로 주는 모양 */
const body = (items: unknown, totalCount: number, resultCode = '00') => ({
  response: {
    header: { resultCode, resultMsg: 'NORMAL SERVICE.' },
    body: { items, numOfRows: 100, pageNo: 1, totalCount },
  },
});
const item = (locdate: number, dateName: string, seq = 1, isHoliday = 'Y') => ({
  dateKind: '01',
  dateName,
  isHoliday,
  locdate,
  seq,
});

function fetchReturning(
  status: number,
  text: string,
  contentType = 'application/json',
) {
  return jest
    .fn()
    .mockResolvedValue(
      new Response(text, { status, headers: { 'content-type': contentType } }),
    );
}

describe('HolidayApiClient', () => {
  it('키가 없으면 부르지 않고 HolidayApiUnavailableError', async () => {
    const fetchFn = jest.fn();
    const client = new HolidayApiClient(undefined, fetchFn);
    expect(client.isConfigured).toBe(false);
    await expect(client.fetchYear(2026)).rejects.toThrow(
      HolidayApiUnavailableError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('공휴일 정보 조회(getRestDeInfo)를 연도 하나 · 100건 · JSON 으로 부르고 키는 한 번만 인코딩한다', async () => {
    const fetchFn = fetchReturning(200, JSON.stringify(body('', 0)));
    await new HolidayApiClient(KEY, fetchFn).fetchYear(2026);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo',
    );
    expect(url).toContain(`serviceKey=${encodeURIComponent(KEY)}`);
    expect(parsed.searchParams.get('solYear')).toBe('2026');
    expect(parsed.searchParams.get('solMonth')).toBeNull();
    expect(parsed.searchParams.get('numOfRows')).toBe('100');
    expect(parsed.searchParams.get('_type')).toBe('json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(HOLIDAY_API_TIMEOUT_MS).toBe(5_000);

    // 포털의 Encoding 키(이미 % 인코딩)는 그대로 쓴다
    const encoded = fetchReturning(200, JSON.stringify(body('', 0)));
    await new HolidayApiClient('abc%2Bdef', encoded).fetchYear(2026);
    expect((encoded.mock.calls[0] as [string])[0]).toContain(
      'serviceKey=abc%2Bdef&',
    );
  });

  it('여러 건은 배열, 한 건은 객체, 0건은 빈 문자열로 온다 — 모두 배열로 준다', async () => {
    const many = fetchReturning(
      200,
      JSON.stringify(
        body(
          { item: [item(20260101, '1월1일'), item(20260216, '설날', 2)] },
          2,
        ),
      ),
    );
    expect(await new HolidayApiClient(KEY, many).fetchYear(2026)).toEqual([
      { locdate: '20260101', dateName: '1월1일', seq: '1' },
      { locdate: '20260216', dateName: '설날', seq: '2' },
    ]);

    const one = fetchReturning(
      200,
      JSON.stringify(body({ item: item(20260501, '노동절') }, 1)),
    );
    expect(await new HolidayApiClient(KEY, one).fetchYear(2026)).toEqual([
      { locdate: '20260501', dateName: '노동절', seq: '1' },
    ]);

    const none = fetchReturning(200, JSON.stringify(body('', 0)));
    expect(await new HolidayApiClient(KEY, none).fetchYear(2030)).toEqual([]);
  });

  it('휴일이 아닌 항목(isHoliday ≠ Y)은 뺀다', async () => {
    const fetchFn = fetchReturning(
      200,
      JSON.stringify(
        body(
          {
            item: [item(20260101, '1월1일'), item(20260405, '식목일', 1, 'N')],
          },
          2,
        ),
      ),
    );
    expect(await new HolidayApiClient(KEY, fetchFn).fetchYear(2026)).toEqual([
      { locdate: '20260101', dateName: '1월1일', seq: '1' },
    ]);
  });

  it('한 쪽(100건)에 다 오지 않았으면 일부만 반영하지 않게 실패로 본다', async () => {
    const fetchFn = fetchReturning(
      200,
      JSON.stringify(body({ item: [item(20260101, '1월1일')] }, 101)),
    );
    await expect(
      new HolidayApiClient(KEY, fetchFn).fetchYear(2026),
    ).rejects.toThrow('totalCount=101');
  });

  it('resultCode 가 00 이 아니면 그 코드 · 메시지로 실패', async () => {
    const fetchFn = fetchReturning(
      200,
      JSON.stringify({
        response: {
          header: {
            resultCode: '22',
            resultMsg: 'LIMITED NUMBER OF SERVICE REQUESTS EXCEEDS ERROR.',
          },
        },
      }),
    );
    await expect(
      new HolidayApiClient(KEY, fetchFn).fetchYear(2026),
    ).rejects.toThrow('resultCode=22');
  });

  it('키 오류는 JSON 을 달라고 해도 XML 로 온다 — 사유 코드 · 메시지만 남긴다', async () => {
    const xml =
      '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>' +
      '<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>' +
      '<returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
    const fetchFn = fetchReturning(200, xml, 'text/xml');
    const error = await new HolidayApiClient(KEY, fetchFn)
      .fetchYear(2026)
      .then(mustFail, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(HolidayApiUnavailableError);
    expect(error.message).toContain('SERVICE_KEY_IS_NOT_REGISTERED_ERROR');
    expect(error.message).toContain('30');
  });

  it('HTTP 오류 · 연결 실패도 실패이고, 메시지에 키를 넣지 않는다', async () => {
    const http = fetchReturning(500, `error for ${KEY}`, 'text/html');
    const httpError = await new HolidayApiClient(KEY, http)
      .fetchYear(2026)
      .then(mustFail, (e: unknown) => e as Error);
    expect(httpError).toBeInstanceOf(HolidayApiUnavailableError);
    expect(httpError.message).toContain('HTTP 500');
    expect(httpError.message).not.toContain(KEY);

    const cause = Object.assign(new Error(`connect to ...serviceKey=${KEY}`), {
      code: 'ENOTFOUND',
    });
    const down = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed', { cause }));
    const downError = await new HolidayApiClient(KEY, down)
      .fetchYear(2026)
      .then(mustFail, (e: unknown) => e as Error);
    expect(downError).toBeInstanceOf(HolidayApiUnavailableError);
    expect(downError.message).toContain('ENOTFOUND');
    expect(downError.message).not.toContain(KEY);
  });

  it('모양이 뜻밖이면(body 없음 · item 이 배열 · 객체가 아님) 실패', async () => {
    const noBody = fetchReturning(
      200,
      JSON.stringify({ response: { header: { resultCode: '00' } } }),
    );
    await expect(
      new HolidayApiClient(KEY, noBody).fetchYear(2026),
    ).rejects.toThrow(HolidayApiUnavailableError);

    const weird = fetchReturning(200, JSON.stringify(body({ item: 'x' }, 1)));
    await expect(
      new HolidayApiClient(KEY, weird).fetchYear(2026),
    ).rejects.toThrow(HolidayApiUnavailableError);
  });
});
