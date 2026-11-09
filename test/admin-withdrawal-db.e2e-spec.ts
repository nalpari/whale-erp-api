import { randomInt } from 'node:crypto';
import type { ContractStatus } from '@prisma/client';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { WithdrawEligibilityResponseDto } from '../src/auth/dto/admin-withdrawal-eligibility.response.dto';
import type { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { OPTIONAL_MAIL_SERVICE } from '../src/mail/mail.module';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Whale-admin-1';
// 실제 PostgreSQL 에서만 도는 동시성 검사. PGlite 는 세션이 하나라 연결이 서로 잠금을 기다리지 않는다.
const onRealPostgres = process.env.E2E_REAL_POSTGRES === '1' ? it : it.skip;
const ELIGIBILITY = '/auth/admin/me/withdraw-eligibility';
const WITHDRAW = '/auth/admin/me/withdraw';

/**
 * 회원 탈퇴를 실제 DB 로 — 탈퇴와 폐점이 한 트랜잭션인지(폐점이 409 면 이미 지운 개인정보까지 되돌아가는지), 폐점 서비스가 실제로
 * 점포를 닫고 직원 · 계약을 처리하는지. mock 으로는 증명되지 않는다. 메일은 보내지 않는다.
 */
describe('회원 탈퇴 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const bpIds: number[] = [];
  const adminIds: number[] = [];

  const post = (token: string) =>
    request(app.getHttpServer())
      .post(WITHDRAW)
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, reasonCode: 'WD_CLOSE' });
  const eligibility = (token: string) =>
    request(app.getHttpServer())
      .get(ELIGIBILITY)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(OPTIONAL_MAIL_SERVICE)
      .useValue(null)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // bpIds 가 비면 아무것도 지우지 않는다 — 준비 실패 때 다른 행을 건드리지 않는다.
    if (prisma && bpIds.length) {
      const stores = await prisma.store.findMany({
        where: { bpCodeId: { in: bpIds } },
        select: { storeId: true },
      });
      const storeIds = stores.map((s) => s.storeId);
      const byStore = { storeId: { in: storeIds } };
      const byAdmin = { adminAccountId: { in: adminIds } };
      await prisma.attendanceRecord.deleteMany({ where: byStore });
      await prisma.staffMemberRetirementLog.deleteMany({
        where: { staffMember: byStore },
      });
      await prisma.contractStatusHistory.deleteMany({
        where: { contract: byStore },
      });
      await prisma.contract.deleteMany({ where: byStore });
      await prisma.staffMember.deleteMany({ where: byStore });
      await prisma.storeChangeHistory.deleteMany({ where: byStore });
      await prisma.store.deleteMany({ where: byStore });
      await prisma.bpChangeHistory.deleteMany({
        where: { bpCodeId: { in: bpIds } },
      });
      await prisma.adminChangeHistory.deleteMany({ where: byAdmin });
      await prisma.adminLoginLog.deleteMany({ where: byAdmin });
      await prisma.adminSession.deleteMany({ where: byAdmin });
      // 탈퇴가 BP 의 수정자를 그 계정으로 남긴다 — 외래키에 막히지 않게 먼저 비운다.
      await prisma.bpCode.updateMany({
        where: { bpCodeId: { in: bpIds } },
        data: { updatedBy: null },
      });
      await prisma.adminAccount.deleteMany({ where: byAdmin });
      await prisma.bpCode.deleteMany({ where: { bpCodeId: { in: bpIds } } });
    }
    await app?.close();
  });

  const seed = async () => {
    const n = randomInt(100_000, 999_999);
    const { bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        tradeName: `탈퇴 DB 테스트 ${n}`,
        accountStatusCode: 'ACTIVE',
      },
    });
    bpIds.push(bpCodeId);
    const { roleGroupId } = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    const passwordHash = await hashPassword(PASSWORD);
    const admin = async (roleTypeCode: string) => {
      const created = await prisma.adminAccount.create({
        data: {
          loginId: `wdr${randomInt(10_000_000, 99_999_999)}`,
          bpCodeId,
          name: '홍길동',
          phone: '01012345678',
          email: `wd${randomInt(10_000_000, 99_999_999)}@example.com`,
          passwordHash,
          roleTypeCode,
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(created.adminAccountId);
      return created;
    };
    const master = await admin('BM');
    const sub = await admin('BA');
    const login = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ loginId: master.loginId, password: PASSWORD })
      .expect(200);
    const token = (login.body as AdminLoginResponseDto).accessToken;

    const store = async (name: string, storeStatusCode = 'NOT_OPERATING') =>
      prisma.store.create({
        data: {
          storeCode: `ST${randomInt(100_000, 999_999)}`,
          bpCodeId,
          storeTypeCode: 'DIRECT',
          name,
          storeStatusCode,
          createdBy: master.adminAccountId,
        },
      });
    const open = await store('열린 점포');
    const second = await store('두 번째 점포');
    const closed = await store('이미 폐점', 'CLOSED');
    const staff = await prisma.staffMember.create({
      data: {
        storeId: open.storeId,
        name: '박직원',
        phone: `010${randomInt(10_000_000, 99_999_999)}`,
        jobTitle: '홀',
        employmentType: 'PART_TIME',
        joinStatus: 'INVITED',
      },
    });
    const contract = (status: ContractStatus) =>
      prisma.contract.create({
        data: {
          staffMemberId: staff.staffMemberId,
          storeId: open.storeId,
          status,
          contractMethod: 'ELECTRONIC',
          startDate: new Date('2026-01-01'),
          createdBy: master.adminAccountId,
        },
      });
    return {
      bpCodeId,
      master,
      sub,
      token,
      open,
      second,
      closed,
      staff,
      pending: await contract('PENDING_SIGNATURE'),
      signed: await contract('SIGNED'),
    };
  };

  const statusOf = async (contractId: number) =>
    (await prisma.contract.findUniqueOrThrow({ where: { contractId } })).status;
  const account = (adminAccountId: number) =>
    prisma.adminAccount.findUniqueOrThrow({ where: { adminAccountId } });

  it('폐점 안 한 점포를 모두 닫고 체결 완료 계약이 있어도 탈퇴한다 — 개인정보 · 접속 · 대기 계약까지', async () => {
    const s = await seed();

    const res = await eligibility(s.token).expect(200);
    const body = res.body as WithdrawEligibilityResponseDto;
    expect(body).toMatchObject({
      adminCount: 1,
      storeCount: 2,
      closing: { isBlocked: false },
    });
    expect(body).not.toHaveProperty('hasInProgressContract');
    expect(body.closing.stores).toEqual([
      expect.objectContaining({
        storeId: s.open.storeId,
        storeName: '열린 점포',
        storeCode: s.open.storeCode,
        isBlocked: false,
      }),
      expect.objectContaining({
        storeId: s.second.storeId,
        storeName: '두 번째 점포',
        storeCode: s.second.storeCode,
        isBlocked: false,
      }),
    ]);

    await post(s.token).expect(204);

    const open = await prisma.store.findUniqueOrThrow({
      where: { storeId: s.open.storeId },
    });
    expect(open.storeStatusCode).toBe('CLOSED');
    expect(open.closedDate).not.toBeNull();
    expect(
      (
        await prisma.store.findUniqueOrThrow({
          where: { storeId: s.second.storeId },
        })
      ).storeStatusCode,
    ).toBe('CLOSED');
    expect(await statusOf(s.pending.contractId)).toBe('ENDED');
    expect(await statusOf(s.signed.contractId)).toBe('SIGNED');
    expect(
      (
        await prisma.staffMember.findUniqueOrThrow({
          where: { staffMemberId: s.staff.staffMemberId },
        })
      ).retiredDate,
    ).not.toBeNull();
    // 이미 폐점한 점포에는 폐점 이력을 더 남기지 않는다
    expect(
      await prisma.storeChangeHistory.count({
        where: { storeId: s.closed.storeId },
      }),
    ).toBe(0);

    expect(await account(s.master.adminAccountId)).toMatchObject({
      accountStatusCode: 'WITHDRAWN',
      name: null,
      phone: null,
      email: null,
    });
    expect(await account(s.sub.adminAccountId)).toMatchObject({
      accountStatusCode: 'INACTIVE',
      name: null,
      phone: null,
      email: null,
    });
    expect(
      (
        await prisma.bpCode.findUniqueOrThrow({
          where: { bpCodeId: s.bpCodeId },
        })
      ).accountStatusCode,
    ).toBe('WITHDRAWN');
    // 남은 접근 토큰은 끊겼다
    await eligibility(s.token).expect(401);
  });

  it('퇴근 기록이 없는 출근이 있으면 조회가 막힘을 알리고, 실행은 409 로 이미 쓴 것까지 전부 되돌린다', async () => {
    const s = await seed();
    const recordedAt = new Date(Date.now() - 2 * 86_400_000);
    await prisma.attendanceRecord.create({
      data: {
        staffMemberId: s.staff.staffMemberId,
        storeId: s.open.storeId,
        kind: 'CHECK_IN',
        recordedAt,
        receivedAt: recordedAt,
      },
    });

    const check = await eligibility(s.token).expect(200);
    const { closing } = check.body as WithdrawEligibilityResponseDto;
    expect(closing.isBlocked).toBe(true);
    expect(closing.stores[0].openCheckIns).toEqual({
      count: 1,
      hiddenCount: 0,
    });
    // 열린 출근은 수만 — 직원 이름은 나가지 않는다
    expect(JSON.stringify(closing)).not.toContain('박직원');

    const res = await post(s.token).expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'OPEN_CHECK_IN',
      storeId: s.open.storeId,
      message: '퇴근 기록이 없는 출근이 있어 폐점할 수 없습니다.',
    });

    // close 앞에서 쓴 것 — 계정 · 개인정보 · BP · 이력 — 이 모두 그대로다
    expect(await account(s.master.adminAccountId)).toMatchObject({
      accountStatusCode: 'ACTIVE',
      name: '홍길동',
      phone: '01012345678',
      email: s.master.email,
      withdrawReasonCode: null,
    });
    expect(await account(s.sub.adminAccountId)).toMatchObject({
      accountStatusCode: 'ACTIVE',
      name: '홍길동',
      email: s.sub.email,
    });
    expect(
      (
        await prisma.bpCode.findUniqueOrThrow({
          where: { bpCodeId: s.bpCodeId },
        })
      ).accountStatusCode,
    ).toBe('ACTIVE');
    expect(
      await prisma.bpChangeHistory.count({ where: { bpCodeId: s.bpCodeId } }),
    ).toBe(0);
    expect(
      await prisma.adminChangeHistory.count({
        where: {
          adminAccountId: {
            in: [s.master.adminAccountId, s.sub.adminAccountId],
          },
        },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.store.findUniqueOrThrow({
          where: { storeId: s.open.storeId },
        })
      ).storeStatusCode,
    ).toBe('NOT_OPERATING');
    expect(await statusOf(s.pending.contractId)).toBe('PENDING_SIGNATURE');
    // 접속도 끊기지 않았다
    await eligibility(s.token).expect(200);
  });

  onRealPostgres(
    '탈퇴가 점포 잠금을 기다리는 동안 그 점포가 닫히면 목록에서 빠지고 탈퇴는 성공한다',
    async () => {
      const s = await seed();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let holding!: (pid: number) => void;
      const held = new Promise<number>((resolve) => (holding = resolve));
      const closer = prisma.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          await tx.$executeRaw`UPDATE stores SET store_status_code = 'CLOSED', closed_date = CURRENT_DATE WHERE store_id = ${s.second.storeId}`;
          holding(pid);
          await released;
        },
        { timeout: 20_000 },
      );
      const holder = await held;

      const withdrawal = post(s.token).then((res) => res);
      let isBlocked = false;
      for (let i = 0; i < 200 && !isBlocked; i++) {
        const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
          SELECT count(*)::int AS c FROM pg_stat_activity
           WHERE ${holder}::int = ANY (pg_blocking_pids(pid))`;
        isBlocked = c > 0;
        if (!isBlocked) await new Promise((r) => setTimeout(r, 25));
      }
      release();
      await closer;
      expect(isBlocked).toBe(true);

      expect((await withdrawal).status).toBe(204);
      expect(
        (
          await prisma.store.findUniqueOrThrow({
            where: { storeId: s.open.storeId },
          })
        ).storeStatusCode,
      ).toBe('CLOSED');
      // 먼저 닫힌 점포는 탈퇴의 폐점 대상이 아니었다 — 점포상태 이력이 없다
      expect(
        await prisma.storeChangeHistory.count({
          where: { storeId: s.second.storeId },
        }),
      ).toBe(0);
    },
    30_000,
  );
});
