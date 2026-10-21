import {
  createEmailChangePinSender,
  MailEmailChangePinSender,
  NoopEmailChangePinSender,
} from './email-change-pin-sender';

describe('EmailChangePinSender', () => {
  it('EMAIL_CHANGE_PIN 템플릿으로 새 이메일에 보내고, 핀은 발송 이력에서 가린다', async () => {
    const send = jest.fn().mockResolvedValue({ messageId: 'm' });
    await new MailEmailChangePinSender({ send }).send(
      'new@example.com',
      'A7K2Q9',
    );
    expect(send).toHaveBeenCalledWith({
      templateCode: 'EMAIL_CHANGE_PIN',
      to: 'new@example.com',
      variables: { 핀: 'A7K2Q9' },
      maskedVariables: ['핀'],
    });
  });

  it('메일 서비스가 던지면 같은 오류 객체를 그대로 던진다 — 감싸면 SMTP 표시가 사라져 503 이 500 이 된다', async () => {
    const failure = new Error('smtp down');
    const send = jest.fn().mockRejectedValue(failure);
    await expect(
      new MailEmailChangePinSender({ send }).send('new@example.com', 'A7K2Q9'),
    ).rejects.toBe(failure);
  });

  it('MAIL_* 가 있으면 메일로 보내는 발송기다', () => {
    const env: Record<string, string> = {
      MAIL_USERNAME: 'noreply@whale.test',
      MAIL_PASSWORD: 'pw',
    };
    const sender = createEmailChangePinSender(
      { get: (key: string) => env[key] },
      {} as never,
    );
    expect(sender).toBeInstanceOf(MailEmailChangePinSender);
    expect(sender.isAvailable()).toBe(true);
  });

  it('MAIL_* 가 없으면 쓸 수 없는 발송기다 — 요청은 503', () => {
    const sender = createEmailChangePinSender(
      { get: () => undefined },
      {} as never,
    );
    expect(sender).toBeInstanceOf(NoopEmailChangePinSender);
    expect(sender.isAvailable()).toBe(false);
  });
});
