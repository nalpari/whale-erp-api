import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';
import { addDays, kstToday } from '../src/staff-members/kst-date';

// 직원 앱 날인 · 거부 · 수정 요청(WHALEERP-145)을 실제 DB 로 확인한다 — 내 계약만(남의 계약 · 후보 계정만 있는 계약 404),
// 본인 대조, 체결 완료 · 이력 · 서명 행 · 주소 고정, 두 번 누르면 409, 거부 사유는 선택. 저장소는 가짜다.
describe('직원 근로계약 날인 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let png: Buffer;
  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  const accountIds: number[] = [];
  const staffIds: number[] = [];
  /** 가짜 저장소 — 올린 키 · 지운 키 */
  const stored = new Map<string, Buffer>();
  const storage = {
    put: jest.fn((key: string, body: Buffer) => {
      stored.set(key, body);
      return Promise.resolve();
    }),
    delete: jest.fn((key: string) => {
      stored.delete(key);
      return Promise.resolve();
    }),
  };

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STORAGE)
      .useValue(storage)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    png = await sharp({
      create: {
        width: 60,
        height: 20,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '날인 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '날인 테스트 직영점',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `sign${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
  });

  afterAll(async () => {
    if (!prisma) return;
    const byStaff = { contract: { staffMemberId: { in: staffIds } } };
    await prisma.contractDocument.deleteMany({ where: byStaff });
    await prisma.contractStatusHistory.deleteMany({ where: byStaff });
    await prisma.contractParty.deleteMany({ where: byStaff });
    await prisma.contract.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.staffMember.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.authSession.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: adminId },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: adminId },
    });
    await prisma.store.deleteMany({ where: { storeId } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  async function account() {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `sign-${n}@test.invalid`,
        passwordHash: '!',
        realName: '홍 길동',
        birthDate: new Date('1995-03-02'),
        phone: `010${n}`,
        gender: 'FEMALE',
        zipCode: '04001',
        address: '서울 마포구 동교로 1',
        addressDetail: '2층',
        status: 'JOINED',
      },
    });
    accountIds.push(accountId);
    return prisma.account.findUniqueOrThrow({ where: { accountId } });
  }

  /** 서명 대기 계약 — 계약서 값은 계정과 같게(이름 공백만 다르다). link 가 candidate 면 후보 계정만 둔다 */
  async function pending(
    a: { accountId: number; phone: string },
    o: { link?: 'account' | 'candidate'; name?: string } = {},
  ) {
    const link = o.link ?? 'account';
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        name: '홍길동',
        phone: a.phone,
        employmentType: 'PART_TIME',
        jobTitle: '매장',
        joinStatus: link === 'account' ? 'JOINED' : 'INVITED',
        ...(link === 'account'
          ? { accountId: a.accountId }
          : { candidateAccountId: a.accountId }),
      },
    });
    staffIds.push(staff.staffMemberId);
    const sentAt = new Date();
    const { contractId } = await prisma.contract.create({
      data: {
        staffMemberId: staff.staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate: addDays(kstToday(), 1),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'PENDING_SIGNATURE',
        sentAt,
        signDeadlineAt: new Date(sentAt.getTime() + 30 * 86_400_000),
        createdBy: adminId,
        contractParty: {
          create: {
            enteredName: o.name ?? '홍길동',
            enteredPhone: a.phone,
            enteredBirthDate: new Date('1995-03-02'),
            enteredGender: 'FEMALE',
            isForeigner: false,
          },
        },
      },
    });
    return { contractId, sentAt };
  }

  const token = async (accountId: number) => {
    const session = await app
      .get(AuthSessionService)
      .issue({ accountId, deviceIdentifier: `sign-e2e-${accountId}` });
    return app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  };
  const sign = (contractId: number, auth: string, sentAt: Date | string) =>
    request(app.getHttpServer())
      .post(`/me/contracts/${contractId}/sign`)
      .set('Authorization', `Bearer ${auth}`)
      .attach('signature', png, 'sign.png')
      .field(
        'sentAt',
        typeof sentAt === 'string' ? sentAt : sentAt.toISOString(),
      );
  const admin = async () =>
    (
      await app
        .get(AdminSessionService)
        .issue({ adminAccountId: adminId }, (sid) =>
          app.get(JwtService).signAsync({
            sub: adminId,
            type: 'admin',
            loginId: `admin${adminId}`,
            typ: 'access',
            sid,
          }),
        )
    ).accessToken;
  const post = (path: string, auth: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  it('날인 — 체결 완료 · 직원 이력 · 서명 행, 계정 주소를 당사자 칸에 고정. 두 번 누르면 409(지금 상태)', async () => {
    const a = await account();
    const { contractId, sentAt } = await pending(a);
    const auth = await token(a.accountId);
    const res = await sign(contractId, auth, sentAt).expect(200);
    expect(res.body).toMatchObject({ contractId, status: 'SIGNED' });

    // 관계는 따로 읽는다 — 한 번에 읽으면 Prisma 가 동시에 보내, 연결이 하나인 PGlite 에서 끊긴다
    const where = { contractId };
    const c = {
      ...(await prisma.contract.findUniqueOrThrow({ where })),
      contractParty: await prisma.contractParty.findUnique({ where }),
      contractDocuments: await prisma.contractDocument.findMany({ where }),
      contractStatusHistories: await prisma.contractStatusHistory.findMany({
        where,
      }),
    };
    expect(c.status).toBe('SIGNED');
    expect(
      c.contractStatusHistories.map((h) => [h.fromStatus, h.toStatus, h.actor]),
    ).toEqual([['PENDING_SIGNATURE', 'SIGNED', 'STAFF']]);
    expect(c.contractDocuments).toEqual([
      expect.objectContaining({
        kind: 'SIGNATURE',
        fileName: `서명-${contractId}.png`,
      }),
    ]);
    expect(stored.get(c.contractDocuments[0].storageKey)).toEqual(png);
    expect(c.contractParty).toMatchObject({
      zipCode: '04001',
      address: '서울 마포구 동교로 1',
      addressDetail: '2층',
    });
    expect(c.contractParty?.filledAt).toBeInstanceOf(Date);

    // 관리자는 필기 서명을 내려받지 못한다 — 처리 완료본(131)에 합성할 재료다. 상세 목록에서 빠지는 건
    // contracts e2e 가 본다(상세는 관계를 동시에 읽어 연결이 하나인 PGlite 에서 끊긴다)
    await request(app.getHttpServer())
      .get(
        `/contracts/${contractId}/documents/${c.contractDocuments[0].contractDocumentId}/download-url`,
      )
      .set('Authorization', `Bearer ${await admin()}`)
      .expect(404);

    const again = await sign(contractId, auth, sentAt).expect(409);
    expect(again.body).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
      status: 'SIGNED',
    });
  });

  it('본인 대조가 틀리면 409 IDENTITY_MISMATCH — 올리지도 바꾸지도 않는다', async () => {
    const a = await account();
    const { contractId, sentAt } = await pending(a, { name: '홍길순' });
    storage.put.mockClear();
    const res = await sign(contractId, await token(a.accountId), sentAt).expect(
      409,
    );
    expect(res.body).toMatchObject({
      code: 'IDENTITY_MISMATCH',
      mismatches: ['name'],
    });
    expect(storage.put).not.toHaveBeenCalled();
    expect(
      (await prisma.contract.findUniqueOrThrow({ where: { contractId } }))
        .status,
    ).toBe('PENDING_SIGNATURE');
  });

  it('기한이 지났거나 본 뒤 다시 발송됐으면 409 — 바꾸지 않는다', async () => {
    const a = await account();
    const auth = await token(a.accountId);
    const late = await pending(a);
    await prisma.contract.update({
      where: { contractId: late.contractId },
      data: { signDeadlineAt: new Date(Date.now() - 1000) },
    });
    const expired = await sign(late.contractId, auth, late.sentAt).expect(409);
    expect(expired.body).toMatchObject({ code: 'SIGN_DEADLINE_PASSED' });

    const resent = await pending(a);
    const r = await sign(
      resent.contractId,
      auth,
      new Date(resent.sentAt.getTime() - 60_000),
    ).expect(409);
    expect(r.body).toMatchObject({ code: 'CONTRACT_RESENT' });
    for (const { contractId } of [late, resent])
      expect(
        (await prisma.contract.findUniqueOrThrow({ where: { contractId } }))
          .status,
      ).toBe('PENDING_SIGNATURE');
  });

  it('발송 일시가 없거나 시간대 표기가 없으면 400 — 바꾸지 않는다', async () => {
    const a = await account();
    const auth = await token(a.accountId);
    const { contractId, sentAt } = await pending(a);
    await request(app.getHttpServer())
      .post(`/me/contracts/${contractId}/sign`)
      .set('Authorization', `Bearer ${auth}`)
      .attach('signature', png, 'sign.png')
      .expect(400);
    // 서버 시간대로 읽혀 멀쩡한 날인이 재발송(409)으로 보이지 않게
    await sign(contractId, auth, sentAt.toISOString().slice(0, -1)).expect(400);
    expect(
      (await prisma.contract.findUniqueOrThrow({ where: { contractId } }))
        .status,
    ).toBe('PENDING_SIGNATURE');
  });

  it('남의 계약 · 후보 계정만 있는 계약은 404 — 같은 본문', async () => {
    const me = await account();
    const other = await account();
    const { contractId: othersContract, sentAt } = await pending(other);
    const { contractId: candidateOnly } = await pending(me, {
      link: 'candidate',
    });
    const auth = await token(me.accountId);
    const a = await sign(othersContract, auth, sentAt).expect(404);
    const b = await post(`/me/contracts/${candidateOnly}/reject`, auth).expect(
      404,
    );
    expect(a.body).toEqual(b.body);
  });

  it('거부 사유는 선택이다 — 비우면 남기지 않는다', async () => {
    const a = await account();
    const { contractId } = await pending(a);
    await post(`/me/contracts/${contractId}/reject`, await token(a.accountId))
      .expect(200)
      .expect((r) =>
        expect(r.body).toEqual({ contractId, status: 'REJECTED' }),
      );
    expect(
      await prisma.contract.findUniqueOrThrow({ where: { contractId } }),
    ).toMatchObject({ status: 'REJECTED', rejectReason: null });
  });

  it('거부 사유 길이는 앞뒤 공백을 지운 뒤로 센다', async () => {
    const a = await account();
    const { contractId } = await pending(a);
    const reason = '가'.repeat(500);
    await post(`/me/contracts/${contractId}/reject`, await token(a.accountId), {
      reason: ` ${reason}
`,
    }).expect(200);
    expect(
      await prisma.contract.findUniqueOrThrow({ where: { contractId } }),
    ).toMatchObject({ status: 'REJECTED', rejectReason: reason });
  });

  it('수정 요청 — 서명 대기면 받는다', async () => {
    const a = await account();
    const { contractId } = await pending(a);
    await post(
      `/me/contracts/${contractId}/correction-request`,
      await token(a.accountId),
    ).expect(200);
    expect(
      (await prisma.contract.findUniqueOrThrow({ where: { contractId } }))
        .status,
    ).toBe('CORRECTION_REQUESTED');
  });

  it('서명이 없으면 400, 관리자 토큰은 403', async () => {
    const a = await account();
    const { contractId } = await pending(a);
    await post(
      `/me/contracts/${contractId}/sign`,
      await token(a.accountId),
    ).expect(400);
    const adminToken = await admin();
    await post(`/me/contracts/${contractId}/reject`, adminToken).expect(403);
  });
});
