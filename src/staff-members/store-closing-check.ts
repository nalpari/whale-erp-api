import { NotFoundException } from '@nestjs/common';
import type { ContractStatus, PayslipStatus, Prisma } from '@prisma/client';
import { hidesPersonalData } from '../admin-scope/admin-scope.service';
import { hqSharingConsentedOf } from '../admin-scope/hq-sharing';
import { checkOutExpired, openCheckInsOf } from '../attendance/open-check-ins';
import { PENDING_CONTRACT_STATUSES } from './retirement.service';

type Db = Prisma.TransactionClient;

const STORE_NOT_FOUND = '점포를 찾을 수 없습니다.';

/** 확정하지 않은 급여명세서 — 작성 중 · 검토 중 */
const UNCONFIRMED_PAYSLIP_STATUSES: PayslipStatus[] = ['DRAFTING', 'REVIEWING'];

export interface StoreClosingOpenCheckIn {
  /** 그 출근의 점포 — 합계의 첫 건이 어느 점포인지 안다 */
  storeId: number;
  attendanceRecordId: number;
  staffMemberId: number;
  name: string;
  recordedAt: Date;
  /** 출근한 다음 날이 지나 직원 앱으로는 퇴근할 수 없다 — 관리자 보정으로 닫는다 */
  isCheckOutExpired: boolean;
}

/** 점포별 결과와 합계에 같이 쓰는 칸 */
export interface StoreClosingCounts {
  openCheckIns: {
    /** 이름을 내보내는 열린 출근 수 — 가려지는 직원 것은 빠진다. 막을지 판단할 때는 `count + hiddenCount` 를 본다 */
    count: number;
    /**
     * 본사 역할에게 가려지는 직원(`hidesPersonalData` — 본사 제공 동의를 하지 않은 가맹 직원, 폐점한 가맹 점포면 동의한 직원도)의
     * 열린 출근 수 — 이름 없이 수만(2026-11-03 재영). 부르는 관리자와 상관없이 늘 이 기준이다
     */
    hiddenCount: number;
    /** 이름을 내보내는 것 가운데 출근 시각이 가장 이른 것. 없으면 null — 가려지는 직원 것은 고르지 않는다 */
    first: StoreClosingOpenCheckIn | null;
  };
  /** 퇴직될 직원 수 — 폐점 순간의 퇴직(`retireStore`, WHALEERP-648)의 `retiringStaff` 와 같은 기준 */
  retiringStaff: number;
  /** 폐점하면 종료될 임시저장 계약 수 — 이하 `retireStore` 의 같은 이름 칸과 같은 범위(점포의 대기 계약) */
  draftContracts: number;
  /** 폐점하면 종료될 발송 대기 계약 수 */
  pendingSendContracts: number;
  /** 폐점하면 종료될 서명 대기 + 수정 요청 계약 수 */
  pendingSignatureContracts: number;
  /** 확정하지 않은(작성 중 · 검토 중) 급여명세서 수 */
  unconfirmedPayslips: number;
}

export interface StoreClosingCheck {
  /** 점포별 결과 — id 오름차순. 회원 탈퇴 화면이 점포마다 열린 출근 수와 이름을 내보낼 수 있는 첫 건을 보인다 */
  stores: (StoreClosingCounts & { storeId: number })[];
  /** 같은 칸의 합 — `openCheckIns.first` 는 이름을 내보내는 것 가운데 전체에서 가장 이른 것 */
  total: StoreClosingCounts;
}

/**
 * 퇴직될 직원 — 폐점 순간의 퇴직(`retireStore`, WHALEERP-648)이 `retiringStaff` 로 세는 대상과 같다. 점포의 재직 레코드에서
 * 임시저장 계약만 있는 가입 전 레코드(`isDraftOnlyPreJoin`)는 세지 않는다 — 그 레코드도 퇴직일은 정해지고 임시저장은 닫히지만,
 * 수는 `draftContracts` 로 드러난다.
 */
const retiringStaff = (storeIds: number[]) =>
  ({
    storeId: { in: storeIds },
    employmentStatus: 'EMPLOYED',
    OR: [
      { joinStatus: 'JOINED' },
      { contracts: { some: { status: { not: 'DRAFT' } } } },
    ],
  }) as const satisfies Prisma.StaffMemberWhereInput;

