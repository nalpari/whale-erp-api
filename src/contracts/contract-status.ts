import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ContractStatus,
  EmploymentStatus,
  EmploymentType,
  Prisma,
  StatusChangeActor,
} from '@prisma/client';
import { kstToday } from '../staff-members/kst-date';
import { SIGNED_ONCE } from './signed-contract';

/**
 * 근로계약 상태 전환 (WHALEERP-151). 상태가 바뀌는 길을 한 표로 두고, 바꿀 때마다 같은 트랜잭션에서 상태 이력
 * (변경 전 · 후 · 처리 주체 · 일시)을 남긴다. 표에 없는 전환이거나 그사이 다른 요청이 상태를 바꿨으면 아무것도
 * 쓰지 않고 지금 상태를 담아 409 를 준다 — 트랜잭션째 되돌아가 직전 상태가 그대로 남는다.
 *
 * 처음 상태(임시저장 · 발송 대기 · 서명 대기, 종이 계약이면 체결 완료)는 계약을 만들 때 정해지고 전환이 아니다. 임시저장은
 * 지울 수 있지만(행 삭제) 그것도 전환이 아니다. 퇴직 처리(staff-members/retirement.service)는 아직 이 표를 쓰지
 * 않고 같은 규칙(진행 중 계약 → 종료 + 이력)을 직접 쓴다.
 */
export const TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  // 초안 저장하면 곧바로 보낸다 — 가입 초대 · 소속 추가 확인 요청(계정만 있는 번호, WHALEERP-130)이면 발송 대기, 가입한 직원이면
  // 서명 대기(2026-10-19 재영).
  // 종이 계약으로 등록하거나(날인본을 올리면 발송 · 날인 없이 체결 완료, CTR-23), 대체 · 퇴직으로 닫는다
  DRAFT: ['PENDING_SEND', 'PENDING_SIGNATURE', 'SIGNED', 'ENDED'],
  // 가입 초대 · 소속 추가 확인 요청이 나가 가입 · 수락을 기다린다. 가입 · 수락하면 서명 대기(직원 앱, WHALEERP-141 · 130).
  // 대체 · 퇴직, 또는 채용을 접어 관리자가 종료로 닫는다(WHALEERP-327). 30일 안에 가입 · 수락하지 않아도 만료하지 않는다 —
  // 초대 · 요청만 만료되고 계약은 재발송할 수 있게 둔다(api #150 리뷰)
  // 소속 추가 확인 요청을 직원이 거절하면 함께 온 계약은 거부로 닫는다(WHALEERP-130, 2026-10-26 재영 — 거절 사유를 계약에도 남김)
  PENDING_SEND: ['PENDING_SIGNATURE', 'REJECTED', 'ENDED'],
  // 직원이 날인 · 거부하거나, 가입 값과 계약서 값이 달라 수정을 요청하거나(본인 대조, WHALEERP-125), 기한이 지나
  // 만료되거나, 대체 · 퇴직으로 닫는다. 관리자가 당사자 정보를 고치면 서명 대기 그대로 새 기한으로 다시 보낸다 — 번호를
  // 계정이 없는 번호로 고쳤으면 가입 초대를 보내 발송 대기로 간다
  PENDING_SIGNATURE: [
    'SIGNED',
    'REJECTED',
    'CORRECTION_REQUESTED',
    'PENDING_SEND',
    'EXPIRED',
    'ENDED',
  ],
  // 관리자가 계약서를 고쳐 저장하면 곧바로 서명 대기 · 새 기한으로 다시 보낸다(2026-10-19 재영 — 발송 대기를 거치지
  // 않는다). 번호를 계정이 없는 번호로 고쳤으면 가입 초대(발송 대기)다. 대체 · 퇴직으로 닫는다.
  // 기한이 흐르지 않아 만료되지 않는다 — 만료 배치는 서명 대기만 본다
  CORRECTION_REQUESTED: ['PENDING_SIGNATURE', 'PENDING_SEND', 'ENDED'],
  // 계약 기간이 끝나거나 재계약 · 퇴직으로 닫는다. 내용은 고치지 않는다 — 바꾸려면 새 계약으로 대체한다
  SIGNED: ['ENDED'],
  // 거부 · 만료 계약은 같은 조건으로 다시 보낼 수 있다(WHALEERP-153, 운영 정책 CTR-10 · 2026-10-26 재영) — 앱으로 받는
  // 직원이면 서명 대기, 가입 초대 · 소속 추가 확인 요청이면 발송 대기로 새 기한과 함께 돌아간다
  REJECTED: ['PENDING_SIGNATURE', 'PENDING_SEND'],
  EXPIRED: ['PENDING_SIGNATURE', 'PENDING_SEND'],
  ENDED: [],
};

