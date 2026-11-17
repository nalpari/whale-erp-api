import {
  IsBoolean,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * 본사 점포의 좌표 · 위치 적용(2026-11-17) — 마이페이지 BP 사업자정보와 플랫폼 BP 등록 · 수정이 함께 받는다. 점포 등록
 * (save-store.dto)과 같은 이름 · 범위다. 본사 직원 출퇴근 반경의 기준이고, 좌표가 있어야 본사가 운영이 된다.
 * 사업장 주소를 고르면 화면이 좌표를 얻어 함께 보낸다. 위도 · 경도는 함께 넣거나(null 이면 지움) 함께 생략한다(그대로 둔다).
 */
export class HqLocationDto {
  /** 위도 — −90~90, 소수 6자리. null 이면 좌표를 지우고, 위도 · 경도를 함께 생략하면 그대로 둔다. @example 37.498095 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  /** 경도 — −180~180, 소수 6자리. @example 127.027610 */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  /** 출퇴근 위치 적용 여부 — 생략하면 그대로(처음 만들 때는 사용). 3팀 출퇴근이 본사 직원의 위치를 이 값으로 본다. */
  @IsOptional()
  @IsBoolean()
  isLocationApplied?: boolean;
}
