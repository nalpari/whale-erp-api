import type { Prisma } from '@prisma/client';
import {
  consentOpensStore,
  hidesPersonalData,
  type MaskingStore,
} from './admin-scope.service';
import { HQ_SHARING_CONSENTED } from './hq-sharing';

/**
 * 그 점포들에서 이 역할에게 보이는 개인 단위 자료의 조건 — 가려지는 점포(hidesPersonalData, 동의 없이 판정 — 직영이 아닌
 * 점포의 본사 역할)는 본사 제공 동의한 직원 것만이고, 폐점한 가맹 점포는 동의해도 보이지 않는다(ATT-30 v227). contract 는 근로계약 where(동의는 그 직원 레코드의 계정), staff 는 직원
 * 레코드 where 다. 근로계약 목록과 로그인 후 홈이 같이 쓴다 — 한쪽만 고치면 같은 점포의 숫자가 화면마다 달라진다. 둘 다
 * storeId 나 OR 만 쓰므로 다른 조건과 펼쳐 합쳐도 키가 겹치지 않지만, 같은 객체에 OR 이 있으면 AND 로 묶는다.
 */
export function hqVisibleWhere(
  roleTypeCode: string,
  storeIds: readonly number[],
  storeOf: ReadonlyMap<number, MaskingStore>,
): {
  contract: Prisma.ContractWhereInput;
  staff: Prisma.StaffMemberWhereInput;
} {
  const visibleIds = storeIds.filter(
    (id) => !hidesPersonalData(roleTypeCode, storeOf.get(id), false),
  );
  // 폐점한 가맹 점포는 동의해도 가리므로 어느 갈래에도 들지 않는다
  const hiddenIds = storeIds.filter((id) =>
    consentOpensStore(roleTypeCode, storeOf.get(id)),
  );
  if (hiddenIds.length === 0)
    return {
      contract: { storeId: { in: visibleIds } },
      staff: { storeId: { in: visibleIds } },
    };
  return {
    contract: {
      OR: [
        { storeId: { in: visibleIds } },
        { storeId: { in: hiddenIds }, staffMember: HQ_SHARING_CONSENTED },
      ],
    },
    staff: {
      OR: [
        { storeId: { in: visibleIds } },
        { storeId: { in: hiddenIds }, ...HQ_SHARING_CONSENTED },
      ],
    },
  };
}