/** 지금 상태라 바꿀 수 없을 때 알릴 문장. 다시 하는 방법(새로 고쳐 지금 상태 확인)을 함께 준다. */
const NOW_STATUS: Record<ContractStatus, string> = {
  DRAFT: '임시저장한 근로계약입니다',
  PENDING_SEND:
    '가입 초대 · 소속 추가 확인 요청을 보내고 직원의 가입 · 수락을 기다리는 근로계약입니다',
  PENDING_SIGNATURE: '서명을 기다리는 근로계약입니다',
  CORRECTION_REQUESTED: '직원이 수정을 요청한 근로계약입니다',
  SIGNED: '이미 체결 완료된 근로계약입니다',
  REJECTED: '이미 거부된 근로계약입니다',
  EXPIRED: '날인 기한이 지나 만료된 근로계약입니다',
  ENDED: '이미 종료된 근로계약입니다',
};

/**
 * 다시 보낼 수 있는 상태 — 발송 대기 · 서명 대기(WHALEERP-136)와 거부 · 만료(WHALEERP-153). 재발송(contract-send)과 상세의
 * canResend 가 함께 쓴다. 종료는 다시 보내지 못한다 — 새 계약으로.
 */
export const RESENDABLE_STATUSES: readonly ContractStatus[] = [
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'REJECTED',
  'EXPIRED',
];

/** 끝난 뒤 다시 보내는 상태 — 거부 · 만료(WHALEERP-153). 다시 살아나므로 같은 사람의 다른 진행 중 계약 · 퇴직을 먼저 본다 */
export const REOPENED_STATUSES: readonly ContractStatus[] = [
  'REJECTED',
  'EXPIRED',
];

export const canTransition = (from: ContractStatus, to: ContractStatus) =>
  TRANSITIONS[from].includes(to);

/** 409 CONTRACT_STATUS_CONFLICT — 지금 상태로는 그 전환을 할 수 없다. 본문에 지금 상태를 싣는다. */
export function statusConflict(now: ContractStatus): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'CONTRACT_STATUS_CONFLICT',
    message: `${NOW_STATUS[now]}. 화면을 새로 고쳐 지금 상태를 확인해 주세요.`,
    status: now,
  });
}

/**
 * 계약 하나의 상태를 바꾸고 이력을 남긴다. 돌려주는 값은 바뀌기 전 상태다.
 * - 계약 행을 먼저 잠그고(`FOR UPDATE`) 지금 상태를 읽는다 — 날인과 만료 배치처럼 같은 계약을 동시에 바꾸려는
 *   요청은 줄을 서고, 뒤에 온 쪽은 바뀐 상태를 읽어 409 가 된다.
 * - `from` 을 주면 그 상태들에서만 바꾼다(예: 날인은 서명 대기에서만). 주지 않으면 전환 표가 허락하는 모든 상태.
 * - `data` 는 상태와 함께 고칠 칸(거부 사유 · 발송 일시 등)이다.
 * - UPDATE 도 읽은 상태를 조건으로 건다. 0건이면(잠금 밖에서 바뀐 경우) 409.
 */
