import type { Prisma } from '@prisma/client';

/**
 * BP 의 상호명 · 사업자정보는 본사 점포(stores.is_hq)의 사업자정보(store_business_profiles)에 있다
 * (20261117150907_team1_hq_stores, 2026-11-17). BP 를 읽을 때 이 조각을 select 에 넣고 tradeNameOf · hqBizOf 로 꺼낸다 —
 * 응답 모양은 그대로(tradeName · biz* 를 BP 자리에) 둔다.
 *
 * 살아 있는 본사가 먼저 오게 정렬한다. 삭제한 BP 는 본사도 삭제돼 있어 그 행을 읽는다(상호명을 잃지 않게).
 */
export const HQ_PROFILE_SELECT = {
  stores: {
    where: { isHq: true },
    orderBy: [{ isDeleted: 'asc' }, { storeId: 'asc' }],
    take: 1,
    select: {
      storeId: true,
      latitude: true,
      longitude: true,
      isLocationApplied: true,
      storeStatusCode: true,
      businessProfile: {
        select: {
          bizTradeName: true,
          bizRegistrationNumber: true,
          bizCeoName: true,
          bizOpenDate: true,
          bizCeoPhone: true,
          bizCeoEmail: true,
          bizZipCode: true,
          bizAddress: true,
          bizAddressDetail: true,
          bizCategory: true,
          bizItem: true,
          bizVerifiedAt: true,
          updatedAt: true,
        },
      },
    },
  },
} satisfies Prisma.BpCodeSelect;

/** 상호명만 읽는 곳의 조각 — 목록 · 로그인 정보처럼 사업자정보가 필요 없는 곳. */
export const HQ_TRADE_NAME_SELECT = {
  stores: {
    where: { isHq: true },
    orderBy: [{ isDeleted: 'asc' }, { storeId: 'asc' }],
    take: 1,
    select: { businessProfile: { select: { bizTradeName: true } } },
  },
} satisfies Prisma.BpCodeSelect;

type WithHqTradeName = {
  stores: { businessProfile: { bizTradeName: string | null } | null }[];
};

/** BP 상호명. 본사가 늘 채워 두지만(DB 로는 강제 못 함) 비면 빈 문자열이다. */
export function tradeNameOf(bp: WithHqTradeName): string {
  return bp.stores[0]?.businessProfile?.bizTradeName ?? '';
}

type HqProfileRow = Prisma.BpCodeGetPayload<{
  select: typeof HQ_PROFILE_SELECT;
}>['stores'][number];

/** 예전 bp_codes 칸과 같은 이름 · 모양 — 응답 · 비교 코드가 그대로 쓴다. */
export type HqBiz = {
  tradeName: string;
  bizRegistrationNumber: string | null;
  bizCeoName: string | null;
  bizOpenDate: Date | null;
  bizCeoPhone: string | null;
  bizCeoEmail: string | null;
  bizZipCode: string | null;
  bizAddress: string | null;
  bizAddressDetail: string | null;
  bizCategory: string | null;
  bizItem: string | null;
  bizVerifiedAt: Date | null;
};

/** 본사 사업자정보를 예전 bp_codes 칸 이름으로. 본사가 없으면(있어선 안 된다) 모두 비어 있다. */
export function hqBizOf(bp: { stores: HqProfileRow[] }): HqBiz {
  const p = bp.stores[0]?.businessProfile;
  return {
    tradeName: p?.bizTradeName ?? '',
    bizRegistrationNumber: p?.bizRegistrationNumber ?? null,
    bizCeoName: p?.bizCeoName ?? null,
    bizOpenDate: p?.bizOpenDate ?? null,
    bizCeoPhone: p?.bizCeoPhone ?? null,
    bizCeoEmail: p?.bizCeoEmail ?? null,
    bizZipCode: p?.bizZipCode ?? null,
    bizAddress: p?.bizAddress ?? null,
    bizAddressDetail: p?.bizAddressDetail ?? null,
    bizCategory: p?.bizCategory ?? null,
    bizItem: p?.bizItem ?? null,
    bizVerifiedAt: p?.bizVerifiedAt ?? null,
  };
}

/** 본사 점포의 좌표 · 위치 적용(본사 직원 출퇴근 반경 기준). 위도 · 경도는 숫자로. */
export function hqLocationOf(bp: { stores: HqProfileRow[] }): {
  latitude: number | null;
  longitude: number | null;
  isLocationApplied: boolean;
} {
  const s = bp.stores[0];
  return {
    latitude: s?.latitude == null ? null : Number(s.latitude),
    longitude: s?.longitude == null ? null : Number(s.longitude),
    isLocationApplied: s?.isLocationApplied ?? true,
  };
}
