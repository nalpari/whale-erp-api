import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/** 소속 근무지 목록 조건 */
export class MyMembershipListQueryDto {
  /**
   * 퇴직한 소속도 넣을지(true · false, 없으면 false). true 면 지금 소속 뒤에 퇴직한 소속을 퇴직일 최근 순으로 붙인다 —
   * 응답 모양은 같고, 퇴직일(retiredDate)이 오늘보다 앞이면 퇴직한 소속이다. 'true' · 'false' 밖의 값은 400.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeRetired?: boolean;
}
