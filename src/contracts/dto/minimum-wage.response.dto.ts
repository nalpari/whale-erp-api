import { ApiProperty } from '@nestjs/swagger';

/** 지금 최저임금 — 공통코드 MINIMUM_WAGE · HOURLY(WHALEERP-595). 계약 시작일과 상관없이 이 값 하나로 본다 */
export class MinimumWageResponseDto {
  /** 시급(원). 공통코드를 쓸 수 없으면 null */
  @ApiProperty({ type: Number, nullable: true, example: 10320 })
  hourlyWage: number | null;
  /**
   * 공통코드를 쓸 수 없는 까닭(없음 · 사용 중지 · 코드명이 숫자 아님) — 수습이 있는 계약을 저장하면 이 문장으로 400 이다.
   * 쓸 수 있으면 null
   */
  @ApiProperty({ type: String, nullable: true, example: null })
  problem: string | null;
}
