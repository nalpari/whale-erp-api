// Nest 앱 밖에서 데코레이터를 읽으므로 직접 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DeleteCodeItemsDto } from './delete-code-items.dto';

// ValidationPipe 가 하는 변환 · 검증을 그대로 거친다.
const parse = (plain: object) => plainToInstance(DeleteCodeItemsDto, plain);
const constraintsOf = async (plain: object) =>
  (await validate(parse(plain))).flatMap((e) => [
    e.property,
    ...Object.keys(e.constraints ?? {}),
  ]);

// 본문은 { itemCodes } 하나다 — 플랫폼 · BP 공통코드 관리의 상세 코드 삭제가 함께 쓴다.
describe('DeleteCodeItemsDto — 상세 코드 삭제 본문', () => {
  it('코드는 앞뒤 공백을 지우고 대문자로 받는다(등록과 같은 정책)', async () => {
    const dto = parse({ itemCodes: [' full ', 'Part'] });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.itemCodes).toEqual(['FULL', 'PART']);
  });

  it('빈 배열 · 없음은 400', async () => {
    expect(await constraintsOf({ itemCodes: [] })).toEqual([
      'itemCodes',
      'arrayMinSize',
    ]);
    expect(await constraintsOf({})).toContain('itemCodes');
  });

  it('상한 500 건까지 받고, 넘으면 400', async () => {
    const codes = (n: number) => ({
      itemCodes: Array.from({ length: n }, (_, i) => `C${i}`),
    });
    expect(await constraintsOf(codes(500))).toEqual([]);
    expect(await constraintsOf(codes(501))).toEqual([
      'itemCodes',
      'arrayMaxSize',
    ]);
  });

  it('형식이 틀린 코드 · 문자열이 아닌 값은 400', async () => {
    expect(await constraintsOf({ itemCodes: ['1ABC'] })).toEqual([
      'itemCodes',
      'matches',
    ]);
    expect(await constraintsOf({ itemCodes: [3] })).toContain('itemCodes');
  });
});
