import type { ContractStatus, PayslipStatus, Prisma } from '@prisma/client';
import { hidesPersonalData } from '../admin-scope/admin-scope.service';
import { hqSharingConsentedOf } from '../admin-scope/hq-sharing';
import { checkOutExpired, openCheckInsOf } from '../attendance/open-check-ins';
import { PENDING_CONTRACT_STATUSES } from './retirement.service';

type Db = Prisma.TransactionClient;

/** 확정하지 않은 급여명세서 — 작성 중 · 검토 중 */
const UNCONFIRMED_PAYSLIP_STATUSES: PayslipStatus[] = ['DRAFTING', 'REVIEWING'];

export interface StoreClosingOpenCheckIn {
  attendanceRecordId: number;
  staffMemberId: number;
  name: string;
  recordedAt: Date;
  /** 출근한 다음 날이 지나 직원 앱으로는 퇴근할 수 없다 — 관리자 보정으로 닫는다 */
  isCheckOutExpired: boolean;
}

export interface StoreClosingCheck {
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

/**
 * 퇴직될 직원 — 폐점 순간의 퇴직(`retireStore`, WHALEERP-648)이 `retiringStaff` 로 세는 대상과 같다. 점포의 재직 레코드에서
 * 임시저장 계약만 있는 가입 전 레코드(`isDraftOnlyPreJoin`)는 세지 않는다 — 그 레코드도 퇴직일은 정해지고 임시저장은 닫히지만,
 * 수는 `draftContracts` 로 드러난다.
 */
const retiringStaff = (storeId: number) =>
  ({
    storeId,
    employmentStatus: 'EMPLOYED',
    OR: [
      { joinStatus: 'JOINED' },
      { contracts: { some: { status: { not: 'DRAFT' } } } },
    ],
  }) as const satisfies Prisma.StaffMemberWhereInput;

/** 본사 역할 — 가림 판정의 기준. 폐점 확인은 부르는 관리자를 받지 않으므로 늘 본사 역할 기준으로 가린다 */
const HQ_ROLE = 'BM';

/**
 * 폐점 확인(WHALEERP-647, 운영 정책 CTR-31) — 1팀 점포 폐점이 폐점 전에 부르는 읽기 전용 검사. 점포 수정 화면 · 폐점 확인
 * 팝업 · 폐점 저장 직전(1팀 트랜잭션 안)이 같은 값을 보도록 받은 `client`(PrismaService 또는 트랜잭션)로만 읽고 쓰지 않는다.
 * 업무 범위 · 권한은 부르는 쪽이 이미 봤다고 보고, 폐점을 막을지도 부르는 쪽이 정한다. 저장 직전에는 폐점 순간의 퇴직
 * (`retireStore`)보다 먼저 부른다 — 뒤에 부르면 대기 계약이 이미 닫혀 계약 수가 0이 된다. 퇴직될 직원 · 계약 칸은 `retireStore`
 * 의 반환과 같은 이름 · 뜻이다(1팀이 폐점 결과 안내에 같이 쓴다).
 *
 * - 열린 출근: 관리자 열린 출근 조회(WHALEERP-644)와 같은 조건(`openCheckInsOf` — 보정할 수 있는 3개월 안)이되 재직 레코드의
 *   것만 — `retireStore` 가 막는 범위(재직 레코드의 `assertNoOpenCheckIn`)와 같게. 이미 퇴직한 레코드의 열린 출근은 폐점을 막지
 *   않는다. 본사 역할에게 가려지는 가맹 직원은 첫 건 이름으로 내보내지 않고 수만 센다(부르는 관리자를 받지 않아 늘 본사 역할
 *   기준, 2026-11-03 재영). 막을지 판단은 `count + hiddenCount` 로 한다 — `retireStore` 도 재직 레코드의 열린 출근이 있으면
 *   409 `OPEN_CHECK_IN` 으로 폐점째 되돌리므로, 확인 화면이 미리 알려 그 실패를 피하게 하는 자리다.
 * - 계약: 점포의 대기 계약(`contracts.store_id`, 임시저장 · 발송 대기 · 서명 대기 · 수정 요청)을 상태별로 센다 — `retireStore`
 *   가 폐점 순간 종료로 닫는 범위다(임시저장만 있는 가입 전 레코드의 임시저장 포함). 체결 완료 계약은 닫히지 않는다.
 * - 퇴직될 직원: 위 `retiringStaff`. `closedDate` 는 `retireStore` 와 같은 입력으로 받지만 지금 규칙에서는 수를 바꾸지 않는다 —
 *   퇴직일이 폐점일 이전 · 같은 날인 레코드도 센다.
 * - 급여명세서: 점포의 작성 중 · 검토 중 명세서. 퇴직해도 지워지지 않는다.
 *
 * 잠그지 않고 읽는다 — 확인과 저장 사이에 바뀐 것은 `retireStore` 가 잠근 뒤 다시 본다(열린 출근은 409, 계약 · 직원은 잠근 뒤의
 * 값으로 닫고 센다).
 *
 * 점포가 없으면 Prisma 의 `PrismaClientKnownRequestError`(P2025)를 그대로 던진다(부르는 쪽이 이미 확인한 값이다).
 * 입력은 일감대로 `client`(PrismaService 또는 트랜잭션) · `storeId` · `closedDate` 다.
 */
export async function storeClosingCheck(
  client: Db,
  storeId: number,
  closedDate: Date,
  now: Date = new Date(),
): Promise<StoreClosingCheck> {
  const [store, rows, contracts, retiring, unconfirmedPayslips] =
    await Promise.all([
      client.store.findUniqueOrThrow({
        where: { storeId },
        select: { storeTypeCode: true, storeStatusCode: true },
      }),
      openCheckInsOf(client, storeId, { employedOnly: true }),
      client.contract.groupBy({
        by: ['status'],
        where: { storeId, status: { in: PENDING_CONTRACT_STATUSES } },
        _count: { _all: true },
      }),
      client.staffMember.count({ where: retiringStaff(storeId) }),
      client.payslip.count({
        where: { storeId, status: { in: UNCONFIRMED_PAYSLIP_STATUSES } },
      }),
    ]);
  const shown = rows.filter(
    (r) =>
      !hidesPersonalData(HQ_ROLE, store, hqSharingConsentedOf(r.staffMember)),
  );
  const head = shown[0];
  const ending = (...statuses: ContractStatus[]) =>
    contracts
      .filter((c) => c.status !== null && statuses.includes(c.status))
      .reduce((sum, c) => sum + c._count._all, 0);
  return {
    openCheckIns: {
      count: shown.length,
      hiddenCount: rows.length - shown.length,
      first: head
        ? {
            attendanceRecordId: head.attendanceRecordId,
            staffMemberId: head.staffMember.staffMemberId,
            name: head.staffMember.name,
            recordedAt: head.recordedAt,
            isCheckOutExpired: checkOutExpired(head.recordedAt, now),
          }
        : null,
    },
    retiringStaff: retiring,
    draftContracts: ending('DRAFT'),
    pendingSendContracts: ending('PENDING_SEND'),
    pendingSignatureContracts: ending(
      'PENDING_SIGNATURE',
      'CORRECTION_REQUESTED',
    ),
    unconfirmedPayslips,
  };
}
