import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  assertUtcSessionTimeZone,
  pgConnectionConfig,
} from './pg-session-timezone';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // Prisma 7 은 datasource url 을 스키마가 아닌 driver adapter 로 받는다.
    // DATABASE_URL 은 ConfigModule 이 .env.<APP_ENV> 에서 읽어 process.env 에 넣는다.
    // 어댑터는 Date 를 타임존 없는 UTC 글자로 주고받는다. 세션이 DB 기본 타임존(Asia/Seoul)이면
    // 쓸 때 9시간 이르게 저장되고 읽을 때 9시간 늦게 읽힌다. 세션을 UTC 로 고정한다 (2026-10-12).
    // URL 의 `?options=` 가 config 를 덮어쓰므로 거기에도 UTC 를 덧붙인다 (2026-10-22, pg-session-timezone.ts).
    super({
      adapter: new PrismaPg(pgConnectionConfig(process.env.DATABASE_URL)),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // 풀러가 시작 옵션을 무시하는 경우까지 잡는다 — UTC 가 아니면 부팅을 멈춘다.
    const [row] = await this.$queryRaw<{ timeZone: string }[]>`
      SELECT current_setting('TimeZone') AS "timeZone"`;
    assertUtcSessionTimeZone(row?.timeZone);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
