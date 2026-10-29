import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { NO_NUL } from './no-nul';
import { IsUpdatedAt } from './updated-at';

/** 운영자 내부 메모 저장 — 문의사항 · 도입문의가 함께 쓴다. 문의자에게는 보이지 않는다. */
export class SaveInternalMemoDto {
  /**
   * 메모. 2,000자까지. null · 빈 문자열 · 공백만 보내면 지운다. 키는 빼먹을 수 없다 — 빠진 키로 메모가 지워지지 않게.
   */
  @ApiProperty({ type: String, nullable: true })
  @ValidateIf((dto: SaveInternalMemoDto) => dto.internalMemo !== null)
  @IsString()
  @MaxLength(2_000)
  @Matches(NO_NUL, { message: '메모에 쓸 수 없는 문자가 있습니다.' })
  internalMemo: string | null;

  /**
   * 저장하기 전에 읽은 `updatedAt` 그대로. 그사이 다른 운영자가 저장했으면 409 다.
   * @example 2026-10-14T01:02:03.456Z
   */
  @IsUpdatedAt()
  updatedAt: string;
}

/** 공백만 있는 메모는 지운 것으로 본다. */
export function memoValue(memo: string | null): string | null {
  return memo?.trim() ? memo : null;
}
