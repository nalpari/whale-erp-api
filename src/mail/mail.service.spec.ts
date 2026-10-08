import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_CONFIG } from './mail.config';
import { MAIL_TRANSPORT, MailService } from './mail.service';
import { MASK } from '../notification-templates/render-template';

describe('MailService', () => {
  let service: MailService;
  let transport: { sendMail: jest.Mock };
  let prisma: {
    notificationTemplate: { findUnique: jest.Mock };
    mailSendLog: { create: jest.Mock };
  };
  let logs: string[];

  // 기본 템플릿 마이그레이션(20261007000200)의 EMAIL_TEMP_PASSWORD 행 그대로 — 본문은
  // 일반 글이고 링크는 본문에 자리 없이 버튼 링크 변수로 온다.
  const template = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    channel: 'EMAIL',
    isActive: true,
    title: '[WHALE ERP] 임시 비밀번호를 보내 드립니다',
    body: '#{관리자이름} 님이 요청하신 임시 비밀번호입니다.\n\n임시 비밀번호: #{임시비밀번호}\n\n1시간 동안 쓸 수 있습니다. 요청하지 않았다면 바로 관리자에게 알려 주세요.',
    variables: [
      {
        name: '관리자이름',
        label: '관리자 이름',
        isRequired: true,
        sampleValue: '이서준',
      },
      {
        name: '임시비밀번호',
        label: '임시 비밀번호',
        isRequired: true,
        sampleValue: 'x8Rk-2mPq',
      },
      {
        name: '링크',
        label: '바로가기 링크(공통 틀이 버튼으로 붙임)',
        isRequired: true,
        sampleValue: 'https://…',
        isButtonLink: true,
      },
    ],
  };
  const link = 'https://erp.whale.test/login?token=t0ken&next=1';
  const input = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    to: 'hong@example.com',
    variables: { 관리자이름: '이서준', 임시비밀번호: 'x8Rk-2mPq', 링크: link },
    maskedVariables: ['임시비밀번호'],
    adminAccountId: 12,
    sentBy: 3,
  };
  const sentText =
    '이서준 님이 요청하신 임시 비밀번호입니다.\n\n임시 비밀번호: x8Rk-2mPq\n\n1시간 동안 쓸 수 있습니다. 요청하지 않았다면 바로 관리자에게 알려 주세요.';

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

  /** 보낸 메일 한 통 */
  const sent = () =>
    (
      transport.sendMail.mock.calls[0] as [
        { subject: string; html: string; text: string },
      ]
    )[0];

  it('템플릿 코드로 조회해 보내고 messageId 를 돌려준다', async () => {
    await expect(service.send(input)).resolves.toEqual({
      messageId: '<abc@gmail.com>',
    });

    expect(prisma.notificationTemplate.findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'EMAIL_TEMP_PASSWORD' },
    });
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { name: 'WHALE ERP', address: 'noreply@whale.test' },
        to: 'hong@example.com',
        subject: '[WHALE ERP] 임시 비밀번호를 보내 드립니다',
      }),
    );
  });

  it('일반 글 본문을 공통 틀에 넣어 줄바꿈을 살리고 버튼 링크를 버튼으로 붙인다', async () => {
    await service.send(input);

    const { html } = sent();
    expect(html).toContain(
      '이서준 님이 요청하신 임시 비밀번호입니다.<br><br>임시 비밀번호: x8Rk-2mPq<br><br>1시간 동안',
    );
    expect(html).toContain(
      'href="https://erp.whale.test/login?token=t0ken&amp;next=1"',
    );
    expect(html).toContain('>바로가기</a>');
    expect(html).toContain('WHALE ERP');
  });

  it('text 파트는 본문 뒤에 링크를 붙인다', async () => {
    await service.send(input);

    expect(sent().text).toBe(`${sentText}\n\n${link}`);
  });

  it('버튼 링크가 없는 템플릿은 버튼 없이 보낸다', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      ...template,
      variables: template.variables.filter((v) => !v.isButtonLink),
    });

    await service.send({
      ...input,
      variables: { 관리자이름: '이서준', 임시비밀번호: 'x8Rk-2mPq' },
    });

    expect(sent().html).not.toContain('<a ');
    expect(sent().text).toBe(sentText);
  });

  it('성공하면 가린 본문(일반 글)으로 SUCCEEDED 이력을 남긴다', async () => {
    await service.send(input);

    expect(prisma.mailSendLog.create).toHaveBeenCalledWith({
      data: {
        mailTypeCode: 'EMAIL_TEMP_PASSWORD',
        adminAccountId: 12,
        fromEmail: 'noreply@whale.test',
        toEmail: 'hong@example.com',
        subject: '[WHALE ERP] 임시 비밀번호를 보내 드립니다',
        body: sentText.replace('x8Rk-2mPq', MASK),
        result: 'SUCCEEDED',
        failureReason: null,
        sentBy: 3,
      },
    });
  });

  it('maskedVariables 에 링크를 적지 않아도 이력에 링크 토큰이 남지 않는다', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      ...template,
      body: `${template.body}\n#{링크}`,
    });

    await service.send({ ...input, maskedVariables: [] });

    expect(sent().text).toContain('t0ken');
    expect(logged().body).not.toContain('t0ken');
    expect(logged().body).toContain(MASK);
  });

  it('템플릿 글과 값을 모두 HTML 이스케이프한다', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      ...template,
      body: '<b>안내</b> #{관리자이름} 님 #{임시비밀번호}',
    });

    await service.send({
      ...input,
      variables: { ...input.variables, 관리자이름: `<i>"O'Neil" & co</i>` },
    });

    expect(sent().html).toContain(
      '&lt;b&gt;안내&lt;/b&gt; &lt;i&gt;&quot;O&#39;Neil&quot; &amp; co&lt;/i&gt; 님 x8Rk-2mPq',
    );
    expect(sent().text).toContain(`<b>안내</b> <i>"O'Neil" & co</i> 님`);
  });

  it('링크의 따옴표가 href 속성을 깨지 못한다', async () => {
    await service.send({
      ...input,
      variables: {
        ...input.variables,
        링크: 'https://x.test/" onclick="alert(1)',
      },
    });

    expect(sent().html).toContain(
      'href="https://x.test/&quot; onclick=&quot;alert(1)"',
    );
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    '//evil.test',
    'erp.whale.test',
  ])(
    'http(s) 가 아닌 링크(%s)는 보내지도 기록하지도 않고 던진다',
    async (bad) => {
      await expect(
        service.send({
          ...input,
          variables: { ...input.variables, 링크: bad },
        }),
      ).rejects.toThrow('http');
      expect(transport.sendMail).not.toHaveBeenCalled();
      expect(prisma.mailSendLog.create).not.toHaveBeenCalled();
    },
  );

  it('HTTPS 대문자 스킴도 받는다', async () => {
    await service.send({
      ...input,
      variables: { ...input.variables, 링크: 'HTTPS://erp.whale.test' },
    });

    expect(transport.sendMail).toHaveBeenCalled();
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
      body: sentText.replace('x8Rk-2mPq', MASK),
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

  it('Error 가 아닌 값이 던져져도 그 값을 다시 던지고 FAILED 이력을 남긴다', async () => {
    transport.sendMail.mockRejectedValue(null);

    await expect(service.send(input)).rejects.toBeNull();
    expect(logged()).toMatchObject({
      result: 'FAILED',
      failureReason: 'code=undefined response=undefined: null',
    });
  });

  it('이력 INSERT 가 Error 아닌 값으로 실패해도 던지지 않는다', async () => {
    prisma.mailSendLog.create.mockRejectedValue(undefined);

    await expect(service.send(input)).resolves.toEqual({
      messageId: '<abc@gmail.com>',
    });
    expect(logs.some((m) => m.includes('mail_send_logs INSERT FAILED'))).toBe(
      true,
    );
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
      service.send({
        ...input,
        variables: { 관리자이름: '이서준', 링크: link },
      }),
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

  it.each([
    ['adminAccountId 가 0', { adminAccountId: 0 }, 'adminAccountId'],
    ['adminAccountId 가 소수', { adminAccountId: 1.5 }, 'adminAccountId'],
    ['sentBy 가 정수 범위 밖', { sentBy: 2_147_483_648 }, 'sentBy'],
  ])(
    '%s 이면 이력을 남길 수 없으므로 보내지 않고 던진다',
    async (_, extra, name) => {
      await expect(service.send({ ...input, ...extra })).rejects.toThrow(name);
      expect(transport.sendMail).not.toHaveBeenCalled();
      expect(prisma.mailSendLog.create).not.toHaveBeenCalled();
    },
  );

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
