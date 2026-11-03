import type { PayslipStatus, Prisma } from '@prisma/client';
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
  /** 폐점하면 종료될 계약 수 — 퇴직될 직원의 임시저장 · 발송 대기 · 서명 대기 · 수정 요청 */
  endingContractCount: number;
  /** 폐점하면 퇴직될 재직 직원 수 */
  retiringStaffCount: number;
  /** 확정하지 않은(작성 중 · 검토 중) 급여명세서 수 */
  unconfirmedPayslipCount: number;
}

/**
 * 폐점하면 퇴직될 직원 — 점포 단위 일괄 퇴직(`retireAllForStoreClosing`, WHALEERP-646 · 648)이 고르는 대상과 같다. 재직 레코드에서
 * 임시저장 계약만 있는 가입 전 레코드(`isDraftOnlyPreJoin`)는 건너뛴다 — 그 임시저장 계약도 그대로 남는다.
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
 * 업무 범위 · 권한은 부르는 쪽이 이미 봤다고 보고, 폐점을 막을지도 부르는 쪽이 정한다. 저장 직전에는 점포 상태를 바꾸기 전,
 * 일괄 퇴직(`retireAllForStoreClosing`)보다 먼저 부른다 — 뒤에 부르면 종료될 계약 · 퇴직될 직원이 0이 되고, 폐점한 가맹 점포는
 * 동의한 직원까지 가려 `first` 가 비어 보일 수 있다(`count + hiddenCount` 는 그대로).
 *
 * - 열린 출근: 관리자 열린 출근 조회(WHALEERP-644)와 같은 기준(`openCheckInsOf` — 보정할 수 있는 3개월 안, 퇴직한 직원 레코드
 *   포함). 본사 역할에게 가려지는 가맹 직원은 첫 건 이름으로 내보내지 않고 수만 센다(부르는 관리자를 받지 않아 늘 본사 역할 기준) — 개별 퇴직은 열린 출근이 있으면 막히지만 일괄 퇴직은 검사하지 않아 여기가 열린 출근을 잡는 자리다.
 *   수까지 빼면 0건으로 보고 폐점한다(2026-11-03 재영).
 * - 종료될 계약 · 퇴직될 직원: 일괄 퇴직(646 · 648)이 퇴직 확정으로 닫는 것과 같은 범위. `closedDate` 는 일괄 퇴직과 같은 입력으로
 *   받지만 지금 규칙에서는 수를 바꾸지 않는다 — 일괄 퇴직은 재직 레코드 전부를 고르고, 체결 완료 계약은 퇴직으로 종료되지
 *   않는다(계약은 줄이지 않는다).
 * - 급여명세서: 점포의 작성 중 · 검토 중 명세서. 퇴직해도 지워지지 않는다.
 *
 * 잠그지 않고 읽는다 — 확인한 뒤 저장이 커밋되기 전에 직원 앱 출근이 들어오면(출근은 계정 행만, 일괄 퇴직은 직원 행만
 * 잠근다) 폐점한 점포에 퇴직자의 열린 출근이 남을 수 있다. 매우 짧은 틈이라 받아들인 위험이고, 남으면 관리자가 보정으로 닫는다.
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
  const [
    store,
    rows,
    endingContractCount,
    retiringStaffCount,
    unconfirmedPayslipCount,
  ] = await Promise.all([
    client.store.findUniqueOrThrow({
      where: { storeId },
      select: { storeTypeCode: true, storeStatusCode: true },
    }),
    openCheckInsOf(client, storeId),
    client.contract.count({
      where: {
        status: { in: PENDING_CONTRACT_STATUSES },
        staffMember: retiringStaff(storeId),
      },
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
    endingContractCount,
    retiringStaffCount,
    unconfirmedPayslipCount,
  };
}