export async function transition(
  db: Prisma.TransactionClient,
  contractId: number,
  to: ContractStatus,
  actor: StatusChangeActor,
  options: {
    from?: readonly ContractStatus[];
    data?: Prisma.ContractUpdateManyMutationInput;
  } = {},
): Promise<ContractStatus> {
  await lockContract(db, contractId);
  const current = await db.contract.findUnique({
    where: { contractId },
    select: { status: true },
  });
  if (!current) throw new NotFoundException('근로계약을 찾을 수 없습니다.');
  // status 는 스키마상 NULL 을 허락하지만 기본값(발송 대기)이 있어 비는 일이 없다. 비었으면 바꾸지 않는다.
  const from = current.status;
  if (
    from === null ||
    !canTransition(from, to) ||
    (options.from && !options.from.includes(from))
  )
    throw statusConflict(from ?? to);

  const { count } = await db.contract.updateMany({
    where: { contractId, status: from },
    data: { ...options.data, status: to },
  });
  if (count === 0) {
    const now = await db.contract.findUnique({
      where: { contractId },
      select: { status: true },
    });
    throw statusConflict(now?.status ?? from);
  }
  await db.contractStatusHistory.create({
    data: { contractId, fromStatus: from, toStatus: to, actor },
  });
  return from;
}

/**
 * 조건에 맞는 여러 계약을 한 상태에서 다른 상태로 한 번에 바꾸고 이력을 남긴다(배치용). 상태를 조건으로 건
 * UPDATE 라 여러 번 돌려도 같은 계약을 두 번 바꾸지 않고, 그사이 다른 상태로 간 계약은 건드리지 않는다.
 * 바꾼 계약 번호를 돌려준다.
 */
export async function transitionMany(
  db: Prisma.TransactionClient,
  where: Prisma.ContractWhereInput,
  from: ContractStatus,
  to: ContractStatus,
  actor: StatusChangeActor,
): Promise<number[]> {
  const changed = await transitionManyWithHistory(db, where, from, to, actor);
  return changed.map((c) => c.contractId);
}

/**
 * transitionMany 와 같고, 바꾼 계약과 남긴 이력 번호를 함께 돌려준다 — 커밋 뒤 운영 알림의 사건 키(상태 이력 ID)로 쓴다
 * (만료 알림, WHALEERP-154).
 */
export async function transitionManyWithHistory(
  db: Prisma.TransactionClient,
  where: Prisma.ContractWhereInput,
  from: ContractStatus,
  to: ContractStatus,
  actor: StatusChangeActor,
): Promise<{ contractId: number; historyId: number }[]> {
  if (!canTransition(from, to)) throw statusConflict(from);
  const changed = await db.contract.updateManyAndReturn({
    where: { ...where, status: from },
    data: { status: to },
    select: { contractId: true },
  });
  if (changed.length === 0) return [];
  const histories = await db.contractStatusHistory.createManyAndReturn({
    data: changed.map(({ contractId }) => ({
      contractId,
      fromStatus: from,
      toStatus: to,
      actor,
    })),
    select: { contractId: true, contractStatusHistoryId: true },
  });
  return histories.map((h) => ({
    contractId: h.contractId,
    historyId: h.contractStatusHistoryId,
  }));
}

/**
 * 이어 쓰기 · 삭제 · 대체 · 전환이 같은 계약을 동시에 고치지 않게 계약 행을 잠근다. 하위 행(근무 요일 · 당사자 ·
 * 이력)보다 먼저 잡는다 — 순서가 엇갈리면 교착(40P01, 500)이 된다. 뒤에 온 요청은 앞 요청이 끝난 뒤 바뀐 상태를
 * 읽는다. 같은 트랜잭션에서 다시 잡아도 된다.
 */
export const lockContract = (
  db: Prisma.TransactionClient,
  contractId: number,
) =>
  db.$executeRaw`SELECT 1 FROM contracts WHERE contract_id = ${contractId} FOR UPDATE`;

