import { defineConfig } from 'prisma/config';

// DATABASE_URL 은 package.json 의 db:* 스크립트가 dotenv-cli 로 주입한다.
// (Prisma 7 CLI 에는 --env-file 이 없다)
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
