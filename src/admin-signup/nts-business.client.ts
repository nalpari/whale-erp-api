/** 국세청 진위확인에 넘기는 세 값. bizOpenDate 는 YYYY-MM-DD 다 */
export type BizIdentity = {
  bizRegistrationNumber: string;
  bizCeoName: string;
  bizOpenDate: string;
};

/** 국세청이 일치·불일치를 답하지 못했다(키 없음 · 장애 · 시간 초과 · 뜻밖의 응답). 메시지에 키를 넣지 않는다 */
export class NtsUnavailableError extends Error {
  name = 'NtsUnavailableError';
}

const VALIDATE_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/validate';
// 기본 fetch(undici)는 분 단위로 기다린다. 가입 화면의 「인증 중」이 그만큼 묶이지 않게 끊는다.
export const NTS_TIMEOUT_MS = 5_000;

/**
 * 공공데이터포털 「국세청_사업자등록정보 진위확인 및 상태조회」의 진위확인(validate) 래퍼.
 * 진위만 본다 — 휴업·폐업 여부(status)는 판정에 쓰지 않는다(okf auth 「가입」, S-VRNTHD).
 */
export class NtsBusinessClient {
  constructor(
    private readonly serviceKey: string | undefined,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async verify(identity: BizIdentity): Promise<'MATCH' | 'MISMATCH'> {
    if (!this.serviceKey)
      throw new NtsUnavailableError('NTS_SERVICE_KEY 가 비어 있다');

    let response: Response;
    let body: unknown;
    try {
      response = await this.fetchFn(
        `${VALIDATE_URL}?serviceKey=${serviceKeyParam(this.serviceKey)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            businesses: [
              {
                b_no: identity.bizRegistrationNumber,
                start_dt: identity.bizOpenDate.replaceAll('-', ''),
                p_nm: identity.bizCeoName,
              },
            ],
          }),
          signal: AbortSignal.timeout(NTS_TIMEOUT_MS),
        },
      );
      body = await response.json().catch(() => null);
    } catch (e) {
      // 원인 이름만 남긴다 — undici 오류 메시지에 요청 주소(키 포함)가 섞일 수 있다.
      throw new NtsUnavailableError(
        `국세청 호출 실패: ${e instanceof Error ? e.name : 'unknown'}`,
      );
    }
    if (!response.ok)
      throw new NtsUnavailableError(`국세청 응답 HTTP ${response.status}`);

    // 일치("01")·불일치("02") 말고는 모두 장애로 본다 — 모양이 바뀐 응답을 「일치」로 읽으면 안 된다.
    const valid = (body as { data?: { valid?: unknown }[] } | null)?.data?.[0]
      ?.valid;
    if (valid === '01') return 'MATCH';
    if (valid === '02') return 'MISMATCH';
    throw new NtsUnavailableError(
      `국세청 응답의 valid 가 뜻밖이다: ${String(valid)}`,
    );
  }
}

/**
 * 포털은 같은 키를 Encoding(이미 % 인코딩)·Decoding(원문) 두 모양으로 준다. 어느 쪽을 .env 에 넣어도
 * 되게, % 가 있으면 인코딩된 것으로 보고 그대로 쓴다 — 두 번 인코딩하면 키가 틀려 401 이 된다.
 */
function serviceKeyParam(key: string): string {
  return key.includes('%') ? key : encodeURIComponent(key);
}
