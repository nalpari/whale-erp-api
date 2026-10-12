import {
  displayInvitation,
  joinStateOf,
  joinStateWhere,
  JoinStateInvitation,
  STAFF_JOIN_STATES,
} from './join-state';

const inv = (
  over: Partial<JoinStateInvitation> & { invitationId: number },
): JoinStateInvitation => ({
  invitationType: 'SIGNUP',
  status: 'SENT',
  sentAt: new Date('2026-10-01T00:00:00Z'),
  linkHolds: [],
  ...over,
});

describe('joinStateOf', () => {
  it('가입 완료면 지난 보류가 남아 있어도 JOINED', () => {
    expect(
      joinStateOf('JOINED', [inv({ invitationId: 1, linkHolds: [{}] })]),
    ).toBe('JOINED');
  });

  it('미처리 보류가 있으면 LINK_HOLD', () => {
    expect(
      joinStateOf('INVITED', [
        inv({ invitationId: 1, status: 'ACCEPTED', linkHolds: [{}] }),
      ]),
    ).toBe('LINK_HOLD');
  });

  it('만 19세 미만으로 막혔으면 UNDER_AGE', () => {
    expect(
      joinStateOf('INVITED', [
        inv({ invitationId: 1, status: 'REJECTED_UNDER_AGE' }),
      ]),
    ).toBe('UNDER_AGE');
  });

  it.each([
    ['AFFILIATION_CONFIRM', 'AFFILIATION_PENDING'],
    ['RETURN_CONFIRM', 'RETURN_PENDING'],
    ['SIGNUP', 'INVITED'],
    ['REINVITE', 'INVITED'],
  ] as const)('%s 초대가 발송 중이면 %s', (invitationType, expected) => {
    expect(
      joinStateOf('INVITED', [inv({ invitationId: 1, invitationType })]),
    ).toBe(expected);
  });

  it('만료된 초대 뒤에 새 초대가 나가면 INVITED', () => {
    expect(
      joinStateOf('INVITED', [
        inv({ invitationId: 1, status: 'EXPIRED' }),
        inv({
          invitationId: 2,
          invitationType: 'REINVITE',
          sentAt: new Date('2026-10-05T00:00:00Z'),
        }),
      ]),
    ).toBe('INVITED');
  });

  it('살아 있는 초대가 없으면 마지막 초대의 상태 — 만료 뒤 거절이면 REJECTED', () => {
    expect(
      joinStateOf('INVITED', [
        inv({ invitationId: 1, status: 'EXPIRED' }),
        inv({
          invitationId: 2,
          invitationType: 'AFFILIATION_CONFIRM',
          status: 'REJECTED',
          sentAt: new Date('2026-10-05T00:00:00Z'),
        }),
      ]),
    ).toBe('REJECTED');
  });

  it('거절과 만료가 함께 있으면 순서와 상관없이 REJECTED — 필터가 「마지막」을 표현하지 못한다', () => {
    expect(
      joinStateOf('INVITED', [
        inv({
          invitationId: 1,
          invitationType: 'AFFILIATION_CONFIRM',
          status: 'REJECTED',
        }),
        inv({
          invitationId: 2,
          status: 'EXPIRED',
          sentAt: new Date('2026-10-05T00:00:00Z'),
        }),
      ]),
    ).toBe('REJECTED');
  });

  it('수락한 초대가 있으면 만료 · 거절보다 앞서 INVITED', () => {
    expect(
      joinStateOf('INVITED', [
        inv({
          invitationId: 1,
          status: 'ACCEPTED',
          sentAt: new Date('2026-09-01T00:00:00Z'),
        }),
        inv({ invitationId: 2, status: 'EXPIRED' }),
      ]),
    ).toBe('INVITED');
  });

  it('마지막 초대가 만료면 EXPIRED', () => {
    expect(
      joinStateOf('INVITED', [inv({ invitationId: 1, status: 'EXPIRED' })]),
    ).toBe('EXPIRED');
  });

  it('초대가 한 번도 없으면 DRAFT', () => {
    expect(joinStateOf('DRAFT', [])).toBe('DRAFT');
  });

  it('수락됐는데 가입 완료가 아니면 INVITED — 중간 상태도 정해진 값이다', () => {
    expect(
      joinStateOf('INVITED', [inv({ invitationId: 1, status: 'ACCEPTED' })]),
    ).toBe('INVITED');
  });
});

describe('displayInvitation', () => {
  it('발송 중인 초대가 있으면 그것', () => {
    const sent = inv({ invitationId: 1 });
    const later = inv({
      invitationId: 2,
      status: 'EXPIRED',
      sentAt: new Date('2026-10-09T00:00:00Z'),
    });
    expect(displayInvitation([sent, later])).toBe(sent);
  });

  it('없으면 가장 늦게 보낸 것, 같은 시각이면 id 가 큰 것', () => {
    const a = inv({ invitationId: 1, status: 'EXPIRED' });
    const b = inv({ invitationId: 2, status: 'EXPIRED' });
    expect(displayInvitation([a, b])).toBe(b);
  });

  it('초대가 없으면 null', () => {
    expect(displayInvitation([])).toBeNull();
  });
});

describe('joinStateWhere', () => {
  it('상태마다 조건을 낸다', () => {
    for (const state of STAFF_JOIN_STATES) {
      expect(joinStateWhere(state)).toBeDefined();
    }
  });

  it('INVITED 필터는 수락했는데 가입 완료가 아닌 직원도 건다 — 표시와 같게', () => {
    expect(JSON.stringify(joinStateWhere('INVITED'))).toContain(
      '"status":"ACCEPTED"',
    );
  });

  it('EXPIRED 필터는 거절 · 수락 초대가 있는 직원을 뺀다', () => {
    const json = JSON.stringify(joinStateWhere('EXPIRED'));
    expect(json).toContain('"status":"REJECTED"');
    expect(json).toContain('"status":"ACCEPTED"');
  });

  it('JOINED 가 아닌 상태는 모두 가입 완료를 뺀다', () => {
    for (const state of STAFF_JOIN_STATES.filter((s) => s !== 'JOINED')) {
      expect(JSON.stringify(joinStateWhere(state))).toContain(
        '"joinStatus":{"not":"JOINED"}',
      );
    }
  });
});
