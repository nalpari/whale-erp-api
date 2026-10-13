import { MailPasswordResetLinkSender } from './mail-password-reset-link.sender';

describe('MailPasswordResetLinkSender', () => {
  const target = {
    accountId: 7,
    email: 'staff@example.com',
    realName: '홍길동',
  };
  const content = {
    storeName: '연남점',
    link: 'https://staff.test/password-reset/link#token=SECRET',
    expiresAt: new Date('2026-10-14T03:00:00Z'),
    requestedBy: 31,
  };

  it('쓸 수 있다', () => {
    const sender = new MailPasswordResetLinkSender({ send: jest.fn() });
    expect(sender.isAvailable()).toBe(true);
  });

  it('EMAIL_STAFF_RESET_LINK 템플릿에 근무지 · 링크를 채워 직원 메일로 보내고, 보낸 관리자를 남긴다', async () => {
    const mail = { send: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
    await new MailPasswordResetLinkSender(mail).send(target, content);
    expect(mail.send).toHaveBeenCalledWith({
      templateCode: 'EMAIL_STAFF_RESET_LINK',
      to: 'staff@example.com',
      variables: { 근무지: '연남점', 링크: content.link },
      sentBy: 31,
    });
  });

  it('메일 서비스가 던지면 그대로 던진다 — 서비스가 링크를 지우고 503 을 준다', async () => {
    const mail = { send: jest.fn().mockRejectedValue(new Error('smtp down')) };
    await expect(
      new MailPasswordResetLinkSender(mail).send(target, content),
    ).rejects.toThrow('smtp down');
  });
});