/** 본사 역할 — 가림 판정의 기준. 폐점 확인은 부르는 관리자를 받지 않으므로 늘 본사 역할 기준으로 가린다 */
const HQ_ROLE = 'BM';

/**
 * 폐점 확인(WHALEERP-647 · 650, 운영 정책 CTR-31) — 1팀 점포 폐점 · 회원 탈퇴가 폐점 전에 부르려는 읽기 전용 검사. 점포 하나는
 * `[storeId]` 로 부른다. 점포 수만큼 쿼리가 늘지 않게 표마다 IN 으로 한 번에 묻는다. 중복 id 는 한 번만 센다. 점포 수정 화면 · 폐점 확인
 * 팝업 · 폐점 저장 직전(1팀 트랜잭션 안)이 같은 값을 보도록 받은 `client`(PrismaService 또는 트랜잭션)로만 읽고 쓰지 않는다.
 * 업무 범위 · 권한은 부르는 쪽이 이미 봤다고 보고, 폐점을 막을지도 부르는 쪽이 정한다.
 *
 * 저장 직전에는 어느 점포도 닫기 전에 모든 점포를 한 번에 부른다 — CLOSED 로 바꾼 뒤면 가맹 점포는 동의한 직원까지 가려 `first` 가
 * 비고(`count + hiddenCount` 는 그대로), 폐점 순간의 퇴직(`retireStores`) 뒤면 대기 계약이 닫혀 계약 수가 0이 된다. 퇴직될 직원 ·
 * 계약 칸은 `stores[n]` 이 `retireStores` 반환의 `byStore[storeId]` 와, `total` 이 그 `total` 과 같은 이름 · 뜻이다.
 *
 * - 열린 출근: 관리자 열린 출근 조회(WHALEERP-644)와 같은 조건(`openCheckInsOf` — 보정할 수 있는 3개월 안)이되 재직 레코드의
 *   것만 — `retireStore` 가 막는 범위(재직 레코드의 `assertNoOpenCheckIn`)와 같게. 이미 퇴직한 레코드의 열린 출근은 폐점을 막지
 *   않는다. 본사 역할에게 가려지는 가맹 직원은 첫 건 이름으로 내보내지 않고 수만 센다(부르는 관리자를 받지 않아 늘 본사 역할
 *   기준, 2026-11-03 재영). 막을지 판단은 `total` 의 `count + hiddenCount` 로 한다 — `retireStore` 도 재직 레코드의 열린 출근이
 *   있으면 409 `OPEN_CHECK_IN` 으로 폐점째 되돌리므로, 확인 화면이 미리 알려 그 실패를 피하게 하는 자리다.
 * - 계약: 점포의 대기 계약(`contracts.store_id`, 임시저장 · 발송 대기 · 서명 대기 · 수정 요청)을 상태별로 센다 — `retireStore`
 *   가 폐점 순간 종료로 닫는 범위다(임시저장만 있는 가입 전 레코드의 임시저장, 이미 퇴직한 레코드의 대기 계약 포함). 체결 완료
 *   계약은 닫히지 않는다.
 * - 퇴직될 직원: 위 `retiringStaff`. `closedDate` 는 `retireStore` 와 같은 입력으로 받지만 지금 규칙에서는 수를 바꾸지 않는다 —
 *   퇴직일이 폐점일 이전 · 같은 날인 레코드도 센다.
 * - 급여명세서: 점포의 작성 중 · 검토 중 명세서. 퇴직해도 지워지지 않는다.
 *
 * 잠그지 않고 읽는다 — 확인과 저장 사이에 바뀐 것은 `retireStores` 가 잠근 뒤 다시 본다(열린 출근은 409, 계약 · 직원은 잠근 뒤의
 * 값으로 닫고 센다). 그래서 이 검사만으로 폐점하면 안 되고 `retireStores` 를 함께 불러야 한다.
 *
 * 없거나 지운 점포가 섞이면 404(문구에 id) — 일부만 세어 돌려주면 막아야 할 폐점을 통과시킬 수 있다. 빈 배열이면 쿼리 없이 빈 목록과
 * 0 이다.
 */
