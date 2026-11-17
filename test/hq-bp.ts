import { randomInt } from 'node:crypto';
import type { BpCode, Prisma } from '@prisma/client';

/**
 * 시험용 BP 생성 · 정리 — 20261117150907_team1_hq_stores 뒤로 BP 상호명 · 사업자정보는 bp_codes 가 아니라
 * BP 의 본사 점포(stores.is_hq) 사업자정보(store_business_profiles)에 있다. 옛 bpCode.create 의 data 를
 * 그대로 받아 bp_codes 행과 본사 점포 · 사업자정보를 함께 만들고, 정리할 때는 본사 점포 쪽을 먼저 지운다
 * (stores · store_business_profiles · store_change_histories 의 FK 가 모두 RESTRICT).
 */

type Client = Pick<
  Prisma.TransactionClient,
  'bpCode' | 'store' | 'storeBusinessProfile' | 'storeChangeHistory'
>;

/** 옛 bp_codes 의 상호명 · 사업자정보 칸 — 지금은 본사 점포 사업자정보(biz_trade_name 등)로 간다. */
export type HqBizFields = {
  tradeName?: string | null;
  bizRegistrationNumber?: string | null;
  bizCeoName?: string | null;
  bizOpenDate?: Date | null;
  bizCeoPhone?: string | null;
  bizCeoEmail?: string | null;
  bizZipCode?: string | null;
  bizAddress?: string | null;
  bizAddressDetail?: string | null;
  bizCategory?: string | null;
  bizItem?: string | null;
  bizVerifiedAt?: Date | null;
};

export type CreateBpData = Prisma.BpCodeUncheckedCreateInput & HqBizFields;

/** 점포명은 1~50자(stores_name_length). */
const STORE_NAME_MAX = 50;

/**
 * 본사 점포코드 — 시험들이 직접 고르는 코드(대개 ST100000~ST999999)와 앱의 채번(최댓값 + 1)을 피해
 * ST000001~ST099999 에서 비어 있는 것을 고른다.
 */
export async function freeStoreCode(
  client: Pick<Prisma.TransactionClient, 'store'>,
): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = `ST${String(randomInt(1, 100_000)).padStart(6, '0')}`;
    const taken = await client.store.findFirst({
      where: { storeCode: code },
      select: { storeId: true },
    });
    if (!taken) return code;
  }
  throw new Error('본사 점포코드를 고르지 못했습니다.');
}

/**
 * BP 와 그 본사 점포(직영 · is_hq) · 사업자정보를 만든다. data 는 옛 bpCode.create 의 data 모양이다(select 등은
 * 무시하고 행 전체를 돌려준다). 삭제된 BP 의 본사는 폐점 · 삭제로 만든다(살아 있는 본사는 BP 마다 하나).
 */
export async function createBp(
  client: Client,
  args: { data: CreateBpData; select?: unknown },
): Promise<BpCode & { hqStoreId: number }> {
  const {
    tradeName,
    bizRegistrationNumber,
    bizCeoName,
    bizOpenDate,
    bizCeoPhone,
    bizCeoEmail,
    bizZipCode,
    bizAddress,
    bizAddressDetail,
    bizCategory,
    bizItem,
    bizVerifiedAt,
    ...bpData
  } = args.data;
  const bp = await client.bpCode.create({ data: bpData });
  const name = (tradeName || `시험 본사 ${bp.bpCode}`).slice(0, STORE_NAME_MAX);
  const deleted = bp.isDeleted;
  const store = await client.store.create({
    data: {
      storeCode: await freeStoreCode(client),
      bpCodeId: bp.bpCodeId,
      storeTypeCode: 'DIRECT',
      name,
      zipCode: bizZipCode ?? null,
      address: bizAddress ?? null,
      addressDetail: bizAddressDetail ?? null,
      isHq: true,
      storeStatusCode: deleted ? 'CLOSED' : 'NOT_OPERATING',
      ...(deleted ? { isDeleted: true, closedDate: new Date() } : {}),
    },
    select: { storeId: true },
  });
  await client.storeBusinessProfile.create({
    data: {
      storeId: store.storeId,
      bizTradeName: tradeName ?? null,
      bizRegistrationNumber: bizRegistrationNumber ?? null,
      bizCeoName: bizCeoName ?? null,
      bizOpenDate: bizOpenDate ?? null,
      bizCeoPhone: bizCeoPhone ?? null,
      bizCeoEmail: bizCeoEmail ?? null,
      bizZipCode: bizZipCode ?? null,
      bizAddress: bizAddress ?? null,
      bizAddressDetail: bizAddressDetail ?? null,
      bizCategory: bizCategory ?? null,
      bizItem: bizItem ?? null,
      bizVerifiedAt: bizVerifiedAt ?? null,
    },
  });
  return { ...bp, hqStoreId: store.storeId };
}

