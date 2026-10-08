import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AccountStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { LoginResponseDto } from '../src/auth/dto/login.response.dto';
import { hashPassword } from '../src/auth/password';
import {
  PasswordResetPinSender,
  PasswordResetPinTarget,
} from '../src/auth/password-reset-pin-sender';
import { PrismaService } from '../src/prisma/prisma.service';

const OLD_PASSWORD = 'old-Password-1';
const NEW_PASSWORD = 'Brand-new-pw1';
const MINUTE = 60 * 1000;

/** 메일 대신 받은 핀을 모아 둔다. 진짜 발송 기반(WHALEERP-320)이 없어도 흐름 전체를 돌려 볼 수 있다. */
class CapturingSender extends PasswordResetPinSender {
  readonly sent: { email: string; pin: string; expiresAt: Date }[] = [];
  isAvailable() {
    return true;
  }
  send(target: PasswordResetPinTarget, pin: string, expiresAt: Date) {
    this.sent.push({ email: target.email, pin, expiresAt });
    return Promise.resolve();
  }
}

// 비밀번호 재설정(WHALEERP-169 · 170 · 171)을 실제 DB 로 확인한다. 요청 제한 가드는 끈다 —
// 켜 두면 한 이메일에 여러 번 보내는 이 테스트가 제한의 429 를 받는다(throttle.spec 이 따로 다룬다).
describe('비밀번호 재설정 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const sender = new CapturingSender();
  const createdAccountIds: number[] = [];
  const attemptedEmails: string[] = [];
  let oldPasswordHash: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PasswordResetPinSender)
      .useValue(sender)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    oldPasswordHash = await hashPassword(OLD_PASSWORD);
  });

  afterAll(async () => {
    // 이 파일이 만든 행만 지운다. 외래키가 RESTRICT 라 자식부터 지운다.
    const byAccount = { accountId: { in: createdAccountIds } };
    await prisma.passwordResetPin.deleteMany({ where: byAccount });
    await prisma.accountChangeHistory.deleteMany({ where: byAccount });
    await prisma.authSession.deleteMany({ where: byAccount });
    await prisma.loginHistory.deleteMany({
      where: { OR: [byAccount, { email: { in: attemptedEmails } }] },
    });
    await prisma.account.deleteMany({ where: byAccount });
    await app.close();
  });

  async function createAccount(status: AccountStatus = 'JOINED') {
    const email = `${randomUUID()}@test.invalid`;
    attemptedEmails.push(email);
    const account = await prisma.account.create({
      data: {
        email,
        passwordHash: oldPasswordHash,
        realName: '홍길동',
        birthDate: new Date('1990-01-01'),
        phone: '01012345678',
        status,
      },
    });
    createdAccountIds.push(account.accountId);
    return account;
  }

  const api = () => request(app.getHttpServer());
  const requestPin = (email: string) =>
    api().post('/auth/account/password-reset-pins').send({ email });
  const verifyPin = (email: string, pin: string) =>
    api().post('/auth/account/password-reset-pins/verify').send({ email, pin });
  const resetPassword = (email: string, pin: string, newPassword: string) =>
    api()
      .post('/auth/account/password-reset')
      .send({ email, pin, newPassword });
  const login = (email: string, password: string) =>
    api().post('/auth/account/login').send({ email, password });
  const messageOf = (res: { body: unknown }) =>
    (res.body as { message: string }).message;

  /** 가장 최근에 받은 핀 */
  const pinOf = (email: string) => {
    const mine = sender.sent.filter((s) => s.email === email);
    return mine[mine.length - 1].pin;
  };
  const pinsOf = (accountId: number) =>
    prisma.passwordResetPin.findMany({
      where: { accountId },
      orderBy: { passwordResetPinId: 'asc' },
    });
  /** 직전 발급 간격(1분)을 건너뛰려고 발급 시각을 앞으로 당긴다. */
  const ageIssuance = (accountId: number, ms: number) =>
    prisma.$executeRaw`UPDATE password_reset_pins SET issued_at = issued_at - ${ms} * interval '1 millisecond' WHERE account_id = ${accountId}`;

  describe('핀 요청', () => {
    it('204 로 답하고 핀을 해시로만 저장하며 만료를 10분 뒤로 둔다', async () => {
      const account = await createAccount();

      const res = await requestPin(account.email);

      expect(res.status).toBe(204);
      const [row] = await pinsOf(account.accountId);
      const pin = pinOf(account.email);
      expect(pin).toMatch(/^[A-Z0-9]{6}$/);
      expect(row.pinHash).not.toBe(pin);
      expect(row.pinHash.startsWith('scrypt$')).toBe(true);
      expect(row.expiresAt.getTime() - row.issuedAt.getTime()).toBe(
        10 * MINUTE,
      );
      expect(row).toMatchObject({ attemptCount: 0, usedAt: null });
    });

    it('없는 이메일도 같은 204 이고 아무것도 저장하거나 보내지 않는다', async () => {
      const email = `${randomUUID()}@test.invalid`;
      const before = sender.sent.length;

      const res = await requestPin(email);

      expect(res.status).toBe(204);
      expect(sender.sent.length).toBe(before);
    });

    it('탈퇴한 계정은 없는 계정처럼 핀을 받지 못한다', async () => {
      const account = await createAccount('WITHDRAWN');

      const res = await requestPin(account.email);

      expect(res.status).toBe(204);
      expect(await pinsOf(account.accountId)).toHaveLength(0);
    });

    it('직전 발급 뒤 1분 안에 다시 눌러도 새 핀을 내지 않고 앞서 낸 핀이 유효하다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const first = pinOf(account.email);

      const again = await requestPin(account.email);

      expect(again.status).toBe(204);
      expect(await pinsOf(account.accountId)).toHaveLength(1);
      expect((await verifyPin(account.email, first)).status).toBe(204);
    });

    it('1분이 지나 새 핀을 내면 이전 핀은 바로 무효가 된다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const oldPin = pinOf(account.email);
      await ageIssuance(account.accountId, 2 * MINUTE);

      await requestPin(account.email);
      const newPin = pinOf(account.email);

      const rows = await pinsOf(account.accountId);
      expect(rows).toHaveLength(2);
      expect(rows[0].usedAt).not.toBeNull();
      expect(rows[1].usedAt).toBeNull();
      expect(newPin).not.toBe(oldPin);
      expect((await verifyPin(account.email, oldPin)).status).toBe(401);
      expect((await verifyPin(account.email, newPin)).status).toBe(204);
    });

    it('24시간 안에 10번 냈으면 더 내지 않는다', async () => {
      const account = await createAccount();
      const sentBefore = sender.sent.length;
      for (let i = 0; i < 10; i += 1)
        await prisma.passwordResetPin.create({
          data: {
            accountId: account.accountId,
            pinHash: 'scrypt$old',
            issuedAt: new Date(Date.now() - 5 * MINUTE - i * MINUTE),
            expiresAt: new Date(Date.now() - 1000),
            usedAt: new Date(),
          },
        });

      const res = await requestPin(account.email);

      expect(res.status).toBe(204);
      expect(await pinsOf(account.accountId)).toHaveLength(10);
      expect(sender.sent.length).toBe(sentBefore);
    });

    it('동시에 여러 번 눌러도 핀은 하나만 나가고 모두 204 다', async () => {
      const account = await createAccount();
      const sentBefore = sender.sent.length;

      const statuses = await Promise.all(
        Array.from({ length: 5 }, () =>
          requestPin(account.email).then((r) => r.status),
        ),
      );

      expect(statuses).toEqual(Array(5).fill(204));
      expect(await pinsOf(account.accountId)).toHaveLength(1);
      expect(sender.sent.length - sentBefore).toBe(1);
    });
  });

  describe('핀 확인', () => {
    it('맞는 핀이면 204 이고 소문자·앞뒤 공백도 받는다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const pin = pinOf(account.email);

      const res = await verifyPin(account.email, ` ${pin.toLowerCase()} `);

      expect(res.status).toBe(204);
      // 확인은 상태를 바꾸지 않는다.
      const [row] = await pinsOf(account.accountId);
      expect(row).toMatchObject({ attemptCount: 0, usedAt: null });
    });

    it('틀리면 401 이고 틀린 횟수가 하나 오른다', async () => {
      const account = await createAccount();
      await requestPin(account.email);

      const res = await verifyPin(account.email, 'WRONG1');

      expect(res.status).toBe(401);
      const [row] = await pinsOf(account.accountId);
      expect(row.attemptCount).toBe(1);
    });

    it('5번 틀리면 그 핀은 닫혀 맞는 값도 거부하고 더 세지 않는다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const pin = pinOf(account.email);
      for (let i = 0; i < 5; i += 1)
        expect((await verifyPin(account.email, 'WRONG1')).status).toBe(401);

      const rightButClosed = await verifyPin(account.email, pin);
      const sixth = await verifyPin(account.email, 'WRONG1');

      expect(rightButClosed.status).toBe(401);
      expect(sixth.status).toBe(401);
      const [row] = await pinsOf(account.accountId);
      expect(row.attemptCount).toBe(5);
    });

    // 목으로는 증명할 수 없는 것. 계정 행을 잠그지 않으면 동시에 들어온 틀린 시도가 모두 "아직
    // 5번 안 됨"을 읽고 횟수를 올려, 병렬로 보내는 것만으로 5회 제한을 넘는다(DB 제약 위반까지).
    it('틀린 시도를 동시에 여럿 보내도 횟수는 정확히 5 에서 멈추고 서버 오류가 나지 않는다', async () => {
      const account = await createAccount();
      await requestPin(account.email);

      const responses = await Promise.all(
        Array.from({ length: 9 }, () => verifyPin(account.email, 'WRONG1')),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(9).fill(401));
      const [row] = await pinsOf(account.accountId);
      expect(row.attemptCount).toBe(5);
    });

    it('만료된 핀은 맞는 값이어도 거부한다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const pin = pinOf(account.email);
      await prisma.passwordResetPin.updateMany({
        where: { accountId: account.accountId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await verifyPin(account.email, pin);

      expect(res.status).toBe(401);
    });

    it('틀림 · 만료 · 없는 계정을 구분하지 않고 같은 메시지로 거부한다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const wrong = await verifyPin(account.email, 'WRONG1');
      await prisma.passwordResetPin.updateMany({
        where: { accountId: account.accountId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await verifyPin(account.email, 'WRONG1');
      const unknown = await verifyPin(`${randomUUID()}@test.invalid`, 'WRONG1');

      expect(messageOf(expired)).toBe(messageOf(wrong));
      expect(messageOf(unknown)).toBe(messageOf(wrong));
    });
  });

  describe('새 비밀번호', () => {
    it('맞는 핀이면 비밀번호를 바꾸고 새 비밀번호로만 로그인된다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const pin = pinOf(account.email);

      const res = await resetPassword(account.email, pin, NEW_PASSWORD);

      expect(res.status).toBe(204);
      expect((await login(account.email, NEW_PASSWORD)).status).toBe(200);
      expect((await login(account.email, OLD_PASSWORD)).status).toBe(401);
    });

    it('같은 핀으로 동시에 두 번 바꾸면 하나만 성공하고 이력도 하나다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const pin = pinOf(account.email);

      const statuses = await Promise.all(
        [NEW_PASSWORD, 'Another-pw-2'].map((pw) =>
          resetPassword(account.email, pin, pw).then((r) => r.status),
        ),
      );

      expect([...statuses].sort()).toEqual([204, 401]);
      expect(
        await prisma.accountChangeHistory.count({
          where: { accountId: account.accountId },
        }),
      ).toBe(1);
    });

    it('핀을 소진한다 — 같은 핀으로 한 번 더 바꿀 수 없다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const pin = pinOf(account.email);
      await resetPassword(account.email, pin, NEW_PASSWORD);

      const again = await resetPassword(account.email, pin, 'Another-pw-2');

      expect(again.status).toBe(401);
      const [row] = await pinsOf(account.accountId);
      expect(row.usedAt).not.toBeNull();
      expect((await login(account.email, NEW_PASSWORD)).status).toBe(200);
    });

    it('모든 기기의 접속을 끊고, 끊긴 기기의 액세스 토큰도 즉시 거부된다', async () => {
      const account = await createAccount();
      const phone = (
        await api().post('/auth/account/login').send({
          email: account.email,
          password: OLD_PASSWORD,
          deviceIdentifier: 'phone',
        })
      ).body as LoginResponseDto;
      const tablet = (
        await api().post('/auth/account/login').send({
          email: account.email,
          password: OLD_PASSWORD,
          deviceIdentifier: 'tablet',
        })
      ).body as LoginResponseDto;
      await requestPin(account.email);

      await resetPassword(account.email, pinOf(account.email), NEW_PASSWORD);

      for (const { accessToken, refreshToken } of [phone, tablet]) {
        const logout = await api()
          .post('/auth/account/logout')
          .set('Authorization', `Bearer ${accessToken}`);
        const refresh = await api()
          .post('/auth/account/refresh')
          .send({ refreshToken });
        expect(logout.status).toBe(401);
        expect(refresh.status).toBe(401);
      }
    });

    it('로그인 실패 잠금과 실패 횟수를 함께 지운다 — 잠긴 채로 재설정할 수 있다', async () => {
      const account = await createAccount();
      await prisma.account.update({
        where: { accountId: account.accountId },
        data: {
          failedLoginCount: 5,
          lockExpiresAt: new Date(Date.now() + 5 * MINUTE),
        },
      });
      // 잠긴 동안에도 핀은 받을 수 있다.
      await requestPin(account.email);

      await resetPassword(account.email, pinOf(account.email), NEW_PASSWORD);

      const row = await prisma.account.findUniqueOrThrow({
        where: { accountId: account.accountId },
        select: { failedLoginCount: true, lockExpiresAt: true },
      });
      expect(row).toEqual({ failedLoginCount: 0, lockExpiresAt: null });
      expect((await login(account.email, NEW_PASSWORD)).status).toBe(200);
    });

    it('변경 이력에 본인 핀 재설정으로 남고 비밀번호 값은 남지 않는다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      await resetPassword(account.email, pinOf(account.email), NEW_PASSWORD);

      const [history] = await prisma.accountChangeHistory.findMany({
        where: { accountId: account.accountId },
      });

      expect(history).toMatchObject({
        field: 'PASSWORD',
        channel: 'PIN_RESET',
        beforeValue: null,
        afterValue: null,
        requestedBy: null,
      });
    });

    it('틀린 핀으로는 바꾸지 못하고 틀린 횟수만 오른다', async () => {
      const account = await createAccount();
      await requestPin(account.email);

      const res = await resetPassword(account.email, 'WRONG1', NEW_PASSWORD);

      expect(res.status).toBe(401);
      expect((await login(account.email, OLD_PASSWORD)).status).toBe(200);
      const [row] = await pinsOf(account.accountId);
      expect(row.attemptCount).toBe(1);
    });

    it('새 핀을 받은 뒤에는 이전 핀으로 바꾸지 못한다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const oldPin = pinOf(account.email);
      await ageIssuance(account.accountId, 2 * MINUTE);
      await requestPin(account.email);

      const res = await resetPassword(account.email, oldPin, NEW_PASSWORD);

      expect(res.status).toBe(401);
      expect((await login(account.email, OLD_PASSWORD)).status).toBe(200);
    });

    it('10분이 지나 만료된 핀으로는 바꾸지 못한다', async () => {
      const account = await createAccount();
      await requestPin(account.email);
      const pin = pinOf(account.email);
      await prisma.passwordResetPin.updateMany({
        where: { accountId: account.accountId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await resetPassword(account.email, pin, NEW_PASSWORD);

      expect(res.status).toBe(401);
      expect((await login(account.email, OLD_PASSWORD)).status).toBe(200);
    });

    describe('규칙에 어긋나는 새 비밀번호', () => {
      it('400 과 사유를 주고 핀은 그대로 둔다 — 다시 정할 수 있다', async () => {
        const account = await createAccount();
        await requestPin(account.email);
        const pin = pinOf(account.email);

        const tooShort = await resetPassword(account.email, pin, 'short');

        expect(tooShort.status).toBe(400);
        expect(messageOf(tooShort).length).toBeGreaterThan(5);
        const [row] = await pinsOf(account.accountId);
        expect(row).toMatchObject({ attemptCount: 0, usedAt: null });
        expect((await login(account.email, OLD_PASSWORD)).status).toBe(200);
        // 같은 핀으로 규칙에 맞는 값을 다시 보내면 바뀐다.
        const retry = await resetPassword(account.email, pin, NEW_PASSWORD);
        expect(retry.status).toBe(204);
      });

      it('이메일을 그대로 쓴 비밀번호는 받지 않는다', async () => {
        const account = await createAccount();
        await requestPin(account.email);

        const res = await resetPassword(
          account.email,
          pinOf(account.email),
          account.email,
        );

        expect(res.status).toBe(400);
      });

      it('핀이 틀렸으면 규칙 사유가 아니라 핀 거부가 먼저다', async () => {
        const account = await createAccount();
        await requestPin(account.email);

        const res = await resetPassword(account.email, 'WRONG1', 'short');

        expect(res.status).toBe(401);
      });
    });
  });
});
