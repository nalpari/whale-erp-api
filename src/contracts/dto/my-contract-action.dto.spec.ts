import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CORRECTION_REASON_MAX,
  RequestMyContractCorrectionDto,
} from './my-contract-action.dto';

// ValidationPipe 처럼 바꾸고 검사한다. 걸린 칸의 문구가 곧 400 의 문구다.
const check = (plain: object) => {
  const dto = plainToInstance(RequestMyContractCorrectionDto, plain);
  const messages = validateSync(dto).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );
  return { dto, messages };
};

describe('RequestMyContractCorrectionDto (직원 수정 요청 사유, WHALEERP-635)', () => {
  it.each([
    [{}],
    [{ reason: null }],
    [{ reason: 3 }],
    [{ reason: '' }],
    [{ reason: '   ' }],
  ])('%p 이면 「입력해 주세요」', (plain) =>
    expect(check(plain).messages).toEqual(['수정 요청 사유를 입력해 주세요.']),
  );

  it('앞뒤 공백을 지운 뒤 101자면 「100자 이하로」', () =>
    expect(
      check({ reason: ` ${'가'.repeat(CORRECTION_REASON_MAX + 1)} ` }).messages,
    ).toEqual(['수정 요청 사유는 100자 이하로 입력해 주세요.']));

  it('1~100자는 앞뒤 공백을 지운 값으로 받는다 — 풀어 쓴 한글(NFD)은 합친 뒤 센다', () => {
    expect(check({ reason: '  시급이 다릅니다 ' })).toMatchObject({
      dto: { reason: '시급이 다릅니다' },
      messages: [],
    });
    expect(check({ reason: '가' }).messages).toEqual([]);
    const nfd = '가'.normalize('NFD').repeat(CORRECTION_REASON_MAX);
    expect(check({ reason: `  ${nfd}  ` })).toMatchObject({
      dto: { reason: '가'.repeat(CORRECTION_REASON_MAX) },
      messages: [],
    });
  });
});
