/** 공휴일 정보 조회가 준 휴일 한 건. 값은 원문 그대로(검증은 동기화가 한다) */
export type ApiHoliday = { locdate: string; dateName: string; seq: string };

/** 공휴일 API 가 그 해 목록을 주지 못했다(키 없음 · 미승인 · 장애 · 시간 초과 · 뜻밖의 응답). 메시지에 키를 넣지 않는다 */
export class HolidayApiUnavailableError extends Error {
  name = 'HolidayApiUnavailableError';
}

const REST_DE_INFO_URL =
  'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
// 한 해 공휴일은 스무 건 남짓이라 한 쪽 100건이면 다 온다 — 넘으면 일부만 반영하지 않게 실패로 본다.
const PAGE_SIZE = 100;
// 기본 fetch(undici)는 분 단위로 기다린다. 배치가 그만큼 묶이지 않게 끊는다.
export const HOLIDAY_API_TIMEOUT_MS = 5_000;

/**
 * 공공데이터포털 「한국천문연구원_특일 정보」의 공휴일 정보 조회(getRestDeInfo) 래퍼. 연도 하나를 통째로 받는다.
 * 대체공휴일 · 임시공휴일 · 선거일도 관보 공포 뒤에 이 목록에 들어온다(okf api/public-holidays.md).
 */
export class HolidayApiClient {
  constructor(
    private readonly serviceKey: string | undefined,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get isConfigured(): boolean {
    return !!this.serviceKey;
  }

  async fetchYear(year: number): Promise<ApiHoliday[]> {
    if (!this.serviceKey)
      throw new HolidayApiUnavailableError('HOLIDAY_SERVICE_KEY 가 비어 있다');

    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(
        `${REST_DE_INFO_URL}?serviceKey=${serviceKeyParam(this.serviceKey)}` +
          `&solYear=${year}&numOfRows=${PAGE_SIZE}&pageNo=1&_type=json`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(HOLIDAY_API_TIMEOUT_MS),
        },
      );
      // 본문도 이 try 안에서 읽는다 — 본문을 받다 시간이 다 되면 그것도 시간 초과로 남게.
      text = await response.text();
    } catch (e) {
      // 원인 이름과 코드만 남긴다 — undici 오류 메시지에는 요청 주소(키 포함)가 섞일 수 있다.
      throw new HolidayApiUnavailableError(
        `공휴일 API 호출 실패: ${failureCause(e)}`,
      );
    }
    // 본문 원문은 남기지 않는다 — 게이트웨이 오류 페이지가 요청 주소(키 포함)를 되비출 수 있다.
    if (!response.ok)
      throw new HolidayApiUnavailableError(
        `공휴일 API 응답 HTTP ${response.status}`,
      );
    const json = parseJson(text);
    // 키 미등록 · 미승인 · 할당량 초과는 _type=json 이어도 XML 로 온다.
    if (json === undefined)
      throw new HolidayApiUnavailableError(
        `공휴일 API 응답이 JSON 이 아니다: ${xmlReason(text)}`,
      );

    // 단언 대신 모양을 붙인 변수로 받는다 — 칸이 모두 선택이라 어떤 JSON 이든 들어온다.
    const envelope: Envelope | null = json;
    const { header, body } = envelope?.response ?? {};
    const { resultCode, resultMsg } = header ?? {};
    if (resultCode !== '00')
      throw new HolidayApiUnavailableError(
        `공휴일 API resultCode=${String(resultCode)} resultMsg=${String(resultMsg)}`,
      );
    if (!body || typeof body !== 'object')
      throw new HolidayApiUnavailableError('공휴일 API 응답에 body 가 없다');

    const { items, totalCount } = body;
    const list = itemsOf(items);
    if (Number(totalCount) > list.length)
      throw new HolidayApiUnavailableError(
        `공휴일 API 가 한 쪽에 다 주지 않았다(totalCount=${String(totalCount)}, 받은 ${list.length}건)`,
      );
    return list
      .filter((x) => x.isHoliday === 'Y')
      .map((x) => ({
        locdate: String(x.locdate),
        dateName: String(x.dateName ?? ''),
        seq: String(x.seq ?? ''),
      }));
  }
}

/** 포털 응답의 모양 — 값은 검증 전이라 어느 칸이든 빠질 수 있다 */
type Envelope = {
  response?: {
    header?: { resultCode?: unknown; resultMsg?: unknown };
    body?: { items?: unknown; totalCount?: unknown };
  };
};

type RawItem = {
  locdate?: string | number;
  dateName?: string;
  seq?: string | number;
  isHoliday?: string;
};

/** 0건이면 items 가 빈 문자열, 한 건이면 item 이 객체, 여러 건이면 배열이다 */
function itemsOf(items: unknown): RawItem[] {
  if (items === '' || items === undefined || items === null) return [];
  const item = (items as { item?: unknown }).item;
  if (Array.isArray(item)) return item as RawItem[];
  if (item && typeof item === 'object') return [item];
  throw new HolidayApiUnavailableError(
    `공휴일 API 응답의 items 모양이 뜻밖이다: ${typeof item}`,
  );
}

function failureCause(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown';
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${e.name}(${code})` : e.name;
}

/** JSON 이 아니면 undefined. null 은 JSON 값이라 그대로 돌려준다 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 포털의 XML 오류에서 사유만 꺼낸다(키는 들어 있지 않다) */
function xmlReason(text: string): string {
  const tag = (name: string) =>
    new RegExp(`<${name}>([^<]{0,100})</${name}>`).exec(text)?.[1];
  const msg = tag('returnAuthMsg') ?? tag('errMsg');
  const code = tag('returnReasonCode');
  return msg || code ? `${msg ?? ''} (code=${code ?? '?'})` : '사유 없음';
}

/**
 * 포털은 같은 키를 Encoding(이미 % 인코딩)·Decoding(원문) 두 모양으로 준다. 어느 쪽을 .env 에 넣어도
 * 되게, % 가 있으면 인코딩된 것으로 보고 그대로 쓴다 — 두 번 인코딩하면 키가 틀려 등록되지 않은 키가 된다.
 */
function serviceKeyParam(key: string): string {
  return key.includes('%') ? key : encodeURIComponent(key);
}
