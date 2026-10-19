import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma, StatusChangeActor } from '@prisma/client';

/**
 * 근로계약 상태 전환 (WHALEERP-151). 상태가 바뀌는 길을 한 표로 두고, 바꿀 때마다 같은 트랜잭션에서 상태 이력
 * (변경 전 · 후 · 처리 주체 · 일시)을 남긴다. 표에 없는 전환이거나 그사이 다른 요청이 상태를 바꿨으면 아무것도
 * 쓰지 않고 지금 상태를 담아 409 를 준다 — 트랜잭션째 되돌아가 직전 상태가 그대로 남는다.
 *
 * 처음 상태(임시저장 · 발송 대기, 종이 계약이면 체결 완료)는 계약을 만들 때 정해지고 전환이 아니다. 임시저장은
 * 지울 수 있지만(행 삭제) 그것도 전환이 아니다. 퇴직 처리(staff-members/retirement.service)는 아직 이 표를 쓰지
 * 않고 같은 규칙(진행 중 계약 → 종료 + 이력)을 직접 쓴다.
 */
export const TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  // 초안 저장으로 넘기거나, 종이 계약으로 등록하거나(날인본을 올리면 발송 · 날인 없이 체결 완료, CTR-23), 대체 · 퇴직으로 닫는다
  DRAFT: ['PENDING_SEND', 'SIGNED', 'ENDED'],
  // 발송하면 서명 대기. 대체 · 퇴직으로 닫는다
  PENDING_SEND: ['PENDING_SIGNATURE', 'ENDED'],
  // 직원이 날인 · 거부하거나, 가입 값과 계약서 값이 달라 수정을 요청하거나(본인 대조, WHALEERP-125), 기한이 지나
  // 만료되거나, 대체 · 퇴직으로 닫는다. 관리자가 근로자 정보를 고치면 발송 대기로 돌아가 다시 보낸다(새 기한)
  PENDING_SIGNATURE: [
    'SIGNED',
    'REJECTED',
    'CORRECTION_REQUESTED',
    'PENDING_SEND',
    'EXPIRED',
    'ENDED',
  ],
  // 관리자가 계약서 · 근로자 정보를 고치면 발송 대기로 돌아가 다시 보낸다(2026-10-16). 대체 · 퇴직으로 닫는다.
  // 기한이 흐르지 않아 만료되지 않는다 — 만료 배치는 서명 대기만 본다
  CORRECTION_REQUESTED: ['PENDING_SEND', 'ENDED'],
  // 계약 기간이 끝나거나 재계약 · 퇴직으로 닫는다. 내용은 고치지 않는다 — 바꾸려면 새 계약으로 대체한다
  SIGNED: ['ENDED'],
  // 거부 · 만료 계약의 재발송(WHALEERP-153)은 아직 정하지 않았다 — 정해지면 여기에 더한다
  REJECTED: [],
  EXPIRED: [],
  ENDED: [],
};

/** 지금 상태라 바꿀 수 없을 때 알릴 문장. 다시 하는 방법(새로 고쳐 지금 상태 확인)을 함께 준다. */
const NOW_STATUS: Record<ContractStatus, string> = {
  DRAFT: '임시저장한 근로계약입니다',
  PENDING_SEND: '아직 발송하지 않은 근로계약입니다',
  PENDING_SIGNATURE: '서명을 기다리는 근로계약입니다',
  CORRECTION_REQUESTED: '직원이 수정을 요청한 근로계약입니다',
  SIGNED: '이미 체결 완료된 근로계약입니다',
  REJECTED: '이미 거부된 근로계약입니다',
  EXPIRED: '날인 기한이 지나 만료된 근로계약입니다',
  ENDED: '이미 종료된 근로계약입니다',
};

export const canTransition = (from: ContractStatus, to: ContractStatus) =>
  TRANSITIONS[from].includes(to);

/** 409 CONTRACT_STATUS_CONFLICT — 지금 상태로는 그 전환을 할 수 없다. 본문에 지금 상태를 싣는다. */
export function statusConflict(now: ContractStatus): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'CONTRACT_STATUS_CONFLICT',
    message: `${NOW_STATUS[now]}. 화면을 새로 고쳐 지금 상태를 확인해 주세요`,
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
  if (!current) throw new NotFoundException('근로계약을 찾을 수 없습니다');
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
  if (!canTransition(from, to)) throw statusConflict(from);
  const changed = await db.contract.updateManyAndReturn({
    where: { ...where, status: from },
    data: { status: to },
    select: { contractId: true },
  });
  if (changed.length === 0) return [];
  await db.contractStatusHistory.createMany({
    data: changed.map(({ contractId }) => ({
      contractId,
      fromStatus: from,
      toStatus: to,
      actor,
    })),
  });
  return changed.map((c) => c.contractId);
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

/** 거부 사유 길이 상한. 직원 앱 입력칸과 맞춘다. */
export const REJECT_REASON_MAX = 500;

/**
 * 직원 날인 — 서명 대기에서만 체결 완료로 바꾼다. 이미 체결 완료면 처리하지 않고 지금 상태를 알린다(409).
 * 날인 기한이 지났으면 만료 배치가 아직 돌지 않았어도 받지 않는다 — 만료로 바꾸는 것은 배치의 일이다.
 * 서명 이미지 · 처리 완료본 저장과 HTTP 경로는 [API] 날인 · 거부 처리(WHALEERP-145)에서 붙인다.
 */
export async function signContract(
  db: Prisma.TransactionClient,
  contractId: number,
  now = new Date(),
): Promise<void> {
  await checkSignDeadline(db, contractId, now);
  await transition(db, contractId, 'SIGNED', 'STAFF', {
    from: ['PENDING_SIGNATURE'],
  });
}

/**
 * 서명 대기인데 날인 기한이 지났으면 409 SIGN_DEADLINE_PASSED — 만료 배치가 아직 돌지 않았어도 직원의 처리(날인 · 수정
 * 요청)를 받지 않는다. 만료로 바꾸는 것은 배치의 일이다. 계약 행을 잠그고 읽는다.
 */
async function checkSignDeadline(
  db: Prisma.TransactionClient,
  contractId: number,
  now: Date,
): Promise<void> {
  await lockContract(db, contractId);
  const c = await db.contract.findUnique({
    where: { contractId },
    select: { status: true, signDeadlineAt: true },
  });
  if (!c) throw new NotFoundException('근로계약을 찾을 수 없습니다');
  if (
    c.status === 'PENDING_SIGNATURE' &&
    c.signDeadlineAt &&
    c.signDeadlineAt <= now
  )
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      code: 'SIGN_DEADLINE_PASSED',
      message: '날인 기한이 지났습니다. 관리자에게 재발송을 요청해 주세요',
      status: c.status,
    });
}

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

/** 직원 거부 — 서명 대기에서만 거부로 바꾸고 거부 사유를 함께 저장한다. 사유는 앞뒤 공백을 지우고 비우면 400. */
export async function rejectContract(
  db: Prisma.TransactionClient,
  contractId: number,
  reason: string,
): Promise<void> {
  const rejectReason = reason.trim();
  if (!rejectReason) throw new BadRequestException('거부 사유를 입력해 주세요');
  if (rejectReason.length > REJECT_REASON_MAX)
    throw new BadRequestException(
      `거부 사유는 ${REJECT_REASON_MAX}자 이하로 입력해 주세요`,
    );
  await transition(db, contractId, 'REJECTED', 'STAFF', {
    from: ['PENDING_SIGNATURE'],
    data: { rejectReason },
  });
}
