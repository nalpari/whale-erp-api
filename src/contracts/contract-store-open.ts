import { ConflictException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { StoreStatus } from '../stores/store-format';

/**
 * 운영 중인 근무지 — 운영(OPERATING)이고 지우지 않았고 날인이 고정할 사용자 칸(대표자 · 사업자등록번호)이 있다. 「사업주 정보가
 * 없는 점포는 미운영으로 본다」(2026-11-18 사용자 결정) — 점포는 사업자 인증 · 좌표 · BP 사용이 있어야 운영이 되고(missingForOperation)
 * 본사는 인증을 풀면 미운영으로 내려가지만, 그 규칙 전에 인증 없이 운영으로 들어온 점포가 남아 있어 사용자 칸도 함께 본다.
 * 근무지 선택지 · 새 근무지 검사(722) · 발송 · 날인 · 직원 앱 상세가 모두 이 기준 하나를 쓴다(조건은 이 where 와 isOperatingStore).
 */
export const OPERATING_STORE_WHERE = {
  isDeleted: false,
  storeStatusCode: 'OPERATING' satisfies StoreStatus,
  businessProfile: {
    is: {
      AND: [
        { bizCeoName: { not: null } },
        { bizCeoName: { not: '' } },
        { bizRegistrationNumber: { not: null } },
        { bizRegistrationNumber: { not: '' } },
      ],
    },
  },
} satisfies Prisma.StoreWhereInput;

/**
 * OPERATING_STORE_WHERE 와 같은 판정을 이미 읽은 점포 행으로(직원 앱 상세 · 날인). 빈 값은 null 과 '' — where 와 같게 둔다.
 * 공백만 든 값은 저장되지 않는다(점포 진위확인 대표자명은 trim 뒤 1~50자, 번호는 숫자 10자리).
 */
export const isOperatingStore = (store: {
  storeStatusCode: string;
  isDeleted: boolean;
  businessProfile: {
    bizCeoName: string | null;
    bizRegistrationNumber: string | null;
  } | null;
}): boolean =>
  store.storeStatusCode === ('OPERATING' satisfies StoreStatus) &&
  !store.isDeleted &&
  Boolean(store.businessProfile?.bizCeoName) &&
  Boolean(store.businessProfile?.bizRegistrationNumber);

/** 그 점포가 운영 중인 근무지인가(OPERATING_STORE_WHERE). 점포가 없어도 거짓 */
export async function storeOperating(
  tx: Pick<Prisma.TransactionClient, 'store'>,
  storeId: number,
): Promise<boolean> {
  const store = await tx.store.findFirst({
    where: { storeId, ...OPERATING_STORE_WHERE },
    select: { storeId: true },
  });
  return store !== null;
}

/** 날인이 판정 · 고정에 쓰는 점포 값 — 사용자 칸(employerOf 의 입력)과 운영 여부 */
export type SignStore = {
  name: string;
  phone: string | null;
  businessProfile: {
    bizTradeName: string | null;
    bizRegistrationNumber: string | null;
    bizCeoName: string | null;
    bizAddress: string | null;
    bizAddressDetail: string | null;
  } | null;
  operating: boolean;
};

/**
 * 날인 트랜잭션에서 점포와 사업자정보를 **한 SQL 문장**으로 읽는다 — 문장 하나는 한 시점의 커밋만 보므로, 본사 사업자 인증
 * 해제(사업자정보 비우기 + 미운영 전환, 한 트랜잭션)가 판정과 고정 값 사이에 끼지 못한다. 점포 행을 잠그지 않아 다른 잠금
 * 순서(점포 폐점 · 재발송)와 교착하지 않는다. 점포가 없으면 null(계약의 외래키라 데이터가 깨진 것).
 */
export async function readSignStore(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  storeId: number,
): Promise<SignStore | null> {
  const rows = await tx.$queryRaw<
    {
      name: string;
      phone: string | null;
      storeStatusCode: string;
      isDeleted: boolean;
      profileStoreId: number | null;
      bizTradeName: string | null;
      bizRegistrationNumber: string | null;
      bizCeoName: string | null;
      bizAddress: string | null;
      bizAddressDetail: string | null;
    }[]
  >`
    SELECT s."name", s."phone", s."store_status_code" AS "storeStatusCode", s."is_deleted" AS "isDeleted",
           p."store_id" AS "profileStoreId", p."biz_trade_name" AS "bizTradeName",
           p."biz_registration_number" AS "bizRegistrationNumber", p."biz_ceo_name" AS "bizCeoName",
           p."biz_address" AS "bizAddress", p."biz_address_detail" AS "bizAddressDetail"
    FROM "stores" s LEFT JOIN "store_business_profiles" p ON p."store_id" = s."store_id"
    WHERE s."store_id" = ${storeId}`;
  const r = rows[0];
  if (!r) return null;
  const businessProfile =
    r.profileStoreId === null
      ? null
      : {
          bizTradeName: r.bizTradeName,
          bizRegistrationNumber: r.bizRegistrationNumber,
          bizCeoName: r.bizCeoName,
          bizAddress: r.bizAddress,
          bizAddressDetail: r.bizAddressDetail,
        };
  return {
    name: r.name,
    phone: r.phone,
    businessProfile,
    operating: isOperatingStore({
      storeStatusCode: r.storeStatusCode,
      isDeleted: r.isDeleted,
      businessProfile,
    }),
  };
}

/** 운영 중이 아닌 근무지라 막을 때의 409 — 관리자(발송)와 직원(날인)에게 다른 문장을 보인다 */
export const storeNotOperatingConflict = (message: string) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'STORE_NOT_OPERATING',
    message,
  });
