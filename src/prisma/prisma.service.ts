import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { assertUtcSessionTimeZone } from './pg-session-timezone';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // Prisma 7 은 datasource url 을 스키마가 아닌 driver adapter 로 받는다.
    // DATABASE_URL 은 ConfigModule 이 .env.<APP_ENV> 에서 읽어 process.env 에 넣는다.
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        // 어댑터는 Date 를 타임존 없는 UTC 글자로 주고받는다. 세션이 DB 기본 타임존(Asia/Seoul)이면
        // 쓸 때 9시간 이르게 저장되고 읽을 때 9시간 늦게 읽힌다. 세션을 UTC 로 고정한다 (2026-10-12).
        // URL 의 `?options=` 가 이 설정을 덮어쓰거나(pg 의 병합 순서) 서버 · 풀러가 시작 옵션을 무시하면
        // (PGlite 소켓 서버 등) 세션이 UTC 가 아닐 수 있어 onModuleInit 에서 확인한다 (2026-10-22).
        options: '-c TimeZone=UTC',
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // 풀의 첫 연결에서 실제 세션 시간대를 읽어, UTC 가 아니면 부팅을 멈춘다.
    const [row] = await this.$queryRaw<{ timeZone: string }[]>`
      SELECT current_setting('TimeZone') AS "timeZone"`;
    assertUtcSessionTimeZone(row?.timeZone);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
