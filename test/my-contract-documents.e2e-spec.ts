import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ContractDocumentKind, ContractStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';
import { addDays, kstToday } from '../src/staff-members/kst-date';

// 직원 앱 근로계약 파일 내려받기 주소(WHALEERP-146 · 149)를 실제 DB 로 확인한다 — 내 계약의 상세 documents 파일만,
// 남의 계약 · 다른 계약의 파일 · 필기 서명은 404, 처리 완료본은 체결된 계약에서만(그 밖은 409), 관리자 토큰 403 ·
// 토큰 없음 401. 저장소는 가짜다 — 서명 주소 대신 키와 파일 이름을 담은 주소를 준다.
describe('직원 근로계약 파일 내려받기 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  const accountIds: number[] = [];
  const staffIds: number[] = [];
  const storage = {
    downloadUrl: jest.fn((key: string, fileName: string) =>
      Promise.resolve(
        `https://s3.test/${key}?name=${encodeURIComponent(fileName)}`,
      ),
    ),
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

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '계약 파일 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '계약 파일 테스트 직영점',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `docs${n}`,
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

  beforeEach(() => storage.downloadUrl.mockClear());

  async function account() {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `docs-${n}@test.invalid`,
        passwordHash: '!',
        realName: '홍길동',
        birthDate: new Date('1995-03-02'),
        phone: `010${n}`,
        gender: 'FEMALE',
        status: 'JOINED',
      },
    });
    accountIds.push(accountId);
    return accountId;
  }

  /** 그 계정에 이어진 직원 레코드의 계약 하나. link 가 candidate 면 후보 계정만 둔다 */
  async function contract(
    accountId: number,
    status: ContractStatus,
    link: 'account' | 'candidate' = 'account',
  ) {
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        name: '홍길동',
        phone: `010${randomInt(10_000_000, 99_999_999)}`,
        employmentType: 'PART_TIME',
        jobTitle: '매장',
        joinStatus: link === 'account' ? 'JOINED' : 'INVITED',
        ...(link === 'account'
          ? { accountId }
          : { candidateAccountId: accountId }),
      },
    });
    staffIds.push(staff.staffMemberId);
    const { contractId } = await prisma.contract.create({
      data: {
        staffMemberId: staff.staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'PAPER',
        startDate: addDays(kstToday(), 1),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status,
        createdBy: adminId,
      },
    });
    return contractId;
  }

  async function document(
    contractId: number,
    kind: ContractDocumentKind,
    fileName = '근로계약서 (최종).pdf',
  ) {
    const storageKey = `contracts/${contractId}/${randomUUID()}.pdf`;
    const { contractDocumentId } = await prisma.contractDocument.create({
      data: { contractId, kind, storageKey, fileName, checksum: 'e2e' },
    });
    return { contractDocumentId, storageKey, fileName };
  }

  const token = async (accountId: number) => {
    const session = await app
      .get(AuthSessionService)
      .issue({ accountId, deviceIdentifier: `docs-e2e-${accountId}` });
    return app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  };
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
  const download = (contractId: number, documentId: number, auth?: string) => {
    const req = request(app.getHttpServer()).get(
      `/me/contracts/${contractId}/documents/${documentId}/download-url`,
    );
    return auth ? req.set('Authorization', `Bearer ${auth}`) : req;
  };

  it('내 계약의 종이 계약 날인본 · 임금계약서 — 상세 documents 의 파일을 원래 이름으로 받는 주소', async () => {
    const me = await account();
    const auth = await token(me);
    const contractId = await contract(me, 'SIGNED');
    const paper = await document(contractId, 'PAPER_EMPLOYMENT_CONTRACT');
    const wage = await document(contractId, 'WAGE_CONTRACT', '임금계약서.jpg');

    const detail = await request(app.getHttpServer())
      .get(`/me/contracts/${contractId}`)
      .set('Authorization', `Bearer ${auth}`)
      .expect(200);
    expect(
      (
        detail.body as { documents: { contractDocumentId: number }[] }
      ).documents.map((d) => d.contractDocumentId),
    ).toEqual([paper.contractDocumentId, wage.contractDocumentId]);

    for (const d of [paper, wage]) {
      const res = await download(contractId, d.contractDocumentId, auth).expect(
        200,
      );
      expect(res.body).toEqual({
        url: `https://s3.test/${d.storageKey}?name=${encodeURIComponent(d.fileName)}`,
      });
    }
    expect(storage.downloadUrl).toHaveBeenCalledTimes(2);
  });

  it('남의 계약 · 후보 계정 계약 · 발송 대기는 상세와 같은 404 본문, 다른 계약의 파일 · 필기 서명은 404', async () => {
    const me = await account();
    const other = await account();
    const auth = await token(me);
    const mine = await contract(me, 'SIGNED');
    const others = await contract(other, 'SIGNED');
    const candidate = await contract(me, 'SIGNED', 'candidate');
    const notSent = await contract(me, 'PENDING_SEND');
    const draft = await contract(me, 'DRAFT');
    const othersDoc = await document(others, 'PAPER_EMPLOYMENT_CONTRACT');
    const candidateDoc = await document(candidate, 'PAPER_EMPLOYMENT_CONTRACT');
    const notSentDoc = await document(notSent, 'PAPER_EMPLOYMENT_CONTRACT');
    const draftDoc = await document(draft, 'PAPER_EMPLOYMENT_CONTRACT');
    const signature = await document(mine, 'SIGNATURE', '서명.png');

    const detail404 = await request(app.getHttpServer())
      .get(`/me/contracts/${others}`)
      .set('Authorization', `Bearer ${auth}`)
      .expect(404);
    // 차례로 — 연결이 하나인 PGlite 에 동시에 보내지 않는다
    for (const [id, d] of [
      [others, othersDoc],
      [candidate, candidateDoc],
      [notSent, notSentDoc],
      [draft, draftDoc],
    ] as const) {
      const res = await download(id, d.contractDocumentId, auth).expect(404);
      expect(res.body).toEqual(detail404.body);
    }
    // 내 계약 경로에 남의 계약 파일 id — 그 계약의 파일이 아니다
    const wrong = await download(
      mine,
      othersDoc.contractDocumentId,
      auth,
    ).expect(404);
    expect(wrong.body).toMatchObject({ message: '파일을 찾을 수 없습니다.' });
    await download(mine, signature.contractDocumentId, auth).expect(404);
    expect(storage.downloadUrl).not.toHaveBeenCalled();
  });

  it('처리 완료본은 체결 완료 · 종료에서만 — 서명 대기 · 수정 요청 · 거부 · 만료는 409(지금 상태)', async () => {
    const me = await account();
    const auth = await token(me);
    for (const status of ['SIGNED', 'ENDED'] as const) {
      const id = await contract(me, status);
      // 종료는 체결 완료에서 닫혔을 때만 체결된 계약이다
      if (status === 'ENDED')
        await prisma.contractStatusHistory.create({
          data: {
            contractId: id,
            fromStatus: 'SIGNED',
            toStatus: 'ENDED',
            actor: 'SYSTEM',
          },
        });
      const copy = await document(id, 'SIGNED_COPY');
      await download(id, copy.contractDocumentId, auth).expect(200);
    }
    // 날인 전(서명 대기)에 닫힌 종료 — 처리 완료본이 있어도 내주지 않는다
    const closedUnsigned = await contract(me, 'ENDED');
    await prisma.contractStatusHistory.create({
      data: {
        contractId: closedUnsigned,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'ENDED',
        actor: 'ADMIN',
      },
    });
    const unsignedCopy = await document(closedUnsigned, 'SIGNED_COPY');
    const unsigned = await download(
      closedUnsigned,
      unsignedCopy.contractDocumentId,
      auth,
    ).expect(409);
    expect(unsigned.body).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
      status: 'ENDED',
    });
    for (const status of [
      'PENDING_SIGNATURE',
      'CORRECTION_REQUESTED',
      'REJECTED',
      'EXPIRED',
    ] as const) {
      const id = await contract(me, status);
      const copy = await document(id, 'SIGNED_COPY');
      const res = await download(id, copy.contractDocumentId, auth).expect(409);
      expect(res.body).toMatchObject({
        code: 'CONTRACT_STATUS_CONFLICT',
        status,
      });
    }
    // 처리 완료본이 아닌 파일은 서명 대기에서도 받는다
    const waiting = await contract(me, 'PENDING_SIGNATURE');
    const original = await document(waiting, 'SENT_ORIGINAL');
    await download(waiting, original.contractDocumentId, auth).expect(200);
    expect(storage.downloadUrl).toHaveBeenCalledTimes(3);
  });

  it('관리자 토큰 403 · 토큰 없음 401', async () => {
    const me = await account();
    const id = await contract(me, 'SIGNED');
    const d = await document(id, 'PAPER_EMPLOYMENT_CONTRACT');
    await download(id, d.contractDocumentId, await admin()).expect(403);
    await download(id, d.contractDocumentId).expect(401);
  });
});
