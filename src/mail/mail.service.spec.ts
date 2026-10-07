import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_CONFIG } from './mail.config';
import { MAIL_TRANSPORT, MailService } from './mail.service';
import { MASK } from './render-template';

describe('MailService', () => {
  let service: MailService;
  let transport: { sendMail: jest.Mock };
  let prisma: {
    notificationTemplate: { findUnique: jest.Mock };
    mailSendLog: { create: jest.Mock };
  };
  let logs: string[];

  const template = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    channel: 'EMAIL',
    isActive: true,
    title: '[WHALE ERP] 임시 비밀번호',
    body: '<p>#{관리자이름} 님</p><p>#{임시비밀번호}</p>',
    variables: [
      { name: '관리자이름', isRequired: true },
      { name: '임시비밀번호', isRequired: true },
    ],
  };
  const input = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    to: 'hong@example.com',
    variables: { 관리자이름: '이서준', 임시비밀번호: 'x8Rk-2mPq' },
    maskedVariables: ['임시비밀번호'],
    adminAccountId: 12,
    sentBy: 3,
  };

  beforeEach(async () => {
    transport = {
      sendMail: jest.fn().mockResolvedValue({ messageId: '<abc@gmail.com>' }),
    };
    prisma = {
      notificationTemplate: {
        findUnique: jest.fn().mockResolvedValue(template),
      },
      mailSendLog: { create: jest.fn().mockResolvedValue({}) },
    };
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: string) => void logs.push(message));

    const module = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: MAIL_TRANSPORT, useValue: transport },
        { provide: MAIL_CONFIG, useValue: { username: 'noreply@whale.test' } },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(MailService);
  });

  afterEach(() => jest.restoreAllMocks());

  /** 기록된 mail_send_logs 한 행 */
  const logged = () =>
    (
      prisma.mailSendLog.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ]
    )[0].data;

  it('템플릿 코드로 조회해 HTML 로 보내고 messageId 를 돌려준다', async () => {
    await expect(service.send(input)).resolves.toEqual({
      messageId: '<abc@gmail.com>',
    });

    expect(prisma.notificationTemplate.findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'EMAIL_TEMP_PASSWORD' },
    });
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: { name: 'WHALE ERP', address: 'noreply@whale.test' },
      to: 'hong@example.com',
      subject: '[WHALE ERP] 임시 비밀번호',
      html: '<p>이서준 님</p><p>x8Rk-2mPq</p>',
    });
  });

  it('성공하면 가린 본문으로 SUCCEEDED 이력을 남긴다', async () => {
    await service.send(input);

    expect(prisma.mailSendLog.create).toHaveBeenCalledWith({
      data: {
        mailTypeCode: 'EMAIL_TEMP_PASSWORD',
        adminAccountId: 12,
        fromEmail: 'noreply@whale.test',
        toEmail: 'hong@example.com',
        subject: '[WHALE ERP] 임시 비밀번호',
        body: `<p>이서준 님</p><p>${MASK}</p>`,
        result: 'SUCCEEDED',
        failureReason: null,
        sentBy: 3,
      },
    });
  });

  it('수신 관리자 · 처리자를 넘기지 않으면 NULL 로 남긴다', async () => {
    await service.send({
      templateCode: input.templateCode,
      to: input.to,
      variables: input.variables,
    });

    expect(logged()).toMatchObject({ adminAccountId: null, sentBy: null });
  });

  it('SMTP 가 실패하면 FAILED 이력을 남기고 원래 예외를 다시 던진다', async () => {
    const error = Object.assign(new Error('Invalid login'), {
      code: 'EAUTH',
      responseCode: 535,
    });
    transport.sendMail.mockRejectedValue(error);

    await expect(service.send(input)).rejects.toBe(error);
    expect(logged()).toMatchObject({
      result: 'FAILED',
      failureReason: 'code=EAUTH response=535: Invalid login',
      body: `<p>이서준 님</p><p>${MASK}</p>`,
    });
  });

  it('code 가 없는 SMTP 오류도 FAILED 이력을 남긴다', async () => {
    transport.sendMail.mockRejectedValue(new Error('socket hang up'));

    await expect(service.send(input)).rejects.toThrow('socket hang up');
    expect(logged()).toMatchObject({
      result: 'FAILED',
      failureReason: 'code=undefined response=undefined: socket hang up',
    });
  });

  it('보낸 뒤 이력 INSERT 가 실패해도 던지지 않는다 — 다시 보내게 하지 않는다', async () => {
    prisma.mailSendLog.create.mockRejectedValue(new Error('db down'));

    await expect(service.send(input)).resolves.toEqual({
      messageId: '<abc@gmail.com>',
    });
    expect(logs.some((m) => m.includes('mail_send_logs INSERT FAILED'))).toBe(
      true,
    );
  });

  it('이력 INSERT 실패 로그에는 오류 이름 · 코드와 id 만 남기고 메시지는 남기지 않는다', async () => {
    // Prisma 오류 메시지는 호출 인자(data)를 통째로 찍는다 — 주소와 본문이 들어 있다.
    prisma.mailSendLog.create.mockRejectedValue(
      Object.assign(
        new Error(
          'Foreign key constraint violated: data { toEmail: "hong@example.com", body: "<p>이서준 님</p>" }',
        ),
        { name: 'PrismaClientKnownRequestError', code: 'P2003' },
      ),
    );

    await service.send(input);

    const line = logs.find((m) => m.includes('mail_send_logs INSERT FAILED'));
    expect(line).toContain('PrismaClientKnownRequestError');
    expect(line).toContain('code=P2003');
    expect(line).toContain('adminAccountId=12');
    expect(line).toContain('sentBy=3');
    expect(line).not.toContain('hong@example.com');
    expect(line).not.toContain('이서준');
  });

  it('SMTP 오류가 주소를 다른 대소문자로 되풀이해도 로그에서 가린다', async () => {
    transport.sendMail.mockRejectedValue(
      new Error('550 5.1.1 <HONG@EXAMPLE.COM> user unknown'),
    );

    await service.send(input).catch(() => undefined);

    for (const message of logs)
      expect(message.toLowerCase()).not.toContain('hong@example.com');
  });

  it('SMTP 실패 뒤 이력 INSERT 도 실패하면 SMTP 예외를 던진다', async () => {
    const error = new Error('Invalid login');
    transport.sendMail.mockRejectedValue(error);
    prisma.mailSendLog.create.mockRejectedValue(new Error('db down'));

    await expect(service.send(input)).rejects.toBe(error);
  });

  it.each([
    ['템플릿이 없다', null],
    ['사용 안 함', { ...template, isActive: false }],
    ['메일 채널이 아니다', { ...template, channel: 'PUSH' }],
  ])('%s 면 보내지도 기록하지도 않고 던진다', async (_, row) => {
    prisma.notificationTemplate.findUnique.mockResolvedValue(row);

    await expect(service.send(input)).rejects.toThrow('EMAIL_TEMP_PASSWORD');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(prisma.mailSendLog.create).not.toHaveBeenCalled();
  });

  it('필수 변수가 빠지면 보내지도 기록하지도 않고 던진다', async () => {
    await expect(
      service.send({ ...input, variables: { 관리자이름: '이서준' } }),
    ).rejects.toThrow('임시비밀번호');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(prisma.mailSendLog.create).not.toHaveBeenCalled();
  });

  it.each([
    'hong',
    'hong@example',
    '"홍길동" <hong@example.com>',
    'hong@example.com, kim@example.com',
    'hong@example.com;kim@example.com',
    'hong @example.com',
    'hong@example.com (홍길동)',
  ])('주소 하나가 아니면(%s) 조회도 하지 않고 던진다', async (to) => {
    await expect(service.send({ ...input, to })).rejects.toThrow('메일 주소');
    expect(prisma.notificationTemplate.findUnique).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(prisma.mailSendLog.create).not.toHaveBeenCalled();
  });

  it('254자를 넘는 주소는 모양이 맞아도 던진다', async () => {
    const to = `${'a'.repeat(243)}@example.com`; // 255자

    await expect(service.send({ ...input, to })).rejects.toThrow('메일 주소');
    expect(prisma.notificationTemplate.findUnique).not.toHaveBeenCalled();
  });

  it('254자 주소는 받는다', async () => {
    const to = `${'a'.repeat(242)}@example.com`; // 254자

    await service.send({ ...input, to });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to }),
    );
  });

  it('정규식이 되돌아가게 만드는 긴 입력도 바로 던진다(ReDoS)', async () => {
    const to = `a@${'.'.repeat(100_000)}@`;

    const started = Date.now();
    await expect(service.send({ ...input, to })).rejects.toThrow('메일 주소');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('로그용으로 자른 자리에 걸친 주소도 이름 부분이 새지 않는다', async () => {
    const address = 'hong.gildong@example.com';
    // 자르는 자리(1000자)가 주소 앞 · 가운데 · @ · 뒤에 오도록 앞을 채운다.
    for (let offset = 0; offset <= address.length + 1; offset++) {
      logs.length = 0;
      transport.sendMail.mockRejectedValue(
        new Error(
          `${'x '.repeat(500)}`.slice(0, 1000 - 40 - offset) +
            ` <${address}> ${'y'.repeat(50)}`,
        ),
      );

      await service.send(input).catch(() => undefined);

      const line = logs.find((m) => m.startsWith('mail FAILED'));
      expect(line).not.toContain('hong.gil');
    }
  });

  it('SMTP 오류 문장이 아주 길어도 로그 가림이 멈추지 않고, 이력에는 원문을 남긴다', async () => {
    const message = 'a'.repeat(100_000);
    transport.sendMail.mockRejectedValue(new Error(message));

    const started = Date.now();
    await expect(service.send(input)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logged().failureReason).toBe(
      `code=undefined response=undefined: ${message}`,
    );
  });

  it('로그에 본문 값과 원래 주소를 남기지 않는다', async () => {
    await service.send(input);
    transport.sendMail.mockRejectedValue(
      new Error('550 hong@example.com mailbox unavailable'),
    );
    await service.send(input).catch(() => undefined);

    expect(logs.length).toBeGreaterThan(0);
    for (const message of logs) {
      expect(message).not.toContain('x8Rk-2mPq');
      expect(message).not.toContain('hong@example.com');
    }
    expect(logs.some((m) => m.includes('h***@example.com'))).toBe(true);
  });
});
