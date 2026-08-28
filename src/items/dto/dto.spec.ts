import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateItemDto } from './create-item.dto';
import { CreateStockMovementDto } from './create-stock-movement.dto';

// ValidationPipe({ transform: true }) 와 같은 경로로 만든다. Object.assign 으로
// 만들면 @Transform 이 실행되지 않아 운영과 다른 동작을 검증하게 된다.
const item = (o: Record<string, unknown>) => plainToInstance(CreateItemDto, o);
const move = (o: Record<string, unknown>) =>
  plainToInstance(CreateStockMovementDto, o);

describe('CreateItemDto', () => {
  it('정상 입력은 통과한다', () => {
    expect(validateSync(item({ sku: 'A-1', name: '볼트' }))).toHaveLength(0);
  });

  // DB 의 items_sku_not_blank / items_name_not_blank 는 공백만인 값을 거부한다.
  // DTO 가 통과시키면 400 이어야 할 요청이 500 으로 나간다.
  it.each(['   ', '\t', '\n', ' \t\n '])(
    '공백만인 sku(%j)를 거부한다',
    (sku) => {
      expect(validateSync(item({ sku, name: '이름' })).length).toBeGreaterThan(
        0,
      );
    },
  );

  it.each(['   ', '\t\n'])('공백만인 name(%j)을 거부한다', (name) => {
    expect(validateSync(item({ sku: 'A-1', name })).length).toBeGreaterThan(0);
  });

  it('앞뒤 공백은 제거하고 통과시킨다', () => {
    const d = item({ sku: '  A-1  ', name: '  볼트  ' });
    expect(validateSync(d)).toHaveLength(0);
    expect(d.sku).toBe('A-1');
    expect(d.name).toBe('볼트');
  });
});

describe('CreateStockMovementDto', () => {
  it('정상 입력은 통과한다', () => {
    expect(validateSync(move({ quantity: 5, reason: '입고' }))).toHaveLength(0);
  });

  it('0 은 거부한다', () => {
    expect(
      validateSync(move({ quantity: 0, reason: '입고' })).length,
    ).toBeGreaterThan(0);
  });

  // quantity 컬럼은 INTEGER 다. 범위를 넘기면 Postgres 가 에러를 내 500 이 된다.
  it.each([2147483648, -2147483649, 3_000_000_000])(
    'int 범위를 벗어난 quantity(%d)를 거부한다',
    (quantity) => {
      expect(
        validateSync(move({ quantity, reason: '입고' })).length,
      ).toBeGreaterThan(0);
    },
  );

  it.each([2147483647, -2147483648])(
    'int 경계값(%d)은 통과시킨다',
    (quantity) => {
      expect(validateSync(move({ quantity, reason: '입고' }))).toHaveLength(0);
    },
  );

  it('공백만인 reason 을 거부한다', () => {
    expect(
      validateSync(move({ quantity: 1, reason: '   ' })).length,
    ).toBeGreaterThan(0);
  });
});
