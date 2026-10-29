import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { hashPassword } from '../src/auth/password';
import {
  PasswordResetLinkMail,
  PasswordResetLinkSender,
  PasswordResetLinkTarget,
} from '../src/auth/password-reset-link-sender';
import { PasswordResetPinSender } from '../src/auth/password-reset-pin-sender';
import * as mailService from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

const OLD_PASSWORD = 'old-Password-1';
const NEW_PASSWORD = 'Brand-new-pw1';

/** 메일 대신 받은 링크를 모아 둔다. 메일 구현이 없어도 흐름 전체를 돌린다. */
class CapturingLinkSender extends PasswordResetLinkSender {
  readonly sent: { email: string; mail: PasswordResetLinkMail }[] = [];
  /**
   * 다음 한 번은 보내지 못한다. 'smtp' 는 SMTP 단계 실패(MailService 가 표시하는 것), 'blocked' 는 보내기 전 실패
   * (템플릿 꺼짐 등)다.
   */
  failNext: false | 'smtp' | 'blocked' = false;
  /** SMTP 단계 실패로 던진 오류 — isMailTransportError 가 이것만 참으로 본다 */
  readonly smtpFailure = new Error('smtp down');
  isAvailable() {
    return true;
  }
  send(target: PasswordResetLinkTarget, mail: PasswordResetLinkMail) {
    if (this.failNext) {
      const kind = this.failNext;
      this.failNext = false;
      return Promise.reject(
        kind === 'blocked' ? new Error('template off') : this.smtpFailure,
      );
    }
    this.sent.push({ email: target.email, mail });
    return Promise.resolve();
  }
}
class CapturingPinSender extends PasswordResetPinSender {
  readonly sent: { email: string; pin: string }[] = [];
  isAvailable() {
    return true;
  }
  send(target: { email: string }, pin: string) {
    this.sent.push({ email: target.email, pin });
    return Promise.resolve();
  }
}