/** BP 의 살아 있는 본사 점포와 사업자정보(시험이 상호명 · 사업자정보를 읽을 때). */
export async function findHq(
  client: Pick<Prisma.TransactionClient, 'store'>,
  bpCodeId: number,
) {
  return client.store.findFirstOrThrow({
    where: { bpCodeId, isHq: true, isDeleted: false },
    include: { businessProfile: true },
  });
}

/** where 에서 지울 BP id 를 정한다 — 값이 비어 모든 BP 에 걸리는 조건은 아무것도 지우지 않는다. */
async function resolveBpIds(
  client: Client,
  target: number | number[] | { where: Prisma.BpCodeWhereInput },
): Promise<number[]> {
  if (typeof target === 'number') return [target];
  if (Array.isArray(target)) return target.filter((id) => Number.isInteger(id));
  const { where } = target;
  const defined = Object.entries(where ?? {}).filter(
    ([, v]) => v !== undefined,
  );
  if (defined.length === 0) return [];
  const id = where.bpCodeId;
  if (typeof id === 'number') return [id];
  if (id && typeof id === 'object' && 'in' in id && Array.isArray(id.in))
    return id.in.filter((v): v is number => Number.isInteger(v));
  const rows = await client.bpCode.findMany({
    where: { AND: [where, { isPlatform: false }] },
    select: { bpCodeId: true },
  });
  return rows.map((r) => r.bpCodeId);
}

/**
 * BP 들의 본사 점포(is_hq, 삭제 포함)와 그 이력 · 사업자정보를 지운다 — bp_codes 행은 남긴다. 시험이 BP 를
 * 지우기 전에 본사를 따로 치워야 할 때 쓴다.
 */
export async function deleteHqStores(
  client: Client,
  target: number | number[] | { where: Prisma.BpCodeWhereInput },
): Promise<number[]> {
  const ids = await resolveBpIds(client, target);
  if (ids.length === 0) return ids;
  const hq = await client.store.findMany({
    where: { bpCodeId: { in: ids }, isHq: true },
    select: { storeId: true },
  });
  const byStore = { storeId: { in: hq.map((s) => s.storeId) } };
  if (hq.length) {
    await client.storeChangeHistory.deleteMany({ where: byStore });
    await client.storeBusinessProfile.deleteMany({ where: byStore });
    await client.store.deleteMany({ where: byStore });
  }
  return ids;
}

/**
 * BP 를 지운다 — 본사 점포의 이력 · 사업자정보 · 점포를 먼저, 그다음 bp_codes 행. 옛
 * `prisma.bpCode.deleteMany({ where })` 자리에 `deleteBps(prisma, { where })` 로 쓰거나 id 배열을 넘긴다.
 * 플랫폼 BP 는 where 로 찾지 않는다. API 로 만든 BP(가입 · 플랫폼 BP 등록)의 본사도 같이 지운다.
 */
export async function deleteBps(
  client: Client,
  target: number | number[] | { where: Prisma.BpCodeWhereInput },
): Promise<void> {
  const ids = await deleteHqStores(client, target);
  if (ids.length === 0) return;
  await client.bpCode.deleteMany({ where: { bpCodeId: { in: ids } } });
}
