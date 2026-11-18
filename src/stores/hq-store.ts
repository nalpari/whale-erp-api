import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { claimStoreCode } from './next-store-code';
import {
  missingForOperation,
  retainEndDate,
  statusLabel,
} from './store-format';

/**
 * 본사 점포(stores.is_hq, 2026-11-17) — BP 마다 하나, 직영. 가입 · 플랫폼 BP 등록 때 시스템이 만들고, 점포 관리에는
 * 나오지 않는다. BP 상호명 · 사업자정보는 이 점포의 사업자정보(store_business_profiles)에 있다.
 * 상태는 사람이 고르지 않는다 — 일반 점포의 운영 조건(사업자 인증 · 좌표 · BP 사용)을 채우면 운영, 하나라도 빠지면
 * 미운영(운영 중에도 잃으면 내려간다, 사용자 결정). BP 탈퇴(폐점)와 BP 삭제(폐점 · 삭제)만 닫는다.
 */

type Tx = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | 'store' | 'storeBusinessProfile' | 'storeChangeHistory'
>;

/** 본사 점포 상태 — 일반 점포의 운영 전환 조건과 같은 함수로 판정한다. */
export function hqStatusOf(
  s: Parameters<typeof missingForOperation>[0],
): 'OPERATING' | 'NOT_OPERATING' {
  return missingForOperation(s).length ? 'NOT_OPERATING' : 'OPERATING';
}

/** 본사 사업자정보 칸(store_business_profiles 의 biz_* 와 같은 이름). 상호명은 tradeName 으로 따로 받는다. */
export type HqBizInput = Partial<{
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
}>;

/** 받은 좌표 칸. 빠진 칸(undefined)은 그대로 둔다 — 위도 · 경도는 둘 다 있거나 둘 다 없다(hqLocationInput 이 맞춘다). */
export type HqLocationInput = {
  latitude?: number | null;
  longitude?: number | null;
  /** 생략하면 그대로 둔다(만들 때는 사용) — 좌표를 다시 보내며 이 칸을 빼먹어도 「사용 안 함」이 켜지지 않게 */
  isLocationApplied?: boolean;
};

/** 저장된 본사 좌표 — 이력의 전 값. */
type HqLocationRow = {
  latitude: number | null;
  longitude: number | null;
  isLocationApplied: boolean;
};

/**
 * 받은 좌표 칸을 저장할 값으로 — 위도 · 경도는 함께 넣거나(null 이면 지움) 함께 생략한다(그대로, 점포 등록과 같은 문구).
 * 위치 적용은 따로 바꿀 수 있다(좌표 없이 이 칸만 보내도 반영). 셋 다 생략하면 undefined — 좌표를 모르는 옛 화면이
 * 저장해도 지워지지 않게.
 */
export function hqLocationInput(dto: {
  latitude?: number | null;
  longitude?: number | null;
  isLocationApplied?: boolean;
}): HqLocationInput | undefined {
  const coordsOmitted =
    dto.latitude === undefined && dto.longitude === undefined;
  if (coordsOmitted && dto.isLocationApplied === undefined) return undefined;
  if (coordsOmitted) return { isLocationApplied: dto.isLocationApplied };
  const latitude = dto.latitude ?? null;
  const longitude = dto.longitude ?? null;
  if ((latitude === null) !== (longitude === null))
    throw new BadRequestException('위도 · 경도는 함께 넣거나 함께 비웁니다.');
  return {
    latitude,
    longitude,
    isLocationApplied: dto.isLocationApplied,
  };
}

/** 본사 점포 이력의 칸 이름 — 플랫폼 BP 이력이 쓰던 이름 그대로. */
const HQ_FIELD_LABELS: [keyof HqBizInput, string][] = [
  ['bizRegistrationNumber', '사업자등록번호'],
  ['bizCeoName', '대표자명'],
  ['bizOpenDate', '개업일자'],
  ['bizCeoPhone', '대표자 연락처'],
  ['bizCeoEmail', '대표자 이메일'],
  ['bizZipCode', '사업장 우편번호'],
  ['bizAddress', '사업장 기본주소'],
  ['bizAddressDetail', '사업장 상세주소'],
  ['bizCategory', '업태'],
  ['bizItem', '종목'],
];