/**
 * 직원 행 잠금 — 계약 행보다 먼저 잡는다. 퇴직 확정이 직원 행(FOR NO KEY UPDATE) → 대기 계약 순서라 같은 순서로 줄을 선다
 * (api #101 · #104). 직원 행을 쓰면 `write`(FOR NO KEY UPDATE — 키는 바꾸지 않으니 직원을 참조하는 행 넣기는 막지
 * 않는다), 읽고 확인만 하면 `read`(FOR SHARE). 둘은 서로 막는다.
 */
export const lockStaffMember = (
  db: Prisma.TransactionClient,
  staffMemberId: number,
  mode: 'read' | 'write',
) =>
  mode === 'write'
    ? db.$executeRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${staffMemberId} FOR NO KEY UPDATE`
    : db.$executeRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${staffMemberId} FOR SHARE`;

/**
 * 계약의 직원 행(write) → 계약 행 순서로 잠근다 — 계약을 고치며 직원 행도 쓰는 관리자 경로가 쓴다. 계약 행부터 잡으면
 * 직원 행부터 잡는 이어 쓰기 · 퇴직 확정 · 직원 앱 날인과 고리가 생긴다(api #104). 계약의 직원은 만들 때만 정해져
 * 잠그기 전에 읽어도 된다. 계약이 없으면 계약 행만 잠그고(잠글 것이 없다) 부르는 쪽이 다시 읽어 404 를 낸다.
 */
export async function lockContractWithStaff(
  db: Prisma.TransactionClient,
  contractId: number,
): Promise<void> {
  const c = await db.contract.findUnique({
    where: { contractId },
    select: { staffMemberId: true },
  });
  if (c) await lockStaffMember(db, c.staffMemberId, 'write');
  await lockContract(db, contractId);
}

/** 거부 사유 길이 상한. 직원 앱 입력칸과 맞춘다. */
export const REJECT_REASON_MAX = 500;

/**
 * 직원 날인 — 서명 대기에서만 체결 완료로 바꾼다. 이미 체결 완료면 처리하지 않고 지금 상태를 알린다(409).
 * 날인 기한이 지났으면 만료 배치가 아직 돌지 않았어도 받지 않는다 — 만료로 바꾸는 것은 배치의 일이다.
 * 서명 이미지 저장과 직원 앱 경로는 MyContractsService(WHALEERP-145), 처리 완료본은 WHALEERP-131.
 * 체결 완료라 직원 레코드의 빈 입사일을 채운다(fillHiredDate) — 부르는 쪽이 직원 행을 write 로 잠가 둔다.
 */
export async function signContract(
  db: Prisma.TransactionClient,
  contractId: number,
  now = new Date(),
): Promise<void> {
  const c = await checkSignDeadline(db, contractId, now);
  await transition(db, contractId, 'SIGNED', 'STAFF', {
    from: ['PENDING_SIGNATURE'],
  });
  await fillHiredDate(db, c.staffMemberId, c.startDate);
  await applyStartedTerms(db, contractId, now);
}

/**
 * 체결 완료된 계약의 고용 형태 · 직무를 직원 레코드(지금 값)로 옮긴다(WHALEERP-156, 2026-10-27 김민식) — 그 계약이 이미
 * 시작했을 때만(시작일이 한국 날짜로 오늘이거나 지남). 미리 날인한 재계약은 시작일에 하루 배치가 옮긴다 — 그 전까지는 지금
 * 효력인 계약의 값이 직원 목록 · 상세에 보인다. 재계약을 저장만 해서는(임시저장 · 발송) 직원 레코드를 바꾸지 않는다. 날인 ·
 * 종이 계약 등록에서 부르며, 직원 행을 쓰므로 부르는 쪽이 직원 행을 write 로 잠가 둔다.
 */
