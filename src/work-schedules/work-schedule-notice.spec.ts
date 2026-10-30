import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  changeText,
  noticeScheduleChange,
  sendScheduleMail,
} from './work-schedule-notice';
import { toSpan } from './work-schedule-rules';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const span = (ymd: string, s: string, e: string, breakMinutes = 0) => ({
  ...toSpan(d(ymd), s, e)!,
  breakMinutes,
});

describe('changeText (#{변경내용})', () => {
  it('등록 · 삭제 · 수정, 근무일이 같으면 뒤쪽 날짜를 뺀다', () => {
    expect(
      changeText({
        kind: 'CREATED',
        after: span('2026-10-21', '09:00', '18:00'),
      }),
    ).toBe('10월 21일(수) 09:00~18:00 추가');
    expect(
      changeText({
        kind: 'DELETED',
        before: span('2026-10-21', '09:00', '18:00'),
      }),
    ).toBe('10월 21일(수) 09:00~18:00 삭제');
    expect(
      changeText({
        kind: 'UPDATED',
        before: span('2026-10-09', '09:00', '15:00'),
        after: span('2026-10-09', '12:00', '18:00'),
      }),
    ).toBe('10월 9일(금) 09:00~15:00 → 12:00~18:00');
    expect(
      changeText({
        kind: 'UPDATED',
        before: span('2026-10-21', '09:00', '18:00'),
        after: span('2026-10-22', '09:00', '18:00'),
      }),
    ).toBe('10월 21일(수) 09:00~18:00 → 10월 22일(목) 09:00~18:00');
  });

  it('시각이 같고 휴게만 바뀌면 휴게 변화를, 시각도 바뀌면 시각 변화만 적는다', () => {
    expect(
      changeText({
        kind: 'UPDATED',
        before: span('2026-10-21', '09:00', '13:00', 30),
        after: span('2026-10-21', '09:00', '13:00', 60),
      }),
    ).toBe('10월 21일(수) 09:00~13:00 휴게 30분 → 60분');
    expect(
      changeText({
        kind: 'UPDATED',
        before: span('2026-10-21', '09:00', '13:00', 30),
        after: span('2026-10-21', '10:00', '13:00', 60),
      }),
    ).toBe('10월 21일(수) 09:00~13:00 → 10:00~13:00');
  });

  it('자정을 넘으면 「익일」, 24:00 에 끝나면 「24:00」', () => {
    expect(
      changeText({
        kind: 'CREATED',
        after: span('2026-10-21', '22:00', '02:00'),
      }),
    ).toBe('10월 21일(수) 22:00~익일 02:00 추가');
    expect(
      changeText({
        kind: 'CREATED',
        after: span('2026-10-21', '18:00', '24:00'),
      }),
    ).toBe('10월 21일(수) 18:00~24:00 추가');
  });
});