const text = (v: string | Date | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : v;

/**
 * 본사 사업자정보를 고친다 — 플랫폼 BP 수정 · 마이페이지 BP 사업자정보가 트랜잭션 안에서 부른다. 상호명은 본사 점포명도
 * 같이 바꾸고(본사는 점포 관리에서 고칠 수 없다), 사업장 주소는 본사 점포 주소로, location 을 주면 좌표 · 위치 적용도
 * 넣는다. 바뀐 칸만 본사 점포 이력에 남기고(설계 D5, 2026-11-17), 끝에서 상태를 다시 정한다.
 * biz 는 받은 칸만 고친다(빠진 칸은 그대로) — 전체 치환인 호출자는 빈 칸을 null 로 채워 넘긴다.
 * verified 는 진위확인을 통과한 세 값과 인증일시(없으면 그대로 둔다).
 */
export async function saveHqProfile(
  tx: Tx,
  input: {
    bpCodeId: number;
    hqStoreId: number;
    before: { tradeName: string } & Required<HqBizInput> & HqLocationRow;
    tradeName: string;
    biz: HqBizInput;
    verified?: {
      bizRegistrationNumber: string | null;
      bizCeoName: string | null;
      bizOpenDate: Date | null;
      bizVerifiedAt: Date | null;
    } | null;
    location?: HqLocationInput;
    by: number;
  },
): Promise<void> {
  const {
    bpCodeId,
    hqStoreId: storeId,
    before,
    tradeName,
    location,
    by,
  } = input;
  const biz: HqBizInput = { ...input.biz, ...(input.verified ?? {}) };
  await tx.storeBusinessProfile.update({
    where: { storeId },
    data: { bizTradeName: tradeName, ...biz, updatedBy: by },
  });
  const after = { ...before, ...biz };
  await tx.store.update({
    where: { storeId },
    data: {
      name: tradeName.slice(0, STORE_NAME_MAX),
      zipCode: after.bizZipCode,
      address: after.bizAddress,
      addressDetail: after.bizAddressDetail,
      ...(location?.latitude !== undefined && {
        latitude: location.latitude,
        longitude: location.longitude ?? null,
      }),
      ...(location?.isLocationApplied !== undefined && {
        isLocationApplied: location.isLocationApplied,
      }),
      updatedBy: by,
    },
  });

  const changes: {
    field: string;
    beforeValue: string | null;
    afterValue: string | null;
  }[] = [];
  const push = (field: string, b: string | null, a: string | null) => {
    if (b !== a) changes.push({ field, beforeValue: b, afterValue: a });
  };
  push('상호명', before.tradeName, tradeName);
  for (const [key, label] of HQ_FIELD_LABELS)
    if (key in biz) push(label, text(before[key]), text(biz[key]));
  if (location) {
    const coord = (lat: number | null, lng: number | null) =>
      lat === null || lng === null ? null : `${lat}, ${lng}`;
    if (location.latitude !== undefined)
      push(
        '위도 · 경도',
        coord(before.latitude, before.longitude),
        coord(location.latitude, location.longitude ?? null),
      );
    if (location.isLocationApplied !== undefined)
      push(
        '위치 적용',
        before.isLocationApplied ? '사용' : '사용 안 함',
        location.isLocationApplied ? '사용' : '사용 안 함',
      );
  }
  await recordHq(tx, storeId, by, changes);
  await syncHqStatus(tx, bpCodeId, by);
}

/** 점포명은 1~50자다(stores_name_length). 상호명도 50자까지라 보통 그대로지만 DB 가 막지 않게 자른다. */
const STORE_NAME_MAX = 50;

/**
 * 본사 점포를 만든다 — 가입 · 플랫폼 BP 등록의 트랜잭션 안에서 부른다. 사업장 주소는 본사 점포 주소에도 넣고, 좌표를
 * 받으면 함께 넣는다. 상태는 hqStatusOf 로 정한다(가입은 좌표가 없어 늘 미운영).
 */
export async function createHqStore(
  tx: Tx,
  input: {
    bpCodeId: number;
    bpAccountStatusCode: string;
    tradeName: string;
    biz: HqBizInput;
    location?: HqLocationInput;
    by: number | null;
  },
): Promise<{ storeId: number; storeCode: string }> {
  const { bpCodeId, tradeName, biz, location, by } = input;
  const storeCode = await claimStoreCode(tx);
  const name = tradeName.slice(0, STORE_NAME_MAX);
  const store = await tx.store.create({
    data: {
      storeCode,
      bpCodeId,
      storeTypeCode: 'DIRECT',
      name,
      zipCode: biz.bizZipCode ?? null,
      address: biz.bizAddress ?? null,
      addressDetail: biz.bizAddressDetail ?? null,
      ...(location
        ? {
            latitude: location.latitude ?? null,
            longitude: location.longitude ?? null,
            isLocationApplied: location.isLocationApplied ?? true,
          }
        : {}),
      isHq: true,
      storeStatusCode: hqStatusOf({
        bizRegistrationNumber: biz.bizRegistrationNumber ?? null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        bpAccountStatusCode: input.bpAccountStatusCode,
      }),
      createdBy: by,
    },
    select: { storeId: true, storeCode: true },
  });
  await tx.storeBusinessProfile.create({
    data: {
      storeId: store.storeId,
      bizTradeName: tradeName,
      ...biz,
      createdBy: by,
    },
  });
  await recordHq(tx, store.storeId, by, [
    { field: '등록', beforeValue: null, afterValue: name },
  ]);
  return store;
}

/**
 * 본사 값(사업자번호 · 좌표 · BP 상태)이 바뀐 트랜잭션 끝에서 부른다 — 조건으로 상태를 다시 정하고, 바뀌면
 * 「점포상태」 이력을 남긴다. 폐점한 본사(탈퇴)는 다시 열지 않는다.
 */
export async function syncHqStatus(
  tx: Tx,
  bpCodeId: number,
  by: number | null,
): Promise<void> {
  // 본사 행을 잠근 뒤 읽는다 — BP 상태 변경과 좌표 · 사업자번호 저장이 겹치면 잠그지 않은 읽기는 서로의 커밋 전 값을 봐
  // 「BP 미사용인데 본사 운영」처럼 조건과 다른 상태가 남는다. 수정 쪽은 이미 본사 행을 update 로 잠그므로 한 줄로 선다.
  // FOR UPDATE 가 아닌 까닭은 점포 폐점과 같다 — 본사를 외래키로 가리키는 행(출퇴근 · 근로계약 · 시설물 등) 삽입의
  // KEY SHARE 와 부딪치지 않게 한다. 그 삽입과 줄을 세워야 하는 BP 삭제(remove)만 FOR UPDATE 로 잠근다.
  await tx.$executeRaw`SELECT 1 FROM stores WHERE bp_code_id = ${bpCodeId} AND is_hq AND NOT is_deleted FOR NO KEY UPDATE`;
  const hq = await tx.store.findFirst({
    where: { bpCodeId, isHq: true, isDeleted: false },
    select: {
      storeId: true,
      storeStatusCode: true,
      latitude: true,
      longitude: true,
      businessProfile: { select: { bizRegistrationNumber: true } },
      bpCode: { select: { accountStatusCode: true } },
    },
  });
  if (!hq || hq.storeStatusCode === 'CLOSED') return;
  const next = hqStatusOf({
    bizRegistrationNumber: hq.businessProfile?.bizRegistrationNumber ?? null,
    latitude: hq.latitude,
    longitude: hq.longitude,
    bpAccountStatusCode: hq.bpCode.accountStatusCode,
  });
  if (next === hq.storeStatusCode) return;
  await tx.store.update({
    where: { storeId: hq.storeId },
    data: { storeStatusCode: next, updatedBy: by },
  });
  await recordHq(tx, hq.storeId, by, [
    {
      field: '점포상태',
      beforeValue: statusLabel(hq.storeStatusCode),
      afterValue: statusLabel(next),
    },
  ]);
}

/** 본사 점포 변경 이력 — 점포 관리와 같은 표(store_change_histories), 5년 보존. */
export async function recordHq(
  tx: Pick<Prisma.TransactionClient, 'storeChangeHistory'>,
  storeId: number,
  changedBy: number | null,
  changes: {
    field: string;
    beforeValue: string | null;
    afterValue: string | null;
  }[],
): Promise<void> {
  if (!changes.length) return;
  const until = retainEndDate();
  await tx.storeChangeHistory.createMany({
    data: changes.map((c) => ({
      storeId,
      ...c,
      changedBy,
      retainEndDate: until,
    })),
  });
}
