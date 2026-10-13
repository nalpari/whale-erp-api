// DB enum 한글 → src/enums/db-enums.generated.ts (GET /enums 의 DB 쪽 출처). `pnpm enums:generate`
//
// 한글의 출처는 enum 타입 설명(COMMENT ON TYPE '한글 · 한글')이다 — 1팀 · 3팀 공통 (2026-10-12 재영).
// 저장소의 마이그레이션 전체를 빈 PGlite 에 적용해 읽는다. 공용 DB 에는 저장소에 없는 마이그레이션이 올라와
// 있을 수 있어 접속하지 않는다. 설명이 없거나 값 수와 한글 수가 다르면 멈춘다.
// 키는 타입 이름(snake_case)의 PascalCase 다. Prisma 쪽 이름(…Value 같은 예외)은 쓰지 않는다.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const migrations = join(root, 'prisma', 'migrations');
const out = join(root, 'src', 'enums', 'db-enums.generated.ts');

const db = new PGlite({ extensions: { btree_gist } });
for (const dir of readdirSync(migrations).filter((d) => /^\d/.test(d)).sort()) {
  await db.exec(readFileSync(join(migrations, dir, 'migration.sql'), 'utf8'));
}
const { rows } = await db.query(`
  SELECT t.typname AS name, obj_description(t.oid, 'pg_type') AS label,
         array_agg(e.enumlabel ORDER BY e.enumsortorder) AS vals
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE t.typnamespace = 'public'::regnamespace
   GROUP BY t.oid, t.typname`);
await db.close();

const pascal = (s) => s.split('_').map((x) => x[0].toUpperCase() + x.slice(1)).join('');
const enums = rows
  .map(({ name, label, vals }) => {
    if (!label) throw new Error(`${name}: 타입 설명(COMMENT ON TYPE)이 없다`);
    const labels = label.split('·').map((x) => x.trim());
    if (labels.length !== vals.length) {
      throw new Error(`${name}: 값 ${vals.length}개에 한글 ${labels.length}개`);
    }
    // 저장소 Prettier 는 작은따옴표다(lint 오류).
    if ([...vals, ...labels].some((x) => x.includes("'"))) throw new Error(`${name}: 작은따옴표`);
    return [pascal(name), vals.map((v, i) => [v, labels[i]])];
  })
  .sort(([a], [b]) => (a < b ? -1 : 1));

const ts = [
  '// scripts/build-enum-labels.mjs 가 enum 타입 설명(COMMENT ON TYPE)에서 만든다. 손으로 고치지 말 것.',
  "import type { EnumSource } from './enums.service';",
  '',
  'export const DB_ENUMS: EnumSource = {',
  ...enums.flatMap(([key, pairs]) => [
    `  ${key}: [`,
    ...pairs.map(([v, k]) => `    ['${v}', '${k}'],`),
    '  ],',
  ]),
  '};',
  '',
];
writeFileSync(out, ts.join('\n'));
console.log(`src/enums/db-enums.generated.ts — enum ${enums.length} · 값 ${enums.reduce((n, [, p]) => n + p.length, 0)}`);
