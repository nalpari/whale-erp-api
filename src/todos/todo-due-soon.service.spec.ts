import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TodoDueSoonService } from './todo-due-soon.service';
import { SIGNED_ONCE } from '../contracts/signed-contract';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const t = (hm: string) => new Date(`1970-01-01T${hm}:00.000Z`);
/** 첫 호출의 첫 인자 — Prisma 호출 하나({ where, data })를 본다 */
type Call = { where?: unknown; data: Record<string, unknown>[] };
const firstArg = (mock: jest.Mock) => (mock.mock.calls[0] as [Call])[0];

// 한국 2026-10-19 17:30
const NOW = new Date('2026-10-19T08:30:00Z');

const TEMPLATE = {
  templateCode: 'PUSH_TODO_DUE_SOON',
  channel: 'PUSH',
  isActive: true,
  preferenceCategory: 'TODO',
  title: '곧 수행할 TO-DO가 있습니다',
  body: '#{TO-DO제목} · #{수행예정일시}',
  variables: [
    { name: 'TO-DO제목', isRequired: true },
    { name: '수행예정일시', isRequired: true },
  ],
  kakaoTemplateCode: null,
};

const todo = (
  todoId: number,
  dueDate: string,
  dueTime: string | null,
  accounts: number[],
  isUrgent = false,
) => ({
  todoId,
  title: `할 일 ${todoId}`,
  dueDate: d(dueDate),
  dueTime: dueTime ? t(dueTime) : null,
  isUrgent,
  todoAssignees: accounts.map((accountId) => ({
    staffMember: { accountId },
  })),
});

