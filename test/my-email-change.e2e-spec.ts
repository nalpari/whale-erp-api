import { randomBytes, randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { hashPassword } from '../src/auth/password';
import * as mailService from '../src/mail/mail.service';
import { EmailChangePinSender } from '../src/my-profile/email-change-pin-sender';
import { PrismaService } from '../src/prisma/prisma.service';

// 직원 앱 이메일 아이디 변경(WHALEERP-191)을 실제 DB 로 확인한다 — 새 이메일로 보낸 핀을 맞혀야만 바뀌고, 바꾼 뒤 새
// 이메일로 로그인되고 옛 이메일은 안 된다. 중복 409, 지금 이메일 400, 틀린 핀 · 5회 · 만료 · 대체된 핀 400, 1분 간격 429,
// 관리자 토큰 403, 탈퇴 401, 핀 원문은 DB 에 없다. 발송기는 받은 핀을 모아 두는 가짜로 갈아 끼운다.
describe('이메일 아이디 변경 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const PASSWORD = 'OldPass123!';
  const sent: { to: string; pin: string }[] = [];
  /** 'smtp' 면 SMTP 단계 실패, 'blocked' 면 보내기 전 실패(템플릿 꺼짐 등)처럼 가짜 발송기가 던진다 */
  let failSend: 'smtp' | 'blocked' | null = null;
  const smtpFailure = new Error('smtp down');

  let bpCodeId: number;
  let bmId: number;
  let otherEmail: string;
  let withdrawnId: number;
  const accountIds: number[] = [];
  const n = randomInt(100_000, 999_999);

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailChangePinSender)
      .useValue({
        isAvailable: () => true,
        send: (to: string, pin: string) => {
          if (failSend === 'smtp') return Promise.reject(smtpFailure);
          if (failSend === 'blocked')
            return Promise.reject(new Error('template off'));
          sent.push({ to, pin });
          return Promise.resolve();
        },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '이메일 변경 BP',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: bmId } = await prisma.adminAccount.create({
      data: {
        loginId: `mail${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    const hash = await hashPassword(PASSWORD);
    otherEmail = (
      await prisma.account.findUniqueOrThrow({
        where: { accountId: await account('other', 'JOINED', hash) },
      })
    ).email;
    withdrawnId = await account('gone', 'WITHDRAWN', hash);
  });

  async function account(
    tag: string,
    status: 'JOINED' | 'WITHDRAWN',
    passwordHash: string,
  ) {
    const m = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `${tag}-${m}@test.invalid`,
        passwordHash,
        realName: tag,
        birthDate: new Date('1998-03-04'),
        phone: `010${m}`,
        status,
      },
    });
    accountIds.push(accountId);
    return accountId;
  }

  afterAll(async () => {
    if (!prisma) return;
    const where = { accountId: { in: accountIds } };
    await prisma.emailChangePin.deleteMany({ where });
    await prisma.passwordResetPin.deleteMany({ where });
    await prisma.passwordResetLink.deleteMany({ where });
    await prisma.accountChangeHistory.deleteMany({ where });
    await prisma.loginHistory.deleteMany({ where });
    await prisma.authSession.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    if (bmId !== undefined) {
      await prisma.adminSession.deleteMany({ where: { adminAccountId: bmId } });
      await prisma.adminAccount.deleteMany({ where: { adminAccountId: bmId } });
    }
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  const tokenOf = async (accountId: number) => {
    const session = await app.get(AuthSessionService).issue({
      accountId,
      deviceIdentifier: `mail-e2e-${accountId}`,
    });
    return app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  };
  const adminToken = async () =>
    (
      await app
        .get(AdminSessionService)
        .issue({ adminAccountId: bmId }, (sid) =>
          app.get(JwtService).signAsync({
            sub: bmId,
            type: 'admin',
            loginId: `admin${bmId}`,
            typ: 'access',
            sid,
          }),
        )
    ).accessToken;
  const post = (path: string, token: string | undefined, body: object) => {
    const req = request(app.getHttpServer()).post(path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };
  const requestPin = (
    token: string,
    newEmail: string,
    currentPassword = PASSWORD,
  ) =>
    post('/me/profile/email-change-pins', token, { newEmail, currentPassword });
  const change = (token: string, pin: string) =>
    post('/me/profile/email-change', token, { pin });
  const message = (res: { body: unknown }) =>
    (res.body as { message: string }).message;
  /** 1분 재발급 간격을 기다리지 않도록 그 계정의 핀 발급 시각을 2분 앞으로 민다 */
  const ageLatestPin = (accountId: number) =>
    prisma.$executeRaw`UPDATE email_change_pins SET issued_at = issued_at - interval '2 minutes' WHERE account_id = ${accountId}`;
  const emailOf = async (accountId: number) =>
    (await prisma.account.findUniqueOrThrow({ where: { accountId } })).email;
  /** 테스트마다 새 계정 — 1분 간격 · 계정 요청 한도 · 핀 개수가 앞 테스트에 기대지 않게 */
  const fresh = async (tag: string) => {
    const accountId = await account(
      tag,
      'JOINED',
      await hashPassword(PASSWORD),
    );
    return { accountId, token: await tokenOf(accountId) };
  };
  /** 그 계정 주소로 마지막에 나간 핀 */
  const lastPinTo = (email: string) =>
    [...sent].reverse().find((m) => m.to === email)!.pin;
  const wrongOf = (pin: string) => (pin === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ');

  it('토큰이 없으면 401, 관리자 토큰은 403, 탈퇴 계정은 401', async () => {
    const admin = await adminToken();
    const gone = await tokenOf(withdrawnId);
    const before = sent.length;
    for (const [path, body] of [
      [
        '/me/profile/email-change-pins',
        { newEmail: `x-${n}@test.invalid`, currentPassword: PASSWORD },
      ],
      ['/me/profile/email-change', { pin: 'A7K2Q9' }],
    ] as const) {
      await post(path, undefined, body).expect(401);
      await post(path, admin, body).expect(403);
      await post(path, gone, body).expect(401);
    }
    expect(sent).toHaveLength(before);
  });

  it('다른 계정의 이메일은 409, 지금 이메일은 400, 형식이 틀리면 400 — 보내지 않는다', async () => {
    const { accountId, token } = await fresh('dup');
    const before = sent.length;
    const dup = await requestPin(token, otherEmail.toUpperCase()).expect(409);
    expect(message(dup)).toBe('이미 쓰고 있는 이메일입니다.');
    await requestPin(token, await emailOf(accountId)).expect(400);
    await requestPin(token, 'not-an-email').expect(400);
    // @IsEmail 은 받지만 메일 발송이 막는 주소 — 받으면 핀이 지워지고 「메일 설정 문제」 500 이 됐다
    const quoted = await requestPin(token, '"a"@example.com').expect(400);
    expect(JSON.stringify(quoted.body)).toContain(
      '메일을 보낼 수 없는 형식의 이메일입니다.',
    );
    expect(await prisma.emailChangePin.count({ where: { accountId } })).toBe(0);
    expect(sent).toHaveLength(before);
  });

  it('지금 비밀번호가 틀리거나 빠지면 400 — 보내지 않고, 다른 계정이 쓰는 주소인지도 알리지 않고, 로그인 잠금 횟수도 세지 않는다', async () => {
    const { accountId, token } = await fresh('pw');
    const before = sent.length;
    const wrong = await requestPin(
      token,
      `pw-${n}@test.invalid`,
      'Wrong1!!',
    ).expect(400);
    expect(message(wrong)).toBe('지금 비밀번호가 맞지 않습니다.');
    // 비밀번호 없이는 409 로 주소가 쓰이는지 알 수 없다
    const dup = await requestPin(token, otherEmail, 'Wrong1!!').expect(400);
    expect(message(dup)).toBe('지금 비밀번호가 맞지 않습니다.');
    await post('/me/profile/email-change-pins', token, {
      newEmail: `pw-${n}@test.invalid`,
    }).expect(400);
    expect(await prisma.emailChangePin.count({ where: { accountId } })).toBe(0);
    expect(sent).toHaveLength(before);
    const { failedLoginCount } = await prisma.account.findUniqueOrThrow({
      where: { accountId },
    });
    expect(failedLoginCount).toBe(0);
    // 맞는 비밀번호면 그대로 보낸다
    await requestPin(token, `pw-${n}@test.invalid`).expect(204);
    expect(sent).toHaveLength(before + 1);
  });

  it('핀을 받은 뒤 비밀번호를 바꾸면 그 핀은 닫힌다 — 핀은 옛 비밀번호로 낸 것이다 (WHALEERP-607)', async () => {
    const { accountId, token } = await fresh('pwchanged');
    const before = await emailOf(accountId);
    const target = `pwchanged-${n}@test.invalid`;
    await requestPin(token, target).expect(204);
    const pin = lastPinTo(target);
    await post('/me/profile/password-change', token, {
      currentPassword: PASSWORD,
      newPassword: 'NewPass456!',
    }).expect(204);
    const res = await change(token, pin).expect(400);
    expect(message(res)).toBe('핀이 올바르지 않거나 만료되었습니다.');
    expect(await emailOf(accountId)).toBe(before);
  });

  it('받은 핀이 없으면 변경은 400', async () => {
    const { token } = await fresh('nopin');
    await change(token, 'A7K2Q9').expect(400);
  });

  it('틀린 핀 5번이면 그 핀은 닫혀 맞는 핀도 400 — 이메일은 그대로, 핀 원문은 DB 에 없다', async () => {
    const { accountId, token } = await fresh('five');
    const before = await emailOf(accountId);
    const target = `five-${n}@test.invalid`;
    await requestPin(token, target).expect(204);
    const pin = lastPinTo(target);
    for (let i = 0; i < 5; i += 1) {
      const res = await change(token, wrongOf(pin)).expect(400);
      expect(message(res)).toBe('핀이 올바르지 않거나 만료되었습니다.');
    }
    await change(token, pin).expect(400);
    expect(await emailOf(accountId)).toBe(before);
    const rows = await prisma.emailChangePin.findMany({ where: { accountId } });
    expect(rows.map((r) => r.attemptCount)).toEqual([5]);
    expect(rows[0].pinHash).not.toContain(pin);
  });

  it('틀린 핀이 동시에 몰려도 5회에서 닫힌다 — 500 없이 모두 400, 그 뒤 맞는 핀도 400', async () => {
    const { accountId, token } = await fresh('race');
    const before = await emailOf(accountId);
    const target = `race-${n}@test.invalid`;
    await requestPin(token, target).expect(204);
    const pin = lastPinTo(target);
    // 계정 요청 한도(10) 안에서 — 8번 동시에 틀리고 한 번 맞힌다
    const results = await Promise.all(
      Array.from({ length: 8 }, () => change(token, wrongOf(pin))),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(400));
    const [row] = await prisma.emailChangePin.findMany({
      where: { accountId },
    });
    expect(row.attemptCount).toBe(5);
    await change(token, pin).expect(400);
    expect(await emailOf(accountId)).toBe(before);
  });

  it('SMTP 가 실패하면 503 이고 그 핀은 남지 않는다 — 1분을 기다리지 않고 바로 다시 받는다', async () => {
    const { accountId, token } = await fresh('down');
    // MailService 가 SMTP 단계 예외에 붙이는 표시를 흉내 낸다
    const spy = jest
      .spyOn(mailService, 'isMailTransportError')
      .mockImplementation((e) => e === smtpFailure);
    failSend = 'smtp';
    try {
      await requestPin(token, `down-${n}@test.invalid`).expect(503);
    } finally {
      failSend = null;
      spy.mockRestore();
    }
    expect(await prisma.emailChangePin.count({ where: { accountId } })).toBe(0);
    await requestPin(token, `up-${n}@test.invalid`).expect(204);
  });

  it('보내기 전에 막히면(템플릿 꺼짐 등) 500 — 「잠시 뒤에 다시」가 아니다. 핀은 남지 않는다', async () => {
    const { accountId, token } = await fresh('blocked');
    failSend = 'blocked';
    try {
      const res = await requestPin(token, `blocked-${n}@test.invalid`).expect(
        500,
      );
      expect(message(res)).toBe(
        '메일 설정 문제로 인증 메일을 보내지 못했습니다. 관리자에게 문의해 주세요.',
      );
    } finally {
      failSend = null;
    }
    expect(await prisma.emailChangePin.count({ where: { accountId } })).toBe(0);
  });

  it('핀 요청을 동시에 두 번 눌러도 핀은 하나, 메일도 한 통 — 다른 쪽은 429', async () => {
    const { accountId, token } = await fresh('twice');
    const target = `twice-${n}@test.invalid`;
    const before = sent.filter((m) => m.to === target).length;
    const results = await Promise.all([
      requestPin(token, target),
      requestPin(token, target),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 429]);
    expect(await prisma.emailChangePin.count({ where: { accountId } })).toBe(1);
    expect(sent.filter((m) => m.to === target).length).toBe(before + 1);
  });

  it('1분 안에 다시 요청하면 429', async () => {
    const { token } = await fresh('again');
    await requestPin(token, `again1-${n}@test.invalid`).expect(204);
    await requestPin(token, `again2-${n}@test.invalid`).expect(429);
  });

  it('만료된 핀은 맞아도 400', async () => {
    const { accountId, token } = await fresh('late');
    const target = `late-${n}@test.invalid`;
    await requestPin(token, target).expect(204);
    await prisma.$executeRaw`UPDATE email_change_pins SET issued_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' WHERE account_id = ${accountId}`;
    await change(token, lastPinTo(target)).expect(400);
  });

  it('새 핀을 받으면 앞의 핀은 무효 — 새 핀으로 바꾸면 새 이메일로 로그인되고 옛 이메일은 안 된다. 접속은 이어진다', async () => {
    const { accountId, token } = await fresh('swap');
    const oldEmail = await emailOf(accountId);
    const staleTo = `stale-${n}@test.invalid`;
    const newEmail = `changed-${n}@test.invalid`;

    await requestPin(token, staleTo).expect(204);
    const stale = lastPinTo(staleTo);
    await ageLatestPin(accountId);
    await requestPin(token, newEmail.toUpperCase()).expect(204);
    const freshPin = lastPinTo(newEmail);
    // 앞선 핀은 새 핀 메일이 나간 뒤 닫혔다 — 같은 글자가 나와도 성립하도록 DB 로 본다
    expect(
      await prisma.emailChangePin.count({
        where: { accountId, newEmail: staleTo, usedAt: null },
      }),
    ).toBe(0);
    if (stale !== freshPin) await change(token, stale).expect(400);

    // 옛 주소로 나간 비밀번호 재설정 핀 하나와 관리자 재설정 링크 하나 — 이메일을 바꾸면 둘 다 닫혀야 한다. 남기면 옛
    // 수신함을 가진 사람이 그것으로 비밀번호를 바꿀 수 있다.
    await prisma.passwordResetPin.create({
      data: {
        accountId,
        pinHash: '!',
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    await prisma.passwordResetLink.create({
      data: {
        accountId,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        requestedBy: bmId,
      },
    });
    await change(token, ` ${freshPin.toLowerCase()} `).expect(204);
    expect(
      await prisma.passwordResetPin.count({
        where: { accountId, usedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma.passwordResetLink.count({
        where: { accountId, closedAt: null },
      }),
    ).toBe(0);
    expect(await emailOf(accountId)).toBe(newEmail);
    const history = await prisma.accountChangeHistory.findMany({
      where: { accountId, field: 'EMAIL' },
    });
    expect(history).toEqual([
      expect.objectContaining({
        channel: 'SELF',
        beforeValue: oldEmail,
        afterValue: newEmail,
      }),
    ]);
    // 쓴 핀은 닫혀 다시 쓸 수 없다
    await change(token, freshPin).expect(400);
    // 지금 접속은 이어진다
    await request(app.getHttpServer())
      .get('/me/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const login = (email: string) =>
      post('/auth/account/login', undefined, {
        email,
        password: PASSWORD,
        deviceIdentifier: `mail-login-${n}`,
      });
    await login(newEmail).expect(200);
    await login(oldEmail).expect(401);
  });

  it('두 계정이 같은 새 이메일을 동시에 확인하면 하나만 바뀐다 — 다른 쪽은 409, 500 이 없다', async () => {
    const a = await fresh('paira');
    const b = await fresh('pairb');
    const target = `pair-${n}@test.invalid`;
    await requestPin(a.token, target).expect(204);
    const pinA = lastPinTo(target);
    await requestPin(b.token, target).expect(204);
    const pinB = lastPinTo(target);
    const results = await Promise.all([
      change(a.token, pinA),
      change(b.token, pinB),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    const emails = [await emailOf(a.accountId), await emailOf(b.accountId)];
    expect(emails.filter((e) => e === target)).toHaveLength(1);
  });
});
