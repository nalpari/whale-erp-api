import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { ContractFilesService } from '../src/contracts/contract-files.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';

// 근로계약서 보낸 원본 · 처리 완료본 채우기(WHALEERP-131)를 실제 DB 로 확인한다 — 날인이 먼저 나가 완료본이 없는 체결 계약(백필),
// 고정 전 계약은 지금 점포 정보, 발송 뒤 하루 안의 보낸 원본, 함께 만들어도 한 장(고유 인덱스). 저장소는 가짜다.
describe('근로계약서 파일 채우기 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let files: ContractFilesService;
  let png: Buffer;
  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  const staffIds: number[] = [];
  const stored = new Map<string, Buffer>();
  const storage = {
    put: jest.fn((key: string, body: Buffer) => {
      stored.set(key, body);
      return Promise.resolve();
    }),
    get: jest.fn((key: string) => Promise.resolve(stored.get(key)!)),
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
    files = app.get(ContractFilesService);
    png = await sharp({
      create: {
        width: 60,
        height: 20,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
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
        tradeName: '파일 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '파일 테스트 직영점',
        phone: '0212345678',
        storeStatusCode: 'OPERATING',
      },
    }));
    await prisma.storeBusinessProfile.create({
      data: { storeId, bizTradeName: '지금 상호', bizCeoName: '김대표' },
    });
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `files${n}`,
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
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: adminId },
    });
    await prisma.storeBusinessProfile.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { storeId } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  /** 계약 하나 — signed 면 체결 완료 · 체결 이력 · 서명 행(완료본은 없다), 아니면 서명 대기 */
  async function contract(o: {
    sentAt: Date;
    signed?: boolean;
    method?: 'ELECTRONIC' | 'PAPER' | null;
  }) {
    const n = randomInt(10_000_000, 99_999_999);
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        name: '홍길동',
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '매장',
        joinStatus: 'JOINED',
      },
    });
    staffIds.push(staff.staffMemberId);
    const { contractId } = await prisma.contract.create({
      data: {
        staffMemberId: staff.staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: o.method === undefined ? 'ELECTRONIC' : o.method,
        startDate: new Date('2026-11-01'),
        status: o.signed ? 'SIGNED' : 'PENDING_SIGNATURE',
        sentAt: o.sentAt,
        createdBy: adminId,
        // 고정 전에 체결된 계약 — 사용자 칸이 비어 있다
        contractParty: { create: { enteredName: '홍길동' } },
      },
    });
    if (o.signed) {
      await prisma.contractStatusHistory.create({
        data: {
          contractId,
          fromStatus: 'PENDING_SIGNATURE',
          toStatus: 'SIGNED',
          actor: 'STAFF',
        },
      });
      const key = `contracts/${contractId}/${randomUUID()}.png`;
      stored.set(key, png);
      await prisma.contractDocument.create({
        data: {
          contractId,
          kind: 'SIGNATURE',
          storageKey: key,
          fileName: `서명-${contractId}.png`,
          checksum: 'e2e',
        },
      });
    }
    return contractId;
  }

  const docs = (contractId: number) =>
    prisma.contractDocument.findMany({
      where: { contractId, kind: { in: ['SENT_ORIGINAL', 'SIGNED_COPY'] } },
      orderBy: { contractDocumentId: 'asc' },
    });

  // 배치는 DB 전체를 본다 — 앞 suite 가 남긴 체결 계약의 완료본도 만들어 PDF 몇십 장이 걸릴 수 있다
  it('채우기 배치 — 완료본이 없는 체결 계약(백필)과 발송 뒤 하루 안의 보낸 원본을 만든다. 다시 돌면 더 만들지 않는다', async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    const backfill = await contract({ sentAt: minutesAgo(3000), signed: true });
    const recent = await contract({ sentAt: minutesAgo(10) });
    const tooNew = await contract({ sentAt: minutesAgo(1) });
    const tooOld = await contract({ sentAt: minutesAgo(3000) });
    const paper = await contract({
      sentAt: minutesAgo(10),
      signed: true,
      method: 'PAPER',
    });
    // 계약 방식이 빈 옛 전자계약도 대상이다(두 조회 모두 NULL 을 종이 계약으로 보지 않는다)
    const noMethod = await contract({
      sentAt: minutesAgo(10),
      signed: true,
      method: null,
    });

    // 한 번에 50건씩 고른다 — 앞 suite 가 남긴 계약이 많으면 이 계약들 차례가 늦다. 더 만들 것이 없을 때까지 돈다
    for (let run = 0; run < 50 && (await files.fillMissing(now)) > 0; run++);
    // 다른 테스트 행과 상관없이 이 계약들만 본다
    const [b, r, n, o, p] = await Promise.all(
      [backfill, recent, tooNew, tooOld, paper].map(docs),
    );
    expect(b.map((d) => [d.kind, d.sentAt])).toEqual([
      ['SIGNED_COPY', minutesAgo(3000)],
    ]);
    expect(r.map((d) => [d.kind, d.sentAt])).toEqual([
      ['SENT_ORIGINAL', minutesAgo(10)],
    ]);
    // 발송 직후(보내기 · 되돌리기 중)와 하루가 지난 발송은 배치가 만들지 않는다. 종이 계약은 본문이 없다
    expect([n, o, p]).toEqual([[], [], []]);
    expect(stored.get(b[0].storageKey)!.toString('latin1')).toContain(
      '/Subtype /Image',
    );
    expect((await docs(noMethod)).map((d) => d.kind).sort()).toEqual([
      'SENT_ORIGINAL',
      'SIGNED_COPY',
    ]);
    // 고정 전에 체결된 계약 — 지금 점포 정보로 만들고 그 값을 당사자 행에 적었다. 고정 일시는 비어 있는 채다(그 기록)
    expect(
      await prisma.contractParty.findUniqueOrThrow({
        where: { contractId: backfill },
      }),
    ).toMatchObject({
      employerName: '지금 상호',
      employerCeoName: '김대표',
      employerPhone: '0212345678',
      employerFixedAt: null,
    });

    await files.fillMissing(now);
    expect(await docs(backfill)).toHaveLength(1);
    expect(await docs(recent)).toHaveLength(1);
  }, 120_000);

  it('함께 만들어도 한 장만 남고, 진 쪽은 올린 파일을 지운다(고유 인덱스)', async () => {
    const contractId = await contract({ sentAt: new Date(), signed: true });
    storage.delete.mockClear();
    const results = await Promise.all([
      files.make('SIGNED_COPY', contractId),
      files.make('SIGNED_COPY', contractId),
    ]);
    expect(results.filter((r) => r === 'CREATED')).toHaveLength(1);
    expect(await docs(contractId)).toHaveLength(1);
    // 둘 다 읽은 뒤 올렸으면 진 쪽이 지운다. 한 쪽이 먼저 끝났으면 다른 쪽은 올리지 않고 EXISTS
    expect(storage.delete.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('다시 보낸 계약은 그 발송의 보낸 원본을 새로 만든다 — 앞 발송분은 남는다', async () => {
    const first = new Date(Date.now() - 60 * 60_000);
    const contractId = await contract({ sentAt: first });
    await expect(files.make('SENT_ORIGINAL', contractId)).resolves.toBe(
      'CREATED',
    );
    await expect(files.make('SENT_ORIGINAL', contractId)).resolves.toBe(
      'EXISTS',
    );
    const second = new Date(Date.now() - 30 * 60_000);
    await prisma.contract.update({
      where: { contractId },
      data: { sentAt: second },
    });
    await expect(files.make('SENT_ORIGINAL', contractId)).resolves.toBe(
      'CREATED',
    );
    expect((await docs(contractId)).map((d) => d.sentAt)).toEqual([
      first,
      second,
    ]);
  });
});