describe('TodoDueSoonService (수행 임박 알림)', () => {
  const service = new TodoDueSoonService();
  let tx: {
    todo: { findMany: jest.Mock };
    notificationTemplate: { findUnique: jest.Mock };
    notification: { createManyAndReturn: jest.Mock };
    notificationRecipient: { createManyAndReturn: jest.Mock };
    notificationPreference: { findMany: jest.Mock };
    notificationDelivery: { createMany: jest.Mock };
  };
  const run = () =>
    service.notifyDueSoon(tx as unknown as Prisma.TransactionClient, NOW);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    tx = {
      todo: { findMany: jest.fn().mockResolvedValue([]) },
      notificationTemplate: {
        findUnique: jest.fn().mockResolvedValue(TEMPLATE),
      },
      notification: {
        // 넘긴 행을 모두 만든 것으로(중복 없음)
        createManyAndReturn: jest.fn(
          ({ data }: { data: { dedupeKey: string }[] }) =>
            Promise.resolve(
              data.map((n, i) => ({
                notificationId: 500 + i,
                dedupeKey: n.dedupeKey,
              })),
            ),
        ),
      },
      notificationRecipient: {
        createManyAndReturn: jest.fn(
          ({
            data,
          }: {
            data: { notificationId: number; accountId: number }[];
          }) =>
            Promise.resolve(
              data.map((r) => ({
                notificationRecipientId: r.notificationId + 1000,
                accountId: r.accountId,
              })),
            ),
        ),
      },
      notificationPreference: { findMany: jest.fn().mockResolvedValue([]) },
      notificationDelivery: { createMany: jest.fn() },
    };
  });
  afterEach(() => jest.restoreAllMocks());

  it('지우지 않은 대기 · 진행 중 TO-DO 가운데 한국 날짜로 오늘 · 내일 것만 읽고, 퇴직했거나 체결 완료 계약이 없는 직원은 받는 사람에서 뺀다', async () => {
    await run();
    expect(tx.todo.findMany).toHaveBeenCalledWith({
      where: {
        isDeleted: false,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        dueDate: { in: [d('2026-10-19'), d('2026-10-20')] },
      },
      select: expect.objectContaining({
        todoAssignees: {
          where: {
            staffMember: {
              employmentStatus: 'EMPLOYED',
              joinStatus: 'JOINED',
              contracts: { some: SIGNED_ONCE },
              accountId: { not: null },
            },
          },
          select: { staffMember: { select: { accountId: true } } },
        },
      }) as unknown,
    });
  });

  it('시간 있음은 1시간 전부터, 날짜만은 그날 09:00 부터 — 수행 예정 일시가 지난 것은 보내지 않는다', async () => {
    tx.todo.findMany.mockResolvedValue([
      todo(1, '2026-10-19', '18:00', [3]), // 30분 뒤 → 보냄
      todo(2, '2026-10-19', '19:00', [3]), // 1시간 30분 뒤 → 아직
      todo(3, '2026-10-19', null, [3]), // 날짜만, 09:00 지남 → 보냄
      todo(4, '2026-10-19', '17:00', [3]), // 이미 지남 → 안 보냄
      todo(5, '2026-10-20', null, [3]), // 내일 → 아직
    ]);

    await expect(run()).resolves.toBe(2);
    const data = firstArg(tx.notification.createManyAndReturn).data;
    expect(data.map((n) => n.relatedId)).toEqual([1, 3]);
  });

  it('직원 알림을 받는 계정마다 하나 — dedupe_key 에 수행 예정 일시(T-3), 긴급 여부, 템플릿 문구', async () => {
    tx.todo.findMany.mockResolvedValue([
      // 한 명 수행 — 대상 전원
      todo(7, '2026-10-19', '18:00', [3, 4, 3], true),
    ]);

    await run();

    expect(tx.notification.createManyAndReturn).toHaveBeenCalledWith({
      data: [3, 4].map((accountId) => ({
        notificationTarget: 'STAFF',
        templateCode: 'PUSH_TODO_DUE_SOON',
        relatedType: 'TODO',
        relatedId: 7,
        title: '곧 수행할 TO-DO가 있습니다',
        body: '할 일 7 · 10월 19일 18:00',
        dedupeKey: `todo-due-soon:7:2026-10-19T18:00:${accountId}`,
        isUrgent: true,
      })),
      // 이미 보낸 것(같은 dedupe_key)은 만들지 않는다
      skipDuplicates: true,
      select: { notificationId: true, dedupeKey: true },
    });
    expect(tx.notificationRecipient.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        { notificationId: 500, accountId: 3 },
        { notificationId: 501, accountId: 4 },
      ],
      select: { notificationRecipientId: true, accountId: true },
    });
  });

  it('이미 보낸 알림(중복으로 건너뛴 것)에는 수신 · 발송 행을 만들지 않는다', async () => {
    tx.todo.findMany.mockResolvedValue([todo(7, '2026-10-19', '18:00', [3])]);
    tx.notification.createManyAndReturn.mockResolvedValue([]);

    await expect(run()).resolves.toBe(0);
    expect(tx.notificationRecipient.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.notificationDelivery.createMany).not.toHaveBeenCalled();
  });

  it('앱 푸시는 수신 설정 묶음 TO-DO 를 끈 계정에는 발송 대기 행을 만들지 않는다(알림함에는 남는다)', async () => {
    tx.todo.findMany.mockResolvedValue([
      todo(7, '2026-10-19', '18:00', [3, 4]),
    ]);
    tx.notificationPreference.findMany.mockResolvedValue([{ accountId: 4 }]);

    await run();

    expect(tx.notificationPreference.findMany).toHaveBeenCalledWith({
      where: {
        accountId: { in: [3, 4] },
        preferenceCategory: 'TODO',
        isEnabled: false,
      },
      select: { accountId: true },
    });
    expect(tx.notificationDelivery.createMany).toHaveBeenCalledWith({
      data: [{ notificationRecipientId: 1500, channel: 'PUSH' }],
    });
  });

  it('수신 설정 묶음은 템플릿 값을 따른다 — 운영자가 바꾸면 그 묶음으로 본다', async () => {
    tx.todo.findMany.mockResolvedValue([todo(7, '2026-10-19', '18:00', [3])]);
    tx.notificationTemplate.findUnique.mockResolvedValue({
      ...TEMPLATE,
      preferenceCategory: 'SCHEDULE',
    });

    await run();

    const [arg] = tx.notificationPreference.findMany.mock.calls[0] as [
      { where: { preferenceCategory: string } },
    ];
    expect(arg.where.preferenceCategory).toBe('SCHEDULE');
  });

  it('운영자가 끈 템플릿은 warn 으로 넘기고 아무것도 만들지 않는다', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const error = jest.spyOn(Logger.prototype, 'error');
    tx.todo.findMany.mockResolvedValue([todo(7, '2026-10-19', '18:00', [3])]);
    tx.notificationTemplate.findUnique.mockResolvedValue({
      ...TEMPLATE,
      isActive: false,
    });

    await expect(run()).resolves.toBe(0);
    expect(tx.notification.createManyAndReturn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('템플릿 행이 없거나 채널이 다르면 error 로그를 남기고 아무것도 만들지 않는다', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    tx.todo.findMany.mockResolvedValue([todo(7, '2026-10-19', '18:00', [3])]);
    tx.notificationTemplate.findUnique.mockResolvedValue(null);
    await expect(run()).resolves.toBe(0);
    tx.notificationTemplate.findUnique.mockResolvedValue({
      ...TEMPLATE,
      channel: 'EMAIL',
    });
    await expect(run()).resolves.toBe(0);
    expect(error).toHaveBeenCalledTimes(2);
    expect(tx.notification.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('템플릿 조회의 DB 오류는 삼키지 않고 error 로그를 남긴 뒤 던진다(배치가 FAILED 로 남긴다)', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    tx.todo.findMany.mockResolvedValue([todo(7, '2026-10-19', '18:00', [3])]);
    const boom = new Error('connection lost');
    tx.notificationTemplate.findUnique.mockRejectedValue(boom);

    await expect(run()).rejects.toBe(boom);
    expect(error).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(tx.notification.createManyAndReturn).not.toHaveBeenCalled();
  });

  it.each([
    [
      '운영자가 변수 이름을 바꿈',
      {
        body: '#{제목} · #{수행예정일시}',
        variables: [{ name: '제목' }, { name: '수행예정일시' }],
      },
    ],
    ['제목이 비어 있음(null)', { title: null }],
  ])(
    '템플릿을 렌더할 수 없으면(%s) error 로그 · 0 건 — 던지지 않는다',
    async (_, patch) => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      tx.todo.findMany.mockResolvedValue([todo(7, '2026-10-19', '18:00', [3])]);
      tx.notificationTemplate.findUnique.mockResolvedValue({
        ...TEMPLATE,
        ...patch,
      });

      await expect(run()).resolves.toBe(0);
      expect(error).toHaveBeenCalled();
      expect(tx.notification.createManyAndReturn).not.toHaveBeenCalled();
    },
  );

  it('일부만 새로 만들어졌으면(나머지는 이미 보냄) 받는 사람을 dedupe_key 로 짝짓는다', async () => {
    tx.todo.findMany.mockResolvedValue([
      todo(7, '2026-10-19', '18:00', [3, 4, 5]),
    ]);
    // 3 · 5 는 이미 보냄 — 4 의 것만 돌아온다
    tx.notification.createManyAndReturn.mockResolvedValue([
      { notificationId: 900, dedupeKey: 'todo-due-soon:7:2026-10-19T18:00:4' },
    ]);

    await expect(run()).resolves.toBe(1);
    expect(firstArg(tx.notificationRecipient.createManyAndReturn).data).toEqual(
      [{ notificationId: 900, accountId: 4 }],
    );
  });

  it.each([
    // 한국 2026-10-20 00:40 — UTC 날짜는 아직 19일. 오늘(20일) 01:30 건은 50분 뒤라 보낸다
    ['2026-10-19T15:40:00Z', '2026-10-20', '01:30', true],
    // 한국 2026-10-19 23:40 — 내일 00:30 건의 1시간 전(23:30)이 지났다
    ['2026-10-19T14:40:00Z', '2026-10-20', '00:30', true],
    // 한국 2026-10-19 23:20 — 내일 00:30 건은 아직
    ['2026-10-19T14:20:00Z', '2026-10-20', '00:30', false],
    // 날짜만 — 한국 23:59 에는 보내고, 다음 날 00:00 에는 지나서 안 보낸다
    ['2026-10-19T14:59:00Z', '2026-10-19', null, true],
    ['2026-10-19T15:00:00Z', '2026-10-19', null, false],
  ])(
    '한국 시각 경계 — 지금 %s, 수행 예정 %s %s → 보냄 %s',
    async (now, dueDate, dueTime, sent) => {
      tx.todo.findMany.mockResolvedValue([todo(7, dueDate, dueTime, [3])]);
      await expect(
        service.notifyDueSoon(
          tx as unknown as Prisma.TransactionClient,
          new Date(now),
        ),
      ).resolves.toBe(sent ? 1 : 0);
    },
  );

  it('보낼 것이 없으면 템플릿도 읽지 않는다', async () => {
    await expect(run()).resolves.toBe(0);
    expect(tx.notificationTemplate.findUnique).not.toHaveBeenCalled();
  });
});
