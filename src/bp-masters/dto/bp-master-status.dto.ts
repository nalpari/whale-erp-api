import { IsIn } from 'class-validator';

export const CHANGEABLE_BP_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ChangeableBpStatus = (typeof CHANGEABLE_BP_STATUSES)[number];

/** BP 상태 변경. 탈퇴는 여기서 하지 않는다. */
export class ChangeBpMasterStatusDto {
  /** 바꿀 상태. 미사용이면 그 BP 의 관리자 계정 전부가, 사용이면 BP 마스터만 함께 바뀐다. */
  @IsIn(CHANGEABLE_BP_STATUSES)
  status: ChangeableBpStatus;
}
