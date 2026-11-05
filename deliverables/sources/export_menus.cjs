// 메뉴 테이블 스냅숏(sources/menus.json)을 쓴다. 일회용 로컬 Postgres 에 prisma/migrations 를 모두 적용한 뒤 돌린다.
//   node sources/export_menus.cjs sources/menus.json   (저장소 루트에서. DATABASE_URL 은 로컬 주소만 받는다)
// 읽기(SELECT)만 한다.
const { Client } = require('pg');
const fs = require('fs');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL 이 없습니다 — 일회용 로컬 Postgres 주소를 주세요.');
// 셸에 남은 공용 · 개발 DB 주소로 붙지 않게, 로컬 주소만 받는다.
if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error(`로컬 DB 가 아닙니다: ${new URL(url).hostname}`);
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const q = async (s) => (await c.query(s)).rows;
  const out = {
    readAt: new Date().toISOString().slice(0, 10),
    source: '일회용 로컬 Postgres(embedded-postgres)에 prisma/migrations 전부를 pnpm prisma migrate deploy 로 적용한 뒤 SELECT 로 읽음',
    lastMigration: (await q('select max(migration_name) m from _prisma_migrations'))[0].m,
    menuCount: Number((await q('select count(*) n from menus'))[0].n),
    services: await q("select item_code code, label, sort_order from code_items where group_code='SERVICE' and not is_deleted order by sort_order"),
    menus: await q('select menu_id, menu_code, service_code, parent_menu_id, name, url, sort_order, depth, status, is_deleted from menus order by menu_id'),
  };
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
  console.log(out.menuCount, out.menus.length, out.lastMigration, out.services.map(s => s.code + ':' + s.label).join(', '));
  await c.end();
})();