export async function applyStartedTerms(
  db: Prisma.TransactionClient,
  contractId: number,
  now = new Date(),
): Promise<void> {
  const c = await db.contract.findUnique({
    where: { contractId },
    select: {
      staffMemberId: true,
      startDate: true,
      employmentType: true,
      jobTitle: true,
    },
  });
  const today = kstToday(now);
  if (!c?.startDate || c.startDate > today) return;
  if (c.employmentType == null && c.jobTitle == null) return;
  // 지금 효력인 계약이 더 늦게 시작했으면 옮기지 않는다 — 옛 종이 계약을 뒤늦게 올려도 지금 조건을 덮지 않게(api #157 code-review).
  // 하루 배치(LATEST_STARTED_SIGNED)와 같은 기준이다 — 체결을 거친 계약(기간이 끝나 배치가 닫은 것도), 시작일이 같으면 id 가 큰 것
  const newer = await db.contract.findFirst({
    where: {
      staffMemberId: c.staffMemberId,
      contractId: { not: contractId },
      startDate: { lte: today },
      AND: [
        SIGNED_ONCE,
        {
          OR: [
            { startDate: { gt: c.startDate } },
            { startDate: c.startDate, contractId: { gt: contractId } },
          ],
        },
      ],
    },
    select: { contractId: true },
  });
  if (newer) return;
  await db.staffMember.update({
    where: { staffMemberId: c.staffMemberId },
    data: {
      ...(c.employmentType != null && { employmentType: c.employmentType }),
      ...(c.jobTitle != null && { jobTitle: c.jobTitle }),
    },
  });
}

/** 고용 형태 · 직무 한 벌 — 계약 행은 옛 행이면 비어 있을 수 있다 */
type Terms = { employmentType: EmploymentType | null; jobTitle: string | null };

/**
 * 직원 레코드 select 에 펼쳐, 아직 시작하지 않은 진행 중 계약(보내 놓고 날인 전 — 발송 대기 · 서명 대기)의 고용 형태 · 직무를 함께
 * 읽는다. pendingTermsOf 에 레코드와 그 계약 행(contracts[0])을 넘긴다. 가입 전 레코드에는 진행 중 계약이 하나다(같은 점포 진행
 * 중 계약은 대체한다) — 가장 늦게 만든 것을 고른다.
 */
export const PENDING_TERMS_SELECT = {
  employmentType: true,
  jobTitle: true,
  contracts: {
    where: { status: { in: ['PENDING_SEND', 'PENDING_SIGNATURE'] } },
    orderBy: { contractId: 'desc' },
    take: 1,
    select: { employmentType: true, jobTitle: true },
  },
} as const satisfies Prisma.StaffMemberSelect;

/**
 * 직원에게 알릴 고용 형태 · 직무 — 아직 시작 전 계약 조건은 계약에서, 없으면 레코드에서(WHALEERP-156 · 130). 직원 레코드는 계약이
 * 시작할 때 옮겨(applyStartedTerms) 재계약 · 복귀 확인이면 옛 조건이다. 칸마다 섞지 않는다 — 조건을 적은 계약 행(고용 형태가
 * 있음)이면 둘 다 그 계약, 아니면(계약이 없거나 조건이 비어 있는 옛 행) 둘 다 레코드다.
 */
export function pendingTermsOf(
  record: { employmentType: EmploymentType; jobTitle: string },
  contract: Terms | null | undefined,
): { employmentType: EmploymentType; jobTitle: string | null } {
  return contract?.employmentType
    ? { employmentType: contract.employmentType, jobTitle: contract.jobTitle }
    : { employmentType: record.employmentType, jobTitle: record.jobTitle };
}

/**
 * 바로잡기가 직원 레코드의 체결 완료를 닫은 뒤 그 레코드를 다시 맞춘다(api #157 재리뷰 4 · code-review). 직원 행은 부르는
 * 쪽이 write 로 잠가 둔다.
 * - 고용 형태 · 직무는 지금 효력인 계약 — 가장 늦게 시작한(오늘까지) 체결을 거친 계약, 시작일이 같으면 id 가 큰 것(하루 배치
 *   LATEST_STARTED_SIGNED · applyStartedTerms 와 같은 기준, 배치는 원시 SQL 이라 따로 적는다) — 의 값이다. 그런 계약이 남지
 *   않았으면 다시 올리는 계약의 값(fallback)이다 — 체결 계약이 없는 레코드가 저장한 계약 값을 보이는 것(recordTermsFree)과 같다.
 *   다시 올린 계약이 붙지 않는 레코드(fallback 없음)는 남은 효력 계약이 있을 때만 맞춘다.
 * 입사일은 다시 올린 계약을 넣은 뒤 refixHiredDate 가 맞춘다.
 */
