import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_ENUMS } from './db-enums.generated';

// schema.prisma 의 enum 과 GET /enums 의 DB 쪽 목록이 같은지 본다. enum 을 더하거나 값을 바꾸고
// `pnpm enums:generate` 를 잊으면 여기서 실패한다. 키는 DB 타입 이름(@@map)의 PascalCase 다.
const pascal = (s: string) =>
  s
    .split('_')
    .map((x) => x[0].toUpperCase() + x.slice(1))
    .join('');

function prismaEnums(): Record<string, string[]> {
  const schema = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  const enums: Record<string, string[]> = {};
  for (const [, body] of schema.matchAll(/^enum \w+ \{([^}]*)\}/gm)) {
    const name = /@@map\("(\w+)"\)/.exec(body)?.[1];
    if (!name)
      throw new Error(`@@map 이 없는 enum: ${body.trim().slice(0, 40)}`);
    enums[pascal(name)] = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
  }
  return enums;
}

describe('db-enums.generated', () => {
  it('schema.prisma 의 enum 과 이름 · 값 · 순서가 같다', () => {
    const generated = Object.fromEntries(
      Object.entries(DB_ENUMS).map(([k, pairs]) => [k, pairs.map(([v]) => v)]),
    );
    expect(generated).toEqual(prismaEnums());
  });
});
