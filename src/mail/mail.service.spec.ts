import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import { MAIL_CONFIG } from './mail.config';
import { MAIL_TRANSPORT, MailService } from './mail.service';

describe('MailService', () => {
  let service: MailService;
  let transport: { sendMail: jest.Mock };
  let render: jest.Mock;
  let logLog: jest.SpyInstance;
  let logWarn: jest.SpyInstance;

  beforeEach(async () => {
    logLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    logWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    transport = {
      sendMail: jest.fn().mockResolvedValue({ messageId: '<m-1@example.com>' }),
    };
    render = jest.fn().mockResolvedValue({
      title: '[강남점] 임시 비밀번호 안내',
      body: '홍길동님의 임시 비밀번호는 pw-secret 입니다.',
    });
    const module = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: MAIL_TRANSPORT, useValue: transport },
        { provide: MAIL_CONFIG, useValue: { username: 'noreply@example.com' } },
        { provide: NotificationTemplatesService, useValue: { render } },
      ],
    }).compile();
    service = module.get(MailService);
    logLog.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  const vars = { storeName: '강남점', name: '홍길동', password: 'pw-secret' };
  const sent = () =>
    (transport.sendMail.mock.calls[0] as [Record<string, unknown>])[0];

  it('EMAIL 템플릿을 채워 로그인한 계정 이름으로 텍스트 메일을 보낸다', async () => {
    await service.send('EMAIL_TEMP_PASSWORD', 'hong@example.com', vars);

    expect(render).toHaveBeenCalledWith('EMAIL_TEMP_PASSWORD', 'EMAIL', vars);
    expect(sent()).toEqual({
      // Gmail 은 보낸 사람 주소를 로그인한 계정으로 바꿔 쓰므로 그 주소를 쓴다.
      from: { name: 'Whale ERP', address: 'noreply@example.com' },
      to: 'hong@example.com',
      subject: '[강남점] 임시 비밀번호 안내',
      text: '홍길동님의 임시 비밀번호는 pw-secret 입니다.',
    });
  });

  it('점·더하기가 든 주소도 받는다', async () => {
    await service.send(
      'EMAIL_TEMP_PASSWORD',
      'first.last+tag@mail.example.co.kr',
      vars,
    );

    expect(sent().to).toBe('first.last+tag@mail.example.co.kr');
  });

  it('messageId 를 돌려준다', async () => {
    await expect(
      service.send('EMAIL_TEMP_PASSWORD', 'hong@example.com', vars),
    ).resolves.toEqual({ messageId: '<m-1@example.com>' });
  });

  it('템플릿을 채우지 못하면 보내지 않고 그 오류를 던진다', async () => {
    const error = new Error('템플릿 NOPE: 템플릿이 없습니다');
    render.mockRejectedValue(error);

    await expect(service.send('NOPE', 'hong@example.com', vars)).rejects.toBe(
      error,
    );
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'hong',
    'hong@example',
    'a@b.com,c@d.com',
    'a,c@d.com',
    'Hong <hong@example.com>',
    'x:y@example.com',
    'a(b)@example.com',
  ])('메일 주소 하나가 아니면(%s) 템플릿을 읽지도 않고 던진다', async (to) => {
    // 쉼표가 들어가면 nodemailer 가 받는 사람을 여럿으로 나누고, 꺾쇠는 앞을 표시
    // 이름으로 읽고, 콜론·괄호는 그룹·주석 문법이라 검사한 주소와 받는 주소가 달라진다.
    const error = await service
      .send('EMAIL_TEMP_PASSWORD', to, vars)
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('메일 주소가 아닙니다');
    // 오류 메시지는 예외 필터 로그로 나갈 수 있어 주소를 가린다.
    if (to.includes('@')) expect((error as Error).message).not.toContain(to);
    expect(render).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('보내면 주소를 가리고 본문은 남기지 않은 채 로그한다', async () => {
    await service.send('EMAIL_TEMP_PASSWORD', 'hong@example.com', vars);

    expect(logLog).toHaveBeenCalledTimes(1);
    const [line] = logLog.mock.calls[0] as [string];
    expect(line).toContain('EMAIL_TEMP_PASSWORD');
    expect(line).toContain('<m-1@example.com>');
    expect(line).toContain('h***@example.com');
    expect(line).not.toContain('hong@');
    expect(line).not.toContain('pw-secret');
  });

  it('SMTP 오류는 코드를 남기고 그대로 던진다', async () => {
    const error = Object.assign(new Error('Invalid login'), {
      code: 'EAUTH',
      responseCode: 535,
    });
    transport.sendMail.mockRejectedValue(error);

    await expect(
      service.send('EMAIL_TEMP_PASSWORD', 'hong@example.com', vars),
    ).rejects.toBe(error);
    const [line] = logWarn.mock.calls[0] as [string];
    expect(line).toContain('code=EAUTH');
    expect(line).toContain('response=535');
    expect(line).toContain('Invalid login');
    expect(line).toContain('h***@example.com');
    expect(line).not.toContain('pw-secret');
  });
});
