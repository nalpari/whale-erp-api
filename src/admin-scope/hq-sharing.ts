import type { Prisma } from '@prisma/client';

// 본사 제공 동의는 계정에 하나다 — 한 직원이 소속 점포마다 다르게 고르지 않는다(2026-10-20 노영주, 처음에는 직원 레코드에
// 두었다 #137). 직원 레코드를 다루는 곳은 그 레코드의 계정에서 읽는다. 가입 전(계정 없음)이면 동의할 사람이 아직 없으므로
// 동의하지 않은 것으로 보고 가린다 — 개인정보 규칙은 판단이 틀릴 때 가리는 쪽이어야 한다. 계정은 BP 를 가로지르므로 동의도
// 모든 BP 에 같은 값이지만, 각 본사는 관리 범위(자기 BP 점포)에 있는 그 사람의 레코드만 본다 — 다른 소속은 드러나지 않는다.

/** 직원 레코드 select 에 펼쳐 넣는다. select 에 `account` 를 따로 두는 곳은 펼치지 말고 그 안에 `.account.select` 를 펼친다 */
export const HQ_SHARING_SELECT = {
  account: { select: { isHqSharingConsented: true } },
} as const satisfies Prisma.StaffMemberSelect;

/**
 * 동의한 직원만 — 직원 레코드 where 에 펼쳐 넣는다. 계정이 없는 레코드는 빠진다. 같은 객체에 `account` 조건이 있으면
 * 펼치지 말고 `AND: [HQ_SHARING_CONSENTED, …]` 의 원소로 넣는다 — 키가 겹치면 한쪽 조건이 타입 오류 없이 사라진다.
 */
export const HQ_SHARING_CONSENTED = {
  account: { is: { isHqSharingConsented: true } },
} as const satisfies Prisma.StaffMemberWhereInput;

/** 판정에 넘기는 직원 레코드 — HQ_SHARING_SELECT 로 읽은 모양 */
export type HqSharingSource = Prisma.StaffMemberGetPayload<{
  select: typeof HQ_SHARING_SELECT;
}>;

export function hqSharingConsentedOf(staff: HqSharingSource): boolean {
  return staff.account?.isHqSharingConsented ?? false;
}
