import { Logger } from '@nestjs/common';
import { noticeStaff } from './staff-notice';

const TEMPLATE = {
  templateCode: 'PUSH_PAYSLIP_SENT',
  channel: 'PUSH',
  isActive: true,
  title: '#{급여월} 급여명세서가 도착했습니다',
  body: '#{근무지}에서 보낸 급여명세서입니다.',
  variables: [
    { name: '급여월', label: '급여월', isRequired: true, sampleValue: '7월' },
    {
      name: '근무지',
      label: '근무지',
      isRequired: true,
      sampleValue: '연남점',
    },
  ],
  preferenceCategory: 'PAYSLIP',
};

function txWith(over: { template?: unknown; off?: boolean } = {}) {
  return {
    notificationTemplate: {
      findUnique: jest
        .fn()
        .mockResolvedValue('template' in over ? over.template : TEMPLATE),
    },
    notification: {
      create: jest.fn().mockResolvedValue({ notificationId: 11 }),
    },
    notificationRecipient: {
      create: jest.fn().mockResolvedValue({ notificationRecipientId: 22 }),
    },
    notificationPreference: {
      findFirst: jest
        .fn()
        .mockResolvedValue(over.off ? { accountId: 5 } : null),
    },
    notificationDelivery: { create: jest.fn().mockResolvedValue({}) },
  };
}

const input = {
  templateCode: 'PUSH_PAYSLIP_SENT',
  accountId: 5,
  relatedType: 'PAYSLIP',
  relatedId: 77,
  variables: { 급여월: '9월', 근무지: '강남역점' },
};

describe('noticeStaff', () => {
  let logger: Logger;
  let log: { warn: jest.Mock; error: jest.Mock };
  beforeEach(() => {
    log = { warn: jest.fn(), error: jest.fn() };
    logger = log as unknown as Logger;
  });

  it('템플릿으로 문구를 채워 직원 알림 · 받는 사람 · 앱 푸시 발송 대기를 만든다', async () => {
    const tx = txWith();
    await expect(noticeStaff(tx as never, logger, input)).resolves.toBe(true);
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: {
        notificationTarget: 'STAFF',
        templateCode: 'PUSH_PAYSLIP_SENT',
        relatedType: 'PAYSLIP',
        relatedId: 77,
        title: '9월 급여명세서가 도착했습니다',
        body: '강남역점에서 보낸 급여명세서입니다.',
      },
      select: { notificationId: true },
    });
    expect(tx.notificationRecipient.create).toHaveBeenCalledWith({
      data: { notificationId: 11, accountId: 5 },
      select: { notificationRecipientId: true },
    });
    expect(tx.notificationPreference.findFirst).toHaveBeenCalledWith({
      where: { accountId: 5, preferenceCategory: 'PAYSLIP', isEnabled: false },
      select: { accountId: true },
    });
    expect(tx.notificationDelivery.create).toHaveBeenCalledWith({
      data: { notificationRecipientId: 22, channel: 'PUSH' },
    });
  });

  it('수신 설정 묶음을 끈 직원은 알림함 줄만 — 앱 푸시 발송 대기가 없다', async () => {
    const tx = txWith({ off: true });
    await expect(noticeStaff(tx as never, logger, input)).resolves.toBe(true);
    expect(tx.notificationRecipient.create).toHaveBeenCalled();
    expect(tx.notificationDelivery.create).not.toHaveBeenCalled();
  });

  it.each([
    ['없는 템플릿', null, 'error'],
    ['채널이 다른 템플릿', { ...TEMPLATE, channel: 'EMAIL' }, 'error'],
    ['사용 안 함', { ...TEMPLATE, isActive: false }, 'warn'],
    [
      '렌더할 수 없는 템플릿(필수 변수 빠짐)',
      {
        ...TEMPLATE,
        variables: [
          ...TEMPLATE.variables,
          {
            name: '없는값',
            label: '없는값',
            isRequired: true,
            sampleValue: 'x',
          },
        ],
        title: '#{없는값} 제목',
      },
      'error',
    ],
  ])(
    '%s 이면 만들지 않고 false — 업무 저장은 막지 않는다',
    async (_label, template, level) => {
      const tx = txWith({ template });
      await expect(noticeStaff(tx as never, logger, input)).resolves.toBe(
        false,
      );
      expect(tx.notification.create).not.toHaveBeenCalled();
      expect(log[level as 'warn' | 'error']).toHaveBeenCalled();
    },
  );
});
