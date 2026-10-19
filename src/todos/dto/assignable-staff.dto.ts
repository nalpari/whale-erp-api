import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class AssignableStaffQueryDto {
  /** 근무지 점포. 업무 범위 밖이면 404 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  storeId: number;
}

/** 배정할 수 있는 직원 한 사람 */
export class AssignableStaffItemDto {
  staffMemberId: number;
  name: string;
  /** 휴대전화번호 끝 4자리 — 이름이 같은 직원을 가른다 */
  phoneLast4: string;
  /** 직무(예: 바리스타) */
  jobTitle: string;
}

export class AssignableStaffResponseDto {
  items: AssignableStaffItemDto[];
}
