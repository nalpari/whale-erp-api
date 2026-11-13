import {
  AFFILIATION_TEMPLATE,
  INVITATION_TEMPLATE,
} from '../contracts/contract-send-log';
import {
  MAIL_SEND_FAILURE_MESSAGE,
  type MailLogRow,
  mergeSendLogs,
  type SendLogRow,
  toSendLogs,
} from './send-logs';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 29, 0, minute));
let nextId = 1;
const row = (over: Partial<SendLogRow>): SendLogRow => ({
  alimtalkSendLogId: nextId++,
  templateCode: INVITATION_TEMPLATE,
  relatedId: 7,
  result: 'SUCCEEDED',
  failureReason: null,
  sentAt: at(nextId),
  ...over,
});

describe('toSendLogs — 직원 상세 발송 이력', () => {
  beforeEach(() => (nextId = 1));

  it('최근 순으로 내고, 템플릿으로 종류를 가른다(복귀 확인도 소속 추가 확인 요청)', () => {
    const logs = toSendLogs([
      row({ relatedId: 7 }),
      row({ relatedId: 8, templateCode: AFFILIATION_TEMPLATE }),
    ]);
    expect(logs.map((l) => [l.sendLogId, l.contractId, l.kind])).toEqual([
      [2, 8, 'AFFILIATION_REQUEST'],
      [1, 7, 'SIGNUP_INVITE'],
    ]);
  });

  it('성공은 사유 · 재시도 가능 여부가 null', () => {
    const [log] = toSendLogs([row({})]);
    expect(log).toMatchObject({
      result: 'SUCCEEDED',
      failureReason: null,
      retryable: null,
      isResend: false,
    });
  });

  it('같은 계약에 앞서 나간 발송이 있으면 재발송 — 계약마다 따로 센다', () => {
    const logs = toSendLogs([
      row({ relatedId: 7 }),
      row({ relatedId: 8 }),
      row({ relatedId: 7 }),
    ]);
    expect(logs.map((l) => [l.contractId, l.isResend])).toEqual([
      [7, true],
      [8, false],
      [7, false],
    ]);
  });

  it('확실히 나가지 않은 실패(되돌림) 뒤의 발송은 재발송이 아니다 — 접수 여부 모름 뒤는 재발송', () => {
    const logs = toSendLogs([
      row({ result: 'FAILED', failureReason: 'code=3018 http=200: x' }),
      row({}),
      row({
        relatedId: 8,
        result: 'FAILED',
        failureReason:
          'code=undefined http=undefined: /v3/message failed: aborted',
      }),
      row({ relatedId: 8 }),
    ]);
    expect(
      logs.map((l) => [l.contractId, l.result, l.isResend, l.retryable]),
    ).toEqual([
      [8, 'SUCCEEDED', true, null],
      [8, 'UNCONFIRMED', false, false],
      [7, 'SUCCEEDED', false, null],
      [7, 'FAILED', false, true],
    ]);
  });

  it('근로계약 발송이 아닌 알림톡 · 관련 계약이 없는 줄은 뺀다', () => {
    expect(
      toSendLogs([
        row({ templateCode: 'TALK_CONTRACT_REMINDER' }),
        row({ relatedId: null }),
      ]),
    ).toEqual([]);
  });

  it('비즈뿌리오 원문(번호가 섞일 수 있다)은 사유에 싣지 않는다', () => {
    const [log] = toSendLogs([
      row({
        result: 'FAILED',
        failureReason: 'code=3018 http=200: sendMessage failed to 01012345678',
      }),
    ]);
    expect(log.failureReason).not.toContain('01012345678');
    expect(log.failureReason).toContain('3018');
  });
});

describe('mergeSendLogs — 알림톡 줄과 비밀번호 초기화 메일 줄', () => {
  const mail = (over: Partial<MailLogRow>): MailLogRow => ({
    mailId: 1,
    result: 'SUCCEEDED',
    sentAt: at(10),
    ...over,
  });

  it('보낸 시각 최근 순으로 섞고, 메일 줄은 PASSWORD_RESET · 계약 없음 · 재발송 아님 · 재시도 정보 없음', () => {
    nextId = 1;
    const talk = toSendLogs([
      row({ sentAt: at(5) }),
      row({ sentAt: at(20), relatedId: 8 }),
    ]);
    const logs = mergeSendLogs(talk, [mail({ mailId: 1, sentAt: at(10) })]);
    expect(logs.map((l) => [l.kind, l.sendLogId])).toEqual([
      ['SIGNUP_INVITE', 2],
      ['PASSWORD_RESET', 1],
      ['SIGNUP_INVITE', 1],
    ]);
    expect(logs[1]).toEqual({
      sendLogId: 1,
      contractId: null,
      kind: 'PASSWORD_RESET',
      isResend: false,
      result: 'SUCCEEDED',
      failureReason: null,
      retryable: null,
      sentAt: at(10),
    });
  });

  it('실패한 메일은 SMTP 원문 없이 안전한 문구만 낸다', () => {
    const [log] = mergeSendLogs([], [mail({ result: 'FAILED' })]);
    expect(log).toMatchObject({
      result: 'FAILED',
      failureReason: MAIL_SEND_FAILURE_MESSAGE,
      retryable: null,
    });
  });

  it('보낸 시각이 같으면 넘겨받은 순서를 지킨다 — 알림톡 줄이 메일 줄보다 앞', () => {
    nextId = 1;
    const talk = toSendLogs([row({ sentAt: at(10) }), row({ sentAt: at(10) })]);
    const logs = mergeSendLogs(talk, [
      mail({ mailId: 9, sentAt: at(10) }),
      mail({ mailId: 8, sentAt: at(10) }),
    ]);
    expect(logs.map((l) => [l.kind, l.sendLogId])).toEqual([
      ['SIGNUP_INVITE', 2],
      ['SIGNUP_INVITE', 1],
      ['PASSWORD_RESET', 9],
      ['PASSWORD_RESET', 8],
    ]);
  });

  it('알림톡 줄이 없어도 메일 줄만 나온다', () => {
    expect(mergeSendLogs([], [mail({})])).toHaveLength(1);
  });
});