// 관리자 초기화 재설정 링크(WHALEERP-172)를 실제 DB 로 확인한다. 동시 저장 · 핀과의 상호 무효는 행 잠금과 여러 표에
// 걸쳐 있어 목으로는 증명되지 않는다. 요청 제한 가드는 끈다(throttle.spec 이 따로 다룬다).
describe('관리자 초기화 재설정 링크 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const links = new CapturingLinkSender();
  const pins = new CapturingPinSender();
  let oldHash: string;
  let bpCodeId: number;
  let storeId: number;
  let otherStoreId: number;
  let adminId: number;
  let otherAdminId: number;
  let adminToken: string;
  let otherAdminToken: string;
  let readOnlyAdminId: number;
  let readOnlyRoleGroupId: number;
  let readOnlyAdminToken: string;
  const accountIds: number[] = [];
  const staffIds: number[] = [];

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    // ConfigService.get 은 파일에 없는 키를 process.env 에서 읽는다. 앱을 만들기 전에 넣어야 서비스 생성자가 읽는다.
    process.env.STAFF_APP_URL = 'https://staff.test.invalid';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PasswordResetLinkSender)
      .useValue(links)
      .overrideProvider(PasswordResetPinSender)
      .useValue(pins)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    oldHash = await hashPassword(OLD_PASSWORD);

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '링크 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '링크 테스트 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    ({ storeId: otherStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${(n + 1) % 1_000_000}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '다른 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `link${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ adminAccountId: otherAdminId } = await prisma.adminAccount.create({
      data: {
        loginId: `lnko${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BA',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: false,
        accountStatusCode: 'ACTIVE',
        storeMappings: { create: { storeId: otherStoreId } },
      },
    }));
    // 직원 정보 관리 조회만 있는 권한 그룹 — 범위 안 점포를 매핑으로 관리한다(WHALEERP-177).
    const staffMenu = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000005' },
    });
    ({ roleGroupId: readOnlyRoleGroupId } = await prisma.roleGroup.create({
      data: {
        // role_code CHECK 는 `^[A-Z]{2}[0-9]{6}$` 다.
        roleCode: `BA${String(n).padStart(6, '0')}`,
        bpCodeId,
        roleTypeCode: 'BA',
        name: `링크 조회만 ${n}`,
        menus: {
          create: {
            menuId: staffMenu.menuId,
            isReadable: true,
            isUpdatable: false,
          },
        },
      },
    }));
    ({ adminAccountId: readOnlyAdminId } = await prisma.adminAccount.create({
      data: {
        loginId: `lnkr${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BA',
        roleGroupId: readOnlyRoleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: false,
        accountStatusCode: 'ACTIVE',
        storeMappings: { create: { storeId } },
      },
    }));
    // 가드가 관리자 세션을 확인하므로 실제 admin_sessions 행으로 토큰을 낸다.
    const sign = async (sub: number) =>
      (
        await app
          .get(AdminSessionService)
          .issue({ adminAccountId: sub }, (sid) =>
            app.get(JwtService).signAsync({
              sub,
              type: 'admin',
              loginId: `admin${sub}`,
              typ: 'access',
              sid,
            }),
          )
      ).accessToken;
    adminToken = await sign(adminId);
    otherAdminToken = await sign(otherAdminId);
    readOnlyAdminToken = await sign(readOnlyAdminId);
  });

  afterAll(async () => {
    const byAccount = { accountId: { in: accountIds } };
    await prisma.passwordResetLink.deleteMany({ where: byAccount });
    await prisma.passwordResetPin.deleteMany({ where: byAccount });
    await prisma.accountChangeHistory.deleteMany({ where: byAccount });
    await prisma.authSession.deleteMany({ where: byAccount });
    await prisma.loginHistory.deleteMany({ where: byAccount });
    await prisma.staffMember.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.account.deleteMany({ where: byAccount });
    await prisma.adminStoreMapping.deleteMany({
      where: {
        adminAccountId: { in: [adminId, otherAdminId, readOnlyAdminId] },
      },
    });
    await prisma.adminSession.deleteMany({
      where: {
        adminAccountId: { in: [adminId, otherAdminId, readOnlyAdminId] },
      },
    });
    await prisma.adminAccount.deleteMany({
      where: {
        adminAccountId: { in: [adminId, otherAdminId, readOnlyAdminId] },
      },
    });
    await prisma.roleGroupMenu.deleteMany({
      where: { roleGroupId: readOnlyRoleGroupId },
    });
    await prisma.roleGroup.deleteMany({
      where: { roleGroupId: readOnlyRoleGroupId },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [storeId, otherStoreId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  /** 가입한 직원(계정 + 직원 레코드). joined=false 면 계정 없는 가입 전 직원. */
  async function createStaff(
    opts: { joined?: boolean; retired?: boolean; withdrawn?: boolean } = {},
  ) {
    const { joined = true, retired = false, withdrawn = false } = opts;
    const n = randomInt(10_000_000, 99_999_999);
    let accountId: number | null = null;
    let email = '';
    if (joined) {
      email = `link-${n}@test.invalid`;
      ({ accountId } = await prisma.account.create({
        data: {
          email,
          passwordHash: oldHash,
          realName: '홍길동',
          birthDate: new Date('1990-01-01'),
          phone: `010${n}`,
          status: withdrawn ? 'WITHDRAWN' : 'JOINED',
        },
      }));
      accountIds.push(accountId);
    }
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name: '홍길동',
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: joined ? 'JOINED' : 'DRAFT',
        ...(retired
          ? { employmentStatus: 'RETIRED', retiredDate: new Date('2026-01-31') }
          : {}),
      },
    });
    staffIds.push(staff.staffMemberId);
    return { staffMemberId: staff.staffMemberId, accountId, email };
  }

  const api = () => request(app.getHttpServer());
  // supertest 의 .expect 를 이어 쓰려고 헬퍼는 동기여야 한다. 관리자 토큰은 beforeAll 에서 만들어 둔다.
  const issue = (staffMemberId: number | string, token = adminToken) =>
    api()
      .post(`/staff-members/${staffMemberId}/password-reset-links`)
      .set('Authorization', `Bearer ${token}`);
  const lastToken = () => {
    const { link } = links.sent[links.sent.length - 1].mail;
    return new URLSearchParams(new URL(link).hash.slice(1)).get(
      'token',
    ) as string;
  };
  const verify = (token: string) =>
    api().post('/auth/account/password-reset-links/verify').send({ token });
  const reset = (token: string, newPassword = NEW_PASSWORD) =>
    api()
      .post('/auth/account/password-reset-links/reset')
      .send({ token, newPassword });
  const login = (email: string, password: string) =>
    api().post('/auth/account/login').send({ email, password });
  const pastLinkIssues = (accountId: number) =>
    // 1분 제한을 피하려고 앞서 낸 링크의 발급 시각을 2분 전으로 돌린다.
    prisma.passwordResetLink.updateMany({
      where: { accountId },
      data: { issuedAt: new Date(Date.now() - 2 * 60 * 1000) },
    });

  it('관리자가 보내고 직원이 링크로 새 비밀번호를 정하면, 새 비밀번호로 로그인되고 다른 기기 접속은 끊긴다', async () => {
    const { staffMemberId, email } = await createStaff();
    const before = await login(email, OLD_PASSWORD).expect(200);

    const res = await issue(staffMemberId).expect(201);
    const body = res.body as { issuedAt: string; expiresAt: string };
    expect(
      new Date(body.expiresAt).getTime() - new Date(body.issuedAt).getTime(),
    ).toBe(24 * 60 * 60 * 1000);
    const sent = links.sent[links.sent.length - 1];
    expect(sent.email).toBe(email);
    expect(sent.mail.storeName).toBe('링크 테스트 점포');
    expect(sent.mail.link).toMatch(
      /^https:\/\/staff\.test\.invalid\/password-reset\/link#token=/,
    );

    const token = lastToken();
    await verify(token).expect(204);
    await verify(token).expect(204); // 확인은 소진하지 않는다
    await reset(token).expect(204);

    await login(email, NEW_PASSWORD).expect(200);
    await login(email, OLD_PASSWORD).expect(401);
    const oldRefresh = (before.body as { refreshToken: string }).refreshToken;
    await api()
      .post('/auth/account/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(401);
  });

  it('토큰 원문은 DB 에 없다 — 해시만 남는다', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const row = await prisma.passwordResetLink.findFirstOrThrow({
      where: { accountId: accountId! },
    });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toBe(lastToken());
    expect(row.requestedBy).toBe(adminId);
  });

  it('링크는 한 번만 — 쓴 링크는 확인 · 저장 모두 401', async () => {
    const { staffMemberId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const token = lastToken();
    await reset(token).expect(204);
    await verify(token).expect(401);
    await reset(token, 'Another-pw-22').expect(401);
    // 규칙에 어긋난 값이어도 쓴 링크에는 사유 대신 401 이다.
    await reset(token, 'short').expect(401);
  });

  it('발송에 실패하면 503 이고 앞 링크 · 핀은 그대로다 — 바로 다시 보내면 201 이고 그때 닫힌다', async () => {
    const { staffMemberId, accountId, email } = await createStaff();
    await issue(staffMemberId).expect(201);
    const first = lastToken();
    await pastLinkIssues(accountId!);
    await api()
      .post('/auth/account/password-reset-pins')
      .send({ email })
      .expect(204);
    const pin = pins.sent[pins.sent.length - 1].pin;
    const sentBefore = links.sent.length;
    // MailService 가 SMTP 단계 예외에 붙이는 표시를 흉내 낸다
    const spy = jest
      .spyOn(mailService, 'isMailTransportError')
      .mockImplementation((e) => e === links.smtpFailure);
    links.failNext = 'smtp';
    let failed: Awaited<ReturnType<typeof issue>>;
    try {
      failed = await issue(staffMemberId);
    } finally {
      links.failNext = false;
      spy.mockRestore();
    }
    expect(failed.status).toBe(503);
    expect((failed.body as { message: string }).message).toBe(
      '재설정 링크를 보내지 못했습니다. 잠시 뒤에 다시 보내 주세요.',
    );
    await verify(first).expect(204);
    await api()
      .post('/auth/account/password-reset-pins/verify')
      .send({ email, pin })
      .expect(204);

    await issue(staffMemberId).expect(201);
    expect(links.sent.length).toBe(sentBefore + 1);
    await verify(first).expect(401);
    await api()
      .post('/auth/account/password-reset-pins/verify')
      .send({ email, pin })
      .expect(401);
    await verify(lastToken()).expect(204);
  });

  it('보내기 전에 막히면(템플릿 꺼짐 등) 500 이고 링크는 남지 않는다 — 다시 눌러도 풀리지 않으니 「잠시 뒤에 다시」가 아니다', async () => {
    const { staffMemberId, accountId } = await createStaff();
    links.failNext = 'blocked';
    const failed = await issue(staffMemberId);
    links.failNext = false;
    expect(failed.status).toBe(500);
    expect((failed.body as { message: string }).message).toBe(
      '메일 설정 문제로 재설정 링크를 보내지 못했습니다. 플랫폼 관리자에게 문의해 주세요.',
    );
    expect(
      await prisma.passwordResetLink.count({
        where: { accountId: accountId! },
      }),
    ).toBe(0);
  });

  it('만료된 링크는 401', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await issue(staffMemberId).expect(201);
    await prisma.passwordResetLink.updateMany({
      where: { accountId: accountId! },
      // CHECK(expires_at > issued_at) 가 있어 발급 시각도 함께 25시간 전으로 돌린다.
      data: {
        issuedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    await verify(lastToken()).expect(401);
  });

  it('새 링크를 보내면 앞 링크는 401 이고, 1분 안 재요청은 429', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const first = lastToken();
    await issue(staffMemberId).expect(429);
    await pastLinkIssues(accountId!);
    await issue(staffMemberId).expect(201);
    await verify(first).expect(401);
    await verify(lastToken()).expect(204);
  });

  it('규칙에 어긋난 비밀번호는 400 과 사유 — 같은 링크로 다시 정할 수 있다', async () => {
    const { staffMemberId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const token = lastToken();
    const bad = await reset(token, 'short').expect(400);
    expect((bad.body as { message: string }).message).toBeTruthy();
    await reset(token).expect(204);
  });

  // 경합을 강제할 수는 없어 여러 번 겨룬다. 잠금 뒤 다시 읽는 순서는 서비스 단위 테스트가 고정한다.
  it('같은 링크로 동시에 두 번 정하면 하나만 성공한다', async () => {
    for (let round = 0; round < 5; round++) {
      const { staffMemberId } = await createStaff();
      await issue(staffMemberId).expect(201);
      const token = lastToken();
      const statuses = (
        await Promise.all([reset(token), reset(token, 'Other-pw-3333')])
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([204, 401]);
    }
  });

  it('관리자가 링크를 보내면 열린 핀이 닫힌다', async () => {
    const { staffMemberId, email } = await createStaff();
    await api()
      .post('/auth/account/password-reset-pins')
      .send({ email })
      .expect(204);
    const pin = pins.sent[pins.sent.length - 1].pin;
    await issue(staffMemberId).expect(201);
    await api()
      .post('/auth/account/password-reset-pins/verify')
      .send({ email, pin })
      .expect(401);
  });

  it('링크로 정하면 열린 핀이 닫힌다', async () => {
    const { staffMemberId, email } = await createStaff();
    await issue(staffMemberId).expect(201);
    const token = lastToken();
    await api()
      .post('/auth/account/password-reset-pins')
      .send({ email })
      .expect(204);
    const pin = pins.sent[pins.sent.length - 1].pin;
    await reset(token).expect(204);
    await api()
      .post('/auth/account/password-reset-pins/verify')
      .send({ email, pin })
      .expect(401);
  });

  it('본인 핀 요청은 링크를 닫지 않고, 핀으로 정하면 링크가 닫힌다', async () => {
    const { staffMemberId, email } = await createStaff();
    await issue(staffMemberId).expect(201);
    const token = lastToken();
    await api()
      .post('/auth/account/password-reset-pins')
      .send({ email })
      .expect(204);
    await verify(token).expect(204);
    const pin = pins.sent[pins.sent.length - 1].pin;
    await api()
      .post('/auth/account/password-reset')
      .send({ email, pin, newPassword: NEW_PASSWORD })
      .expect(204);
    await verify(token).expect(401);
  });

  it('이력은 관리자 초기화와 요청 관리자로 남는다', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await issue(staffMemberId).expect(201);
    await reset(lastToken()).expect(204);
    const history = await prisma.accountChangeHistory.findFirstOrThrow({
      where: { accountId: accountId! },
      orderBy: { accountChangeHistoryId: 'desc' },
    });
    expect(history).toEqual(
      expect.objectContaining({
        field: 'PASSWORD',
        channel: 'ADMIN_RESET',
        requestedBy: adminId,
        beforeValue: null,
        afterValue: null,
      }),
    );
  });

  describe('관리자 쪽 거절', () => {
    it('관리 범위 밖 직원 · 없는 직원 · 범위 밖 ID 는 같은 404', async () => {
      const { staffMemberId } = await createStaff();
      await issue(staffMemberId, otherAdminToken).expect(404);
      await issue(2_147_483_647).expect(404);
      await issue('99999999999').expect(404);
    });

    it('가입 전 · 퇴직 · 탈퇴는 409', async () => {
      await issue((await createStaff({ joined: false })).staffMemberId).expect(
        409,
      );
      await issue((await createStaff({ retired: true })).staffMemberId).expect(
        409,
      );
      await issue(
        (await createStaff({ withdrawn: true })).staffMemberId,
      ).expect(409);
    });

    // 상세의 이메일은 조회 권한으로 보이지만(WHALEERP-180), 링크 발송은 계정 조치라 수정 권한이다 — 조회만 있으면
    // 이메일은 보고 링크는 403 이다.
    it('직원 정보 관리 수정 권한이 없으면 범위 안 직원이어도 403 이고, 메일도 링크도 생기지 않는다 — 상세의 이메일은 보인다', async () => {
      const { staffMemberId, accountId, email } = await createStaff();
      const sentBefore = links.sent.length;

      const detail = await api()
        .get(`/staff-members/${staffMemberId}`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);
      expect([
        detail.status,
        (detail.body as { email: string | null }).email,
      ]).toEqual([200, email]);
      await issue(staffMemberId, readOnlyAdminToken).expect(403);

      expect(links.sent).toHaveLength(sentBefore);
      expect(
        await prisma.passwordResetLink.count({
          where: { accountId: accountId! },
        }),
      ).toBe(0);
    });

    // 권한이 범위보다 먼저여야 한다. 범위를 먼저 보면 권한 없는 관리자가 없는 ID · 범위 밖에는 404, 범위 안에는
    // 403 을 받아 응답만으로 그 ID 가 자기 범위의 직원인지 알게 된다. 그 회귀에서 이 테스트는 404 를 받아 실패한다.
    it('수정 권한이 없으면 어떤 ID 든 같은 403 이다 — 없는 직원 · 범위 밖 · 형식 오류도 404 로 갈리지 않는다', async () => {
      const inScope = await createStaff();
      const outOfScope = await prisma.staffMember.create({
        data: {
          storeId: otherStoreId,
          name: '다른점포직원',
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
        },
      });
      staffIds.push(outOfScope.staffMemberId);

      // supertest 가 요청마다 임시 서버를 열어 한꺼번에 보내면 연결이 끊기므로 차례로 부른다.
      const statuses: number[] = [];
      for (const id of [
        inScope.staffMemberId,
        outOfScope.staffMemberId,
        2_147_483_647,
        '99999999999',
        'abc',
      ])
        statuses.push((await issue(id, readOnlyAdminToken)).status);

      expect(statuses).toEqual([403, 403, 403, 403, 403]);
    });

    it('로그인한 직원 앱 토큰은 403 — 관리자 경로에 닿지 않는다', async () => {
      const { staffMemberId, email } = await createStaff();
      const res = await login(email, OLD_PASSWORD).expect(200);
      const { accessToken } = res.body as { accessToken: string };
      await issue(staffMemberId, accessToken).expect(403);
    });

    it('접속(sid)이 없는 직원 앱 토큰은 401', async () => {
      const { staffMemberId, accountId } = await createStaff();
      const token = await app.get(JwtService).signAsync({
        sub: accountId,
        type: 'account',
        email: 'x@test.invalid',
        typ: 'access',
      });
      await issue(staffMemberId, token).expect(401);
    });
  });
});
