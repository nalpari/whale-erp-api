import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    await prisma.contractWorkDay.deleteMany({ where: byStaff });
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
    await prisma.storeBusinessProfile.deleteMany({ where: { storeId } });
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

  it('날인하면 직원 레코드의 빈 입사일을 계약 시작일로 채우고, 이미 있으면 그대로 둔다 (WHALEERP-613)', async () => {
    const staffOf = async (contractId: number) =>
      prisma.contract.findUniqueOrThrow({
        where: { contractId },
        select: { staffMemberId: true, startDate: true },
      });
    const hiredOf = async (staffMemberId: number) =>
      (
        await prisma.staffMember.findUniqueOrThrow({
          where: { staffMemberId },
          select: { hiredDate: true },
        })
      ).hiredDate;

    const a = await account();
    const first = await pending(a);
    await sign(first.contractId, await token(a.accountId), first.sentAt).expect(
      200,
    );
    const c = await staffOf(first.contractId);
    expect(await hiredOf(c.staffMemberId)).toEqual(c.startDate);

    // 백필 마이그레이션도 같은 값을 낸다 — 비운 뒤 그 UPDATE 를 다시 돌린다(입사일이 빈 레코드만 고친다)
    await prisma.staffMember.update({
      where: { staffMemberId: c.staffMemberId },
      data: { hiredDate: null },
    });
    const sql = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20261022142048_team3_staff_hired_date_backfill/migration.sql',
      ),
      'utf8',
    );
    await prisma.$executeRawUnsafe(
      sql.slice(sql.indexOf('UPDATE'), sql.indexOf(';', sql.indexOf('UPDATE'))),
    );
    expect(await hiredOf(c.staffMemberId)).toEqual(c.startDate);

    // 갱신 — 입사일이 있는 레코드에 체결 완료가 와도 바꾸지 않는다
    const b = await account();
    const renewal = await pending(b);
    const r = await staffOf(renewal.contractId);
    await prisma.staffMember.update({
      where: { staffMemberId: r.staffMemberId },
      data: { hiredDate: new Date('2025-03-01') },
    });
    await sign(
      renewal.contractId,
      await token(b.accountId),
      renewal.sentAt,
    ).expect(200);
    expect(await hiredOf(r.staffMemberId)).toEqual(new Date('2025-03-01'));
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

  it('퇴직일이 지난 직원(배치 전)은 날인 · 거부 409 STAFF_RETIRED — 바꾸지 않는다', async () => {
    const a = await account();
    const auth = await token(a.accountId);
    const { contractId, sentAt } = await pending(a);
    const { staffMemberId } = await prisma.contract.findUniqueOrThrow({
      where: { contractId },
    });
    await prisma.staffMember.update({
      where: { staffMemberId },
      data: { retiredDate: addDays(kstToday(), -1) },
    });
    storage.put.mockClear();
    const signed = await sign(contractId, auth, sentAt).expect(409);
    expect(signed.body).toMatchObject({ code: 'STAFF_RETIRED' });
    expect(storage.put).not.toHaveBeenCalled();
    const rejected = await post(
      `/me/contracts/${contractId}/reject`,
      auth,
    ).expect(409);
    expect(rejected.body).toMatchObject({ code: 'STAFF_RETIRED' });
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
    const { contractId, sentAt } = await pending(a);
    // 발송 일시는 넣고 서명만 뺀다 — DTO 가 아니라 서비스의 서명 누락 검사를 본다
    const res = await request(app.getHttpServer())
      .post(`/me/contracts/${contractId}/sign`)
      .set('Authorization', `Bearer ${await token(a.accountId)}`)
      .field('sentAt', sentAt.toISOString())
      .expect(400);
    expect(res.body).toMatchObject({
      message: '서명 이미지(signature)를 보내 주세요',
    });
    const adminToken = await admin();
    await post(`/me/contracts/${contractId}/reject`, adminToken).expect(403);
  });

  // 직원 앱 근로계약 조회(WHALEERP-610)
  const get = (path: string, auth: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${auth}`);

  it('목록 — 내 계약 중 서명 대기 이후만, 날인을 기다리는 계약이 먼저. 발송 대기 · 남의 계약 · 후보 계정 계약은 없다', async () => {
    const a = await account();
    const other = await account();
    const auth = await token(a.accountId);
    const signed = await pending(a);
    await sign(signed.contractId, auth, signed.sentAt).expect(200);
    const waiting = await pending(a);
    const notSent = await pending(a);
    await prisma.contract.update({
      where: { contractId: notSent.contractId },
      data: { status: 'PENDING_SEND' },
    });
    await pending(a, { link: 'candidate' });
    await pending(other);

    const res = await get('/me/contracts', auth).expect(200);
    const body = res.body as {
      items: { contractId: number; awaitingSignature: boolean }[];
      total: number;
    };
    expect(body.items.map((i) => i.contractId)).toEqual([
      waiting.contractId,
      signed.contractId,
    ]);
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({
      status: 'PENDING_SIGNATURE',
      storeId,
      storeName: '날인 테스트 직영점',
      employmentType: 'PART_TIME',
      contractMethod: 'ELECTRONIC',
      sentAt: waiting.sentAt.toISOString(),
      awaitingSignature: true,
    });
    expect(body.items[1]).toMatchObject({
      status: 'SIGNED',
      awaitingSignature: false,
      processedAt: expect.any(String) as unknown,
    });
    await get('/me/contracts', await admin()).expect(403);
  });

  it('상세 — 근무 조건 · 근로자 칸 · 사용자 칸 · 본인 대조 미리보기, 받은 sentAt 그대로 날인된다', async () => {
    const a = await account();
    const auth = await token(a.accountId);
    const { contractId } = await pending(a);
    const res = await get(`/me/contracts/${contractId}`, auth).expect(200);
    const d = res.body as { sentAt: string } & Record<string, unknown>;
    expect(d).toMatchObject({
      contractId,
      status: 'PENDING_SIGNATURE',
      awaitingSignature: true,
      signable: true,
      mismatches: [],
      startDate: expect.any(String) as unknown,
      workDays: [],
      worker: { name: '홍길동', gender: 'FEMALE', jobTitle: '매장' },
      employer: { storeName: '날인 테스트 직영점', tradeName: null },
      account: {
        name: '홍 길동',
        address: '서울 마포구 동교로 1',
      },
      documents: [],
    });
    await sign(contractId, auth, d.sentAt).expect(200);

    // 날인 뒤에는 읽기 전용 — 날인을 기다리지 않고, 근로자 칸에 고정한 주소가 보인다 · 서명 이미지는 싣지 않는다
    const after = await get(`/me/contracts/${contractId}`, auth).expect(200);
    expect(after.body).toMatchObject({
      status: 'SIGNED',
      awaitingSignature: false,
      signable: false,
      worker: { address: '서울 마포구 동교로 1' },
      documents: [],
    });
  });

  it('상세 — 본인 대조가 틀리면 다른 항목을 싣고 날인할 수 없다(날인은 409 와 같은 항목)', async () => {
    const a = await account();
    const auth = await token(a.accountId);
    const { contractId, sentAt } = await pending(a, { name: '홍길순' });
    const res = await get(`/me/contracts/${contractId}`, auth).expect(200);
    expect(res.body).toMatchObject({
      awaitingSignature: true,
      signable: false,
      mismatches: ['name'],
    });
    const signed = await sign(contractId, auth, sentAt).expect(409);
    expect(signed.body).toMatchObject({ mismatches: ['name'] });
  });

  it('상세 — 남의 계약 · 후보 계정 계약 · 발송 대기는 404(같은 본문), 관리자 토큰 403', async () => {
    const me = await account();
    const other = await account();
    const auth = await token(me.accountId);
    const { contractId: others } = await pending(other);
    const { contractId: candidate } = await pending(me, { link: 'candidate' });
    const { contractId: notSent } = await pending(me);
    await prisma.contract.update({
      where: { contractId: notSent },
      data: { status: 'PENDING_SEND' },
    });
    // 차례로 — 연결이 하나인 PGlite 에 동시에 보내지 않는다
    const bodies: unknown[] = [];
    for (const id of [others, candidate, notSent])
      bodies.push((await get(`/me/contracts/${id}`, auth).expect(404)).body);
    // 날인 API 도 같은 기준 — 발송 대기는 409 가 아니라 404(계약이 있는지 드러내지 않는다)
    bodies.push(
      (await post(`/me/contracts/${notSent}/reject`, auth).expect(404)).body,
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[3]).toEqual(bodies[0]);
    await get(`/me/contracts/${others}`, await admin()).expect(403);
  });

  it('상세 — 사업자 정보가 있으면 사용자 칸에, 근무일은 HH:mm 으로. 임시저장은 404', async () => {
    const a = await account();
    const auth = await token(a.accountId);
    const { contractId } = await pending(a);
    await prisma.contractWorkDay.create({
      data: {
        contractId,
        weekday: 'TUE',
        startTime: new Date('1970-01-01T10:00:00.000Z'),
        endTime: new Date('1970-01-01T16:30:00.000Z'),
        breakStartTime: new Date('1970-01-01T12:00:00.000Z'),
        breakEndTime: new Date('1970-01-01T13:00:00.000Z'),
      },
    });
    await prisma.storeBusinessProfile.create({
      data: {
        storeId,
        bizTradeName: '날인 테스트 상호',
        bizRegistrationNumber: '1234567890',
        bizCeoName: '김대표',
        bizAddress: '서울 마포구 양화로 1',
      },
    });
    try {
      const res = await get(`/me/contracts/${contractId}`, auth).expect(200);
      expect(res.body).toMatchObject({
        employer: {
          storeName: '날인 테스트 직영점',
          tradeName: '날인 테스트 상호',
          registrationNumber: '1234567890',
          ceoName: '김대표',
          bizAddress: '서울 마포구 양화로 1',
          bizZipCode: null,
        },
        workDays: [
          {
            weekday: 'TUE',
            startTime: '10:00',
            endTime: '16:30',
            breakStartTime: '12:00',
            breakEndTime: '13:00',
          },
        ],
      });
    } finally {
      await prisma.storeBusinessProfile.deleteMany({ where: { storeId } });
    }

    const { contractId: draft } = await pending(a);
    await prisma.contract.update({
      where: { contractId: draft },
      data: { status: 'DRAFT' },
    });
    await get(`/me/contracts/${draft}`, auth).expect(404);
  });
});