describe('noticeScheduleChange', () => {
  const template = {
    templateCode: 'PUSH_SCHEDULE_CHANGED',
    channel: 'PUSH',
    isActive: true,
    preferenceCategory: 'SCHEDULE',
    title: '#{근무지} 근무스케줄이 바뀌었습니다',
    body: '#{변경내용}',
    variables: [
      { name: '근무지', label: '근무지', isRequired: true, sampleValue: 'a' },
      { name: '변경내용', label: '변경', isRequired: true, sampleValue: 'b' },
    ],
  };
  const mockTx = () => ({
    staffMember: {
      findUnique: jest.fn().mockResolvedValue({
        storeId: 3,
        employmentStatus: 'EMPLOYED',
        account: { accountId: 5, status: 'JOINED', email: 'staff@example.com' },
      }),
    },
    store: { findUnique: jest.fn().mockResolvedValue({ name: '연남점' }) },
    notificationTemplate: { findUnique: jest.fn().mockResolvedValue(template) },
    notification: {
      create: jest.fn().mockResolvedValue({ notificationId: 100 }),
    },
    notificationRecipient: {
      create: jest.fn().mockResolvedValue({ notificationRecipientId: 200 }),
    },
    notificationPreference: { findFirst: jest.fn().mockResolvedValue(null) },
    notificationDelivery: { create: jest.fn() },
  });
  const log = { error: jest.fn(), warn: jest.fn() };
  const logger = log as unknown as Logger;
  const input = {
    staffMemberId: 11,
    workScheduleId: 70,
    changes: [
      {
        kind: 'CREATED' as const,
        after: span('2026-10-21', '09:00', '18:00'),
      },
    ],
  };
  const run = (tx: ReturnType<typeof mockTx>) =>
    noticeScheduleChange(
      tx as unknown as Prisma.TransactionClient,
      logger,
      input,
    );

  it('직원 알림 · 받는 사람 · 앱 푸시 발송 대기를 하나씩 만들고, 커밋 뒤 보낼 메일을 돌려준다(WHALEERP-639)', async () => {
    const tx = mockTx();
    await expect(run(tx)).resolves.toEqual({
      notificationRecipientId: 200,
      to: 'staff@example.com',
      variables: {
        근무지: '연남점',
        변경내용: '10월 21일(수) 09:00~18:00 추가',
      },
    });
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: {
        notificationTarget: 'STAFF',
        templateCode: 'PUSH_SCHEDULE_CHANGED',
        relatedType: 'WORK_SCHEDULE',
        relatedId: 70,
        title: '연남점 근무스케줄이 바뀌었습니다',
        body: '10월 21일(수) 09:00~18:00 추가',
      },
      select: { notificationId: true },
    });
    expect(tx.notificationRecipient.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notificationId: 100, accountId: 5 } }),
    );
    expect(tx.notificationDelivery.create).toHaveBeenCalledWith({
      data: { notificationRecipientId: 200, channel: 'PUSH' },
    });
  });

  it('수신 설정 묶음 근무스케줄을 끄면 알림함에만 — 앱 푸시 발송 대기가 없다(NTF-14)', async () => {
    const tx = mockTx();
    tx.notificationPreference.findFirst.mockResolvedValue({ accountId: 5 });
    // 메일도 보내지 않는다 — 메일 템플릿에는 묶음이 없어 앱 푸시의 판정을 따른다
    await expect(run(tx)).resolves.toBeNull();
    expect(tx.notificationRecipient.create).toHaveBeenCalled();
    expect(tx.notificationDelivery.create).not.toHaveBeenCalled();
  });

  it('템플릿이 없거나 사용 안 함이면 알림 없이 넘어간다(저장은 막지 않는다)', async () => {
    const missing = mockTx();
    missing.notificationTemplate.findUnique.mockResolvedValue(null);
    await expect(run(missing)).resolves.toBeNull();
    expect(missing.notification.create).not.toHaveBeenCalled();
    const off = mockTx();
    off.notificationTemplate.findUnique.mockResolvedValue({
      ...template,
      isActive: false,
    });
    await run(off);
    expect(off.notification.create).not.toHaveBeenCalled();
    // 보내지 않은 사실을 로그로 남긴다(NTF-25)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('missing'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('inactive'));
  });

  it('수신 설정 묶음은 템플릿 값을 따른다', async () => {
    const tx = mockTx();
    tx.notificationTemplate.findUnique.mockResolvedValue({
      ...template,
      preferenceCategory: 'TODO',
    });
    await run(tx);
    expect(tx.notificationPreference.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 5, preferenceCategory: 'TODO', isEnabled: false },
      }),
    );
  });

  it('채널이 PUSH 가 아니거나 렌더할 수 없으면(변수를 지움 · 제목 없음) 알림 없이 넘어간다', async () => {
    for (const broken of [
      { ...template, channel: 'EMAIL' },
      { ...template, body: '#{없는변수}' },
      { ...template, title: null },
    ]) {
      const tx = mockTx();
      tx.notificationTemplate.findUnique.mockResolvedValue(broken);
      await expect(run(tx)).resolves.toBeNull();
      expect(tx.notification.create).not.toHaveBeenCalled();
    }
  });

  it('DB 오류는 삼키지 않는다 — 저장째 되돌린다', async () => {
    const tx = mockTx();
    tx.notification.create.mockRejectedValue(new Error('db down'));
    await expect(run(tx)).rejects.toThrow('db down');
  });

  it('계정이 없는 직원 레코드면 아무것도 만들지 않고 로그를 남긴다(NTF-25)', async () => {
    const tx = mockTx();
    tx.staffMember.findUnique.mockResolvedValue({
      storeId: 3,
      employmentStatus: 'EMPLOYED',
      account: null,
    });
    await expect(run(tx)).resolves.toBeNull();
    expect(tx.notificationTemplate.findUnique).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no account'),
    );
  });

  it('퇴직한 직원 레코드면 만들지 않고 로그를 남긴다(PAY-14 v185)', async () => {
    const tx = mockTx();
    tx.staffMember.findUnique.mockResolvedValue({
      storeId: 3,
      employmentStatus: 'RETIRED',
      account: { accountId: 5, status: 'JOINED' },
    });
    await expect(run(tx)).resolves.toBeNull();
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('RETIRED'));
  });

  it('탈퇴한 계정이면 만들지 않고 로그를 남긴다', async () => {
    const tx = mockTx();
    tx.staffMember.findUnique.mockResolvedValue({
      storeId: 3,
      employmentStatus: 'EMPLOYED',
      account: { accountId: 5, status: 'WITHDRAWN' },
    });
    await expect(run(tx)).resolves.toBeNull();
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('withdrawn account'),
    );
  });

  it('점포가 없거나 이름이 비면 만들지 않고 로그를 남긴다', async () => {
    for (const store of [null, { name: '' }]) {
      const tx = mockTx();
      tx.store.findUnique.mockResolvedValue(store);
      await run(tx);
      expect(tx.notification.create).not.toHaveBeenCalled();
    }
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('store 3'));
  });

  it('여러 변경은 알림 하나에 「, 」로 묶는다(일괄 등록 · 바뀐 것 없는 수정은 뺀다)', async () => {
    const tx = mockTx();
    const same = span('2026-10-21', '20:00', '22:00', 0);
    await noticeScheduleChange(
      tx as unknown as Prisma.TransactionClient,
      logger,
      {
        staffMemberId: 11,
        workScheduleId: 70,
        changes: [
          // 시작 시각순으로 잇는다 — 순서를 거꾸로 넘긴다
          { kind: 'CREATED', after: span('2026-10-21', '17:00', '21:00') },
          { kind: 'CREATED', after: span('2026-10-21', '09:00', '13:00') },
          { kind: 'UPDATED', before: same, after: { ...same } },
        ],
      },
    );
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          body: '10월 21일(수) 09:00~13:00 추가, 10월 21일(수) 17:00~21:00 추가',
        }) as unknown,
      }),
    );
  });

  it('시작 · 종료 · 휴게가 모두 같은 수정은 알리지 않는다', async () => {
    const tx = mockTx();
    const same = span('2026-10-21', '09:00', '13:00', 30);
    await noticeScheduleChange(
      tx as unknown as Prisma.TransactionClient,
      logger,
      {
        staffMemberId: 11,
        workScheduleId: 70,
        changes: [{ kind: 'UPDATED', before: same, after: { ...same } }],
      },
    );
    expect(tx.staffMember.findUnique).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });
});