export async function storeClosingCheck(
  client: Db,
  storeIds: number[],
  closedDate: Date,
  now: Date = new Date(),
): Promise<StoreClosingCheck> {
  const ids = [...new Set(storeIds)].sort((a, b) => a - b);
  if (ids.length === 0) return { stores: [], total: totalOf([]) };
  const [stores, rows, contracts, retiring, payslips] = await Promise.all([
    client.store.findMany({
      where: { storeId: { in: ids }, isDeleted: false },
      select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
    }),
    openCheckInsOf(client, ids, { employedOnly: true }),
    client.contract.groupBy({
      by: ['storeId', 'status'],
      where: {
        storeId: { in: ids },
        status: { in: PENDING_CONTRACT_STATUSES },
      },
      _count: { _all: true },
    }),
    client.staffMember.groupBy({
      by: ['storeId'],
      where: retiringStaff(ids),
      _count: { _all: true },
    }),
    client.payslip.groupBy({
      by: ['storeId'],
      where: {
        storeId: { in: ids },
        status: { in: UNCONFIRMED_PAYSLIP_STATUSES },
      },
      _count: { _all: true },
    }),
  ]);
  const storeOf = new Map(stores.map((s) => [s.storeId, s]));
  const missing = ids.filter((id) => !storeOf.has(id));
  if (missing.length > 0)
    throw new NotFoundException(`${STORE_NOT_FOUND} (${missing.join(', ')})`);
  const countOf = (
    groups: { storeId: number; _count: { _all: number } }[],
    storeId: number,
  ) => groups.find((g) => g.storeId === storeId)?._count._all ?? 0;
  const result = ids.map((storeId) => {
    const store = storeOf.get(storeId);
    const own = rows.filter((r) => r.storeId === storeId);
    const shown = own.filter(
      (r) =>
        !hidesPersonalData(HQ_ROLE, store, hqSharingConsentedOf(r.staffMember)),
    );
    const head = shown[0];
    const ending = (...statuses: ContractStatus[]) =>
      contracts
        .filter(
          (c) =>
            c.storeId === storeId &&
            c.status !== null &&
            statuses.includes(c.status),
        )
        .reduce((sum, c) => sum + c._count._all, 0);
    return {
      storeId,
      openCheckIns: {
        count: shown.length,
        hiddenCount: own.length - shown.length,
        first: head
          ? {
              storeId,
              attendanceRecordId: head.attendanceRecordId,
              staffMemberId: head.staffMember.staffMemberId,
              name: head.staffMember.name,
              recordedAt: head.recordedAt,
              isCheckOutExpired: checkOutExpired(head.recordedAt, now),
            }
          : null,
      },
      retiringStaff: countOf(retiring, storeId),
      draftContracts: ending('DRAFT'),
      pendingSendContracts: ending('PENDING_SEND'),
      pendingSignatureContracts: ending(
        'PENDING_SIGNATURE',
        'CORRECTION_REQUESTED',
      ),
      unconfirmedPayslips: countOf(payslips, storeId),
    };
  });
  return { stores: result, total: totalOf(result) };
}

/** 점포별 결과의 합 — 첫 건은 이름을 내보내는 것 가운데 전체에서 출근 시각이 가장 이른 것(같으면 기록 id 가 작은 것) */
function totalOf(stores: StoreClosingCounts[]): StoreClosingCounts {
  const sum = (pick: (s: StoreClosingCounts) => number) =>
    stores.reduce((acc, s) => acc + pick(s), 0);
  const first =
    stores
      .flatMap((s) => s.openCheckIns.first ?? [])
      .sort(
        (a, b) =>
          a.recordedAt.getTime() - b.recordedAt.getTime() ||
          a.attendanceRecordId - b.attendanceRecordId,
      )[0] ?? null;
  return {
    openCheckIns: {
      count: sum((s) => s.openCheckIns.count),
      hiddenCount: sum((s) => s.openCheckIns.hiddenCount),
      first,
    },
    retiringStaff: sum((s) => s.retiringStaff),
    draftContracts: sum((s) => s.draftContracts),
    pendingSendContracts: sum((s) => s.pendingSendContracts),
    pendingSignatureContracts: sum((s) => s.pendingSignatureContracts),
    unconfirmedPayslips: sum((s) => s.unconfirmedPayslips),
  };
}
