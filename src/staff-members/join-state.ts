import {
  InvitationStatus,
  InvitationType,
  Prisma,
  StaffMemberJoinStatus,
} from '@prisma/client';

/**
 * 직원 목록의 「가입·인증」 상태. DB 칸이 아니라 직원 레코드 · 초대 · 연결 보류에서 만든다(API 전용 enum).
 * 이 순서는 화면 선택지 순서다(우선순위와 다르다). 우선순위는 joinStateOf 가 정한다 — 가입 완료 > 연결 보류 >
 * 발송 중 초대(소속 추가 · 복귀 · 초대 발송) > 만 19세 미만 > 수락(초대 발송) > 거절 > 만료, 초대가 없으면 초안.
 * 표시(joinStateOf)와 필터(joinStateWhere)가 같은 규칙을 따르도록
 * 두 함수를 이 파일에 함께 둔다 — 한쪽만 고치면 필터한 결과에 다른 상태가 섞여 나온다.
 */
export const STAFF_JOIN_STATE_LABELS = {
  JOINED: '가입 완료',
  LINK_HOLD: '연결 보류',
  UNDER_AGE: '가입 불가(만 19세 미만)',
  AFFILIATION_PENDING: '소속 추가 확인',
  RETURN_PENDING: '복귀 확인',
  INVITED: '초대 발송',
  EXPIRED: '초대 만료',
  REJECTED: '거절',
  DRAFT: '초안',
} as const;

export type StaffJoinState = keyof typeof STAFF_JOIN_STATE_LABELS;

export const STAFF_JOIN_STATES = Object.keys(
  STAFF_JOIN_STATE_LABELS,
) as readonly StaffJoinState[];

export interface JoinStateInvitation {
  invitationId: number;
  invitationType: InvitationType;
  status: InvitationStatus;
  sentAt: Date;
  /** 미처리 보류(resolution 이 빈 것)만 담는다. */
  linkHolds: ReadonlyArray<unknown>;
}

const SENT_STATE: Record<InvitationType, StaffJoinState> = {
  SIGNUP: 'INVITED',
  REINVITE: 'INVITED',
  AFFILIATION_CONFIRM: 'AFFILIATION_PENDING',
  RETURN_CONFIRM: 'RETURN_PENDING',
};

/**
 * 목록에 보일 초대. 발송 중(SENT)인 초대가 있으면 그것 — 한 직원에 많아야 하나라고 본다(재발송 · 재초대는 이전
 * 초대를 끝내고 새로 만든다, WHALEERP-136). 없으면 가장 늦게 보낸 것, 같은 시각이면 id 가 큰 것.
 */
export function displayInvitation<T extends JoinStateInvitation>(
  invitations: readonly T[],
): T | null {
  const sent = invitations.find((i) => i.status === 'SENT');
  if (sent) return sent;
  let latest: T | null = null;
  for (const i of invitations) {
    if (
      !latest ||
      i.sentAt.getTime() > latest.sentAt.getTime() ||
      (i.sentAt.getTime() === latest.sentAt.getTime() &&
        i.invitationId > latest.invitationId)
    )
      latest = i;
  }
  return latest;
}

export function joinStateOf(
  joinStatus: StaffMemberJoinStatus,
  invitations: readonly JoinStateInvitation[],
): StaffJoinState {
  if (joinStatus === 'JOINED') return 'JOINED';
  if (invitations.some((i) => i.linkHolds.length > 0)) return 'LINK_HOLD';
  const shown = displayInvitation(invitations);
  if (!shown) return 'DRAFT';
  if (shown.status === 'SENT') return SENT_STATE[shown.invitationType];
  // 만 19세 미만으로 막혔어도 다시 보낸 초대가 발송 중이면 그 초대가 이긴다(2026-10-12 yjnoh).
  if (invitations.some((i) => i.status === 'REJECTED_UNDER_AGE'))
    return 'UNDER_AGE';
  // 발송 중인 초대가 없다. 「마지막 초대」는 필터(관계 조건)로 표현되지 않으므로 순서가 아니라 있고 없음으로
  // 가른다 — 수락 > 거절 > 만료. 수락했는데 가입 완료도 보류도 아닌 것은 재초대를 기다리는 중간 상태라 초대
  // 발송으로 둔다.
  if (invitations.some((i) => i.status === 'ACCEPTED')) return 'INVITED';
  if (invitations.some((i) => i.status === 'REJECTED')) return 'REJECTED';
  return 'EXPIRED';
}

const notJoined: Prisma.StaffMemberWhereInput = {
  joinStatus: { not: 'JOINED' },
};
const openHold: Prisma.StaffMemberWhereInput = {
  invitations: { some: { linkHolds: { some: { resolution: null } } } },
};
const underAge: Prisma.StaffMemberWhereInput = {
  invitations: { some: { status: 'REJECTED_UNDER_AGE' } },
};
const anySent: Prisma.StaffMemberWhereInput = {
  invitations: { some: { status: 'SENT' } },
};
const sentOf = (types: InvitationType[]): Prisma.StaffMemberWhereInput => ({
  invitations: { some: { status: 'SENT', invitationType: { in: types } } },
});
const someStatus = (
  status: InvitationStatus,
): Prisma.StaffMemberWhereInput => ({
  invitations: { some: { status } },
});

/**
 * 상태 필터. joinStateOf 의 우선순위를 NOT 으로 옮긴다 — 한 직원은 표시한 상태의 필터 하나에만 걸린다(e2e 가
 * 직원마다 확인한다). 발송 중인 초대가 없을 때의 수락 > 거절 > 만료도 같은 순서다.
 */
export function joinStateWhere(
  state: StaffJoinState,
): Prisma.StaffMemberWhereInput {
  switch (state) {
    case 'JOINED':
      return { joinStatus: 'JOINED' };
    case 'LINK_HOLD':
      return { AND: [notJoined, openHold] };
    case 'UNDER_AGE':
      return { AND: [notJoined, underAge], NOT: [openHold, anySent] };
    case 'AFFILIATION_PENDING':
      return {
        AND: [notJoined, sentOf(['AFFILIATION_CONFIRM'])],
        NOT: [openHold],
      };
    case 'RETURN_PENDING':
      return {
        AND: [notJoined, sentOf(['RETURN_CONFIRM'])],
        NOT: [openHold],
      };
    case 'INVITED':
      return {
        AND: [
          notJoined,
          {
            OR: [
              sentOf(['SIGNUP', 'REINVITE']),
              { AND: [someStatus('ACCEPTED')], NOT: [anySent, underAge] },
            ],
          },
        ],
        NOT: [openHold],
      };
    case 'EXPIRED':
      return {
        AND: [notJoined, someStatus('EXPIRED')],
        NOT: [
          openHold,
          underAge,
          anySent,
          someStatus('ACCEPTED'),
          someStatus('REJECTED'),
        ],
      };
    case 'REJECTED':
      return {
        AND: [notJoined, someStatus('REJECTED')],
        NOT: [openHold, underAge, anySent, someStatus('ACCEPTED')],
      };
    case 'DRAFT':
      return { AND: [notJoined, { invitations: { none: {} } }] };
  }
}