export async function resyncAfterCorrection(
  db: Prisma.TransactionClient,
  staffMemberId: number,
  fallback: { employmentType: EmploymentType; jobTitle: string } | undefined,
  now = new Date(),
): Promise<void> {
  const c = await db.contract.findFirst({
    where: { staffMemberId, startDate: { lte: kstToday(now) }, ...SIGNED_ONCE },
    orderBy: [{ startDate: 'desc' }, { contractId: 'desc' }],
    select: { employmentType: true, jobTitle: true },
  });
  // 칸마다 효력 계약 값, 그 칸이 빈 옛 계약이면 다시 올린 계약 값이다 — 닫힌 계약이 쓴 값이 남지 않게(셀프 code-review). 둘 다
  // 없으면 그 칸은 그대로 둔다(배치 LATEST_STARTED_SIGNED 의 COALESCE 와 같다)
  const employmentType = c?.employmentType ?? fallback?.employmentType;
  const jobTitle = c?.jobTitle ?? fallback?.jobTitle;
  if (employmentType != null || jobTitle != null)
    await db.staffMember.update({
      where: { staffMemberId },
      data: {
        ...(employmentType != null && { employmentType }),
        ...(jobTitle != null && { jobTitle }),
      },
    });
}

/**
 * 바로잡기 뒤 입사일(api #157 재리뷰 7) — 입사일이 바로잡기로 닫힌 계약(closed)의 시작일이면, 그 레코드에 남은 체결을 거친 계약
 * (SIGNED_ONCE — 앞선 바로잡기로 닫힌 계약은 빠진다)과 다시 올린 계약 가운데 **가장 이른 시작일**로 바꾼다. 다시 올린 계약을
 * 넣은 뒤(체결 완료) 부른다 — 먼저 부르면 그 시작일이 후보에 들지 않는다. 이력 순이 아니라 시작일 순이다 — 잘못 올린 첫 계약을
 * 더 이른 날로 바로잡으면 그 날이 입사일이다. 퇴직일보다 늦게 시작한 계약은 치지 않는다(fillHiredDate 와 같다). 바꿀 출처가
 * 없으면 다시 올린 계약이 붙는 레코드(target)는 입사일을 비운다 — 바로잡아 버린 계약의 날을 남기지 않는다(새 계약이 퇴직일 뒤에
 * 시작하면 fillHiredDate 도 채우지 않는 것과 같다). 재직 중인 다른 레코드(이름까지 고쳐 새 레코드에 다시 올린 옛 레코드)도
 * 비운다 — 버린 계약의 날이 목록 · 상세에 남는다(api #157 재리뷰 8 참고). 퇴직한 옛 레코드는 그대로 둔다 — 비우면 그 재직 기간 ·
 * 급여의 기준이 사라진다(셀프 code-review). 직원 행은 부르는 쪽이 write 로 잠가 둔다.
 */
export async function refixHiredDate(
  db: Prisma.TransactionClient,
  staffMemberId: number,
  closed: number[],
  target: boolean,
): Promise<void> {
  const s = await db.staffMember.findUnique({
    where: { staffMemberId },
    select: { hiredDate: true, retiredDate: true },
  });
  if (!s?.hiredDate) return;
  const fromClosed = await db.contract.findFirst({
    where: { contractId: { in: closed }, startDate: s.hiredDate },
    select: { contractId: true },
  });
  if (!fromClosed) return;
  const first = await db.contract.findFirst({
    where: {
      staffMemberId,
      startDate: s.retiredDate ? { lte: s.retiredDate } : { not: null },
      ...SIGNED_ONCE,
    },
    orderBy: [{ startDate: 'asc' }, { contractId: 'asc' }],
    select: { startDate: true },
  });
  if (!first?.startDate && !target && s.retiredDate) return;
  await db.staffMember.update({
    where: { staffMemberId },
    data: { hiredDate: first?.startDate ?? null },
  });
}