describe('sendScheduleMail (WHALEERP-639)', () => {
  const mail = {
    notificationRecipientId: 200,
    to: 'staff@example.com',
    variables: { 근무지: '연남점', 변경내용: '10월 21일(수) 09:00~18:00 추가' },
  };
  const setup = (patch: { mail?: null; appUrl?: null } = {}) => {
    const prisma = { notificationDelivery: { create: jest.fn() } };
    const mailer = { send: jest.fn().mockResolvedValue({ messageId: 'm' }) };
    const logger = { warn: jest.fn(), error: jest.fn() };
    const deps = {
      prisma: prisma as unknown as PrismaService,
      mail: 'mail' in patch ? null : (mailer as unknown as MailService),
      appUrl: 'appUrl' in patch ? null : 'https://staff.example.com/x',
      logger: logger as unknown as Logger,
    };
    return { prisma, mailer, logger, deps };
  };

  it('근무 탭 링크를 붙여 계정 이메일로 보내고, EMAIL 발송 이력을 sent_at · SUCCEEDED 로 남긴다', async () => {
    const { prisma, mailer, deps } = setup();
    await sendScheduleMail(deps, mail);
    expect(mailer.send).toHaveBeenCalledWith({
      templateCode: 'EMAIL_SCHEDULE_CHANGED',
      to: 'staff@example.com',
      variables: { ...mail.variables, 링크: 'https://staff.example.com/work' },
    });
    expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
      data: {
        notificationRecipientId: 200,
        channel: 'EMAIL',
        result: 'SUCCEEDED',
        sentAt: expect.any(Date) as unknown,
      },
    });
  });

  it('보낼 메일이 없으면(null) 아무것도 하지 않는다', async () => {
    const { prisma, mailer, deps } = setup();
    await sendScheduleMail(deps, null);
    expect(mailer.send).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
  });

  it('메일 설정 · 직원 앱 주소가 없으면 보내지 않고 로그만(알림함 줄은 남아 있다)', async () => {
    for (const patch of [{ mail: null }, { appUrl: null }] as const) {
      const { prisma, logger, deps } = setup(patch);
      await sendScheduleMail(deps, mail);
      expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('work schedule mail SKIPPED'),
      );
    }
  });

  it('보내기 전에 막히면(템플릿 꺼짐 등) 던지지 않고 이력 없이 로그만', async () => {
    const { prisma, mailer, logger, deps } = setup();
    mailer.send.mockRejectedValue(new Error('template inactive'));
    await expect(sendScheduleMail(deps, mail)).resolves.toBeUndefined();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('NOT SENT'),
    );
  });

  it('이력 쓰기가 실패해도 던지지 않는다', async () => {
    const { prisma, logger, deps } = setup();
    prisma.notificationDelivery.create.mockRejectedValue(new Error('db'));
    await expect(sendScheduleMail(deps, mail)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('delivery row not written'),
    );
  });
});
