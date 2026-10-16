import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, Matches } from 'class-validator';

const WITH_OFFSET = /T.*(Z|[+-]\d{2}:\d{2})$/;

/**
 * 동시 저장 확인에 쓰는 `updatedAt` 칸. 고치기 전에 읽은 값 그대로 받는다 — 그 뒤 누가 고쳤으면 409 다.
 * 오프셋이 없으면 서버 시간대로 읽혀, 서버가 UTC 가 아니면 409 가 된다(환경마다 다르다). 400 으로 바로 드러나게 한다.
 */
export function IsUpdatedAt(): PropertyDecorator {
  return applyDecorators(
    // Swagger 플러그인은 소스의 @Matches 만 읽어 여기 감춘 것은 못 본다. pattern 은 직접 적는다.
    ApiProperty({ pattern: WITH_OFFSET.source }),
    IsISO8601({ strict: true }),
    Matches(WITH_OFFSET, {
      message: 'updatedAt 은 상세 응답의 값 그대로(시간대 포함) 보내야 합니다',
    }),
  );
}

/**
 * 응답 JSON 의 시각은 ms 까지다. 칸은 µs(timestamptz(6))라, Prisma 가 아닌 SQL 이 µs 값을 쓴 행도
 * 고칠 수 있게 같은 ms 안이면 같은 것으로 본다.
 */
export function sameMillisecond(iso: string): { gte: Date; lt: Date } {
  const at = new Date(iso);
  return { gte: at, lt: new Date(at.getTime() + 1) };
}

/** 이미 읽은 행의 updatedAt 이 받은 값과 같은 ms 인가 — sameMillisecond 와 같은 판정을 메모리에서 한다. */
export function isSameMillisecond(value: Date, iso: string): boolean {
  const { gte, lt } = sameMillisecond(iso);
  return value >= gte && value < lt;
}