/**
 * 입사일(WHALEERP-613) — 체결 완료된 계약의 시작일을 직원 레코드의 입사일로 넣는다. 비어 있을 때만 넣는다: 직원
 * 레코드는 점포마다 하나라 그 점포에서 처음 체결 완료된 계약이 입사일을 정하고, 갱신 계약은 바꾸지 않는다(2026-10-21
 * 재영). 퇴직 뒤 재입사는 새 레코드라(api #65) 새 계약의 시작일이 된다. 퇴직일이 시작일보다 앞선 레코드(퇴직을 예약한
 * 뒤 그보다 늦게 시작하는 계약이 체결 완료)는 채우지 않는다 — 입사 전에 끝나는 근무이고, 채우면 퇴직일 < 입사일이 되어
 * 퇴직일을 고칠 수 없다(api #124 code-review). 체결 완료(날인 · 종이 계약 등록)에서 부르며, 직원 행을 쓰므로 부르는 쪽이
 * 직원 행을 write 로 잠가 둔다. 시작일은 임시저장만 비울 수 있어 체결 완료에서는 늘 있다.
 */
export async function fillHiredDate(
  db: Prisma.TransactionClient,
  staffMemberId: number,
  startDate: Date | null,
): Promise<void> {
  if (!startDate) return;
  await db.staffMember.updateMany({
    where: {
      staffMemberId,
      hiredDate: null,
      // 퇴직일이 시작일보다 앞선 레코드는 채우지 않는다 — 입사 전에 끝나는 근무다
      OR: [{ retiredDate: null }, { retiredDate: { gte: startDate } }],
    },
    data: { hiredDate: startDate },
  });
}

/**
 * 비어 있는 입사일을 다시 채운다(api #124 리뷰) — 퇴직일이 시작일보다 앞서 fillHiredDate 가 건너뛴 레코드도 퇴직을
 * 취소하거나 퇴직일을 미루면 입사일을 가질 수 있다. 그 레코드에서 처음 체결 완료된 계약 가운데 새 퇴직일보다 늦게
 * 시작하지 않는 것의 시작일이다(백필 20261022142048 과 같은 규칙). 퇴직 취소 · 퇴직일 변경이 퇴직일을 바꾼 뒤, 직원
 * 행을 잠근 채 부른다. retiredDate 는 바꾼 뒤의 퇴직일(취소면 null)이다.
 */
export async function refillHiredDate(
  db: Prisma.TransactionClient,
  staffMemberId: number,
  retiredDate: Date | null,
): Promise<void> {
  const first = await db.contractStatusHistory.findFirst({
    where: {
      toStatus: 'SIGNED',
      contract: {
        staffMemberId,
        startDate: retiredDate ? { lte: retiredDate } : { not: null },
        // 바로잡기로 닫은(관리자 종료) 계약은 치지 않는다 — 버린 계약의 시작일이 입사일로 되살아나지 않게(api #157 셀프 code-review)
        ...SIGNED_ONCE,
      },
    },
    orderBy: [{ changedAt: 'asc' }, { contractStatusHistoryId: 'asc' }],
    select: { contract: { select: { startDate: true } } },
  });
  await fillHiredDate(db, staffMemberId, first?.contract.startDate ?? null);
}

/**
 * 서명 대기인데 날인 기한이 지났으면 409 SIGN_DEADLINE_PASSED — 만료 배치가 아직 돌지 않았어도 직원의 처리(날인 · 수정
 * 요청)를 받지 않는다. 만료로 바꾸는 것은 배치의 일이다. 계약 행을 잠그고 읽는다. 날인이 입사일을 채우도록 계약의 직원 ·
 * 시작일도 함께 돌려준다(직원은 만들 때만 정해지고 체결 전 계약은 이 잠금 안에서 바뀌지 않는다).
 */
async function checkSignDeadline(
  db: Prisma.TransactionClient,
  contractId: number,
  now: Date,
): Promise<{ staffMemberId: number; startDate: Date | null }> {
  await lockContract(db, contractId);
  const c = await db.contract.findUnique({
    where: { contractId },
    select: {
      status: true,
      signDeadlineAt: true,
      staffMemberId: true,
      startDate: true,
    },
  });
  if (!c) throw new NotFoundException('근로계약을 찾을 수 없습니다.');
  if (signDeadlinePassed(c, now)) throw signDeadlineConflict();
  return c;
}

/** 서명 대기인데 날인 기한이 지났는가 — 만료 배치가 아직 돌지 않았어도 직원의 처리를 받지 않는다 */
export const signDeadlinePassed = (
  c: { status: ContractStatus | null; signDeadlineAt: Date | null },
  now: Date,
) =>
  c.status === 'PENDING_SIGNATURE' &&
  c.signDeadlineAt !== null &&
  c.signDeadlineAt <= now;

/** 409 SIGN_DEADLINE_PASSED — 직원 앱이 재발송 요청 안내를 그린다 */
export const signDeadlineConflict = () =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'SIGN_DEADLINE_PASSED',
    message: '날인 기한이 지났습니다. 관리자에게 재발송을 요청해 주세요.',
    status: 'PENDING_SIGNATURE',
  });

/**
 * 직원 수정 요청 — 가입 때 넣은 값과 계약서 값이 달라 날인할 수 없을 때, 서명 대기에서만 수정 요청으로 바꾼다.
 * 따로 받는 내용은 없다(2026-10-16). 서명 기한은 멈춘다 — 만료 배치는 서명 대기만 본다. HTTP 경로와 본인 대조는
 * [API] 날인 · 거부 처리(WHALEERP-145)에서 붙인다.
 */
export async function requestCorrection(
  db: Prisma.TransactionClient,
  contractId: number,
  now = new Date(),
): Promise<void> {
  // 기한이 지난 서명 대기를 수정 요청으로 살려 내지 않는다(만료 배치 전이어도) — 날인과 같다(api #58 리뷰)
  await checkSignDeadline(db, contractId, now);
  await transition(db, contractId, 'CORRECTION_REQUESTED', 'STAFF', {
    from: ['PENDING_SIGNATURE'],
  });
}

/**
 * 직원 거부 — 서명 대기에서만 거부로 바꾼다. 거부 사유는 선택이다(WHALEERP-145) — 앞뒤 공백을 지우고, 비면 남기지 않는다.
 * 날인 · 수정 요청과 같이 날인 기한이 지났으면 받지 않는다(409 SIGN_DEADLINE_PASSED).
 */
export async function rejectContract(
  db: Prisma.TransactionClient,
  contractId: number,
  reason?: string | null,
  now = new Date(),
): Promise<void> {
  const rejectReason = reason?.trim() || null;
  if (rejectReason && rejectReason.length > REJECT_REASON_MAX)
    throw new BadRequestException(
      `거부 사유는 ${REJECT_REASON_MAX}자 이하로 입력해 주세요.`,
    );
  await checkSignDeadline(db, contractId, now);
  await transition(db, contractId, 'REJECTED', 'STAFF', {
    from: ['PENDING_SIGNATURE'],
    data: { rejectReason },
  });
}

/** 재직 중인가 — 퇴직했거나 퇴직일이 지났으면(퇴직 확정 배치 전 — 퇴직일 다음 날부터) 아니다 */
export function employedOn(
  staff: { employmentStatus: EmploymentStatus; retiredDate: Date | null },
  now: Date,
): boolean {
  return (
    staff.employmentStatus === 'EMPLOYED' &&
    (staff.retiredDate === null || staff.retiredDate >= kstToday(now))
  );
}
