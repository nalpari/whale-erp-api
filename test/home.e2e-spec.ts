import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import type {
  HomePendingResponseDto,
  HomeSummaryResponseDto,
} from '../src/home/dto/home.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstDayStart, kstToday } from '../src/staff-members/kst-date';

// 로그인 후 홈 집계(WHALEERP-305 · 306)를 실제 DB 로 확인한다. 영역 메뉴 권한(권한 그룹 · 메뉴 url 조인), 본사 가림의 관계
// 조건(AND 로 묶은 staffMember · 계정 동의), distinct + orderBy 는 목으로는 증명되지 않는다.
describe('로그인 후 홈 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const n = randomInt(100_000, 999_999);
  const pad = (v: number) => String(v % 1_000_000).padStart(6, '0');

  let bpCodeId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let baId: number; // BP 관리자 — 문의사항 조회가 없다. 가맹 점포 직원은 동의한 사람만 개인 단위로 본다
  let pmId: number; // 플랫폼 마스터(플랫폼 BP · 고정 그룹)
  let roleGroupId: number;
  let renewalContractId: number;
  const staffIds: number[] = [];
  const accountIds: number[] = [];
  const today = kstToday();

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    bpCodeId = (
      await prisma.bpCode.create({
        data: {
          bpCode: `BP${pad(n)}`,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: '홈 테스트 BP',
        },
      })
    ).bpCodeId;
    const store = async (code: number, storeTypeCode: string, name: string) =>
      (
        await prisma.store.create({
          data: {
            storeCode: `ST${pad(code)}`,
            bpCodeId,
            storeTypeCode,
            name,
            storeStatusCode: 'OPERATING',
          },
        })
      ).storeId;
    directStoreId = await store(n, 'DIRECT', '홈 직영점');
    franchiseStoreId = await store(n + 1, 'FRANCHISE', '홈 가맹점');

    // 직원 정보 관리 · 근로계약 관리 · 근무스케줄 · 출퇴근 현황 · TO-DO 조회 — 문의사항(MN000036)은 없다
    const menus = await prisma.menu.findMany({
      where: {
        menuCode: {
          in: ['MN000005', 'MN000006', 'MN000010', 'MN000025', 'MN000026'],
        },
      },
      select: { menuId: true },
    });
    roleGroupId = (
      await prisma.roleGroup.create({
        data: {
          roleCode: `BA${pad(n)}`,
          bpCodeId,
          roleTypeCode: 'BA',
          name: `홈 권한 ${n}`,
          menus: {
            create: menus.map((m) => ({ menuId: m.menuId, isReadable: true })),
          },
        },
      })
    ).roleGroupId;
    baId = (
      await prisma.adminAccount.create({
        data: {
          loginId: `homeba${n}`,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode: 'BA',
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: true,
        },
      })
    ).adminAccountId;
    // whaleadmin 은 첫 로그인 전이라 비밀번호 변경 전 403 이다 — 따로 만든다
    pmId = (
      await prisma.adminAccount.create({
        data: {
          loginId: `homepm${n}`,
          bpCodeId: (
            await prisma.bpCode.findFirstOrThrow({
              where: { isPlatform: true },
            })
          ).bpCodeId,
          passwordHash: '!',
          roleTypeCode: 'PM',
          roleGroupId: (
            await prisma.roleGroup.findFirstOrThrow({
              where: { roleCode: 'PM000001' },
            })
          ).roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: true,
        },
      })
    ).adminAccountId;

    const staff = async (
      storeId: number,
      name: string,
      employmentType: 'FULL_TIME' | 'PART_TIME',
      consented: boolean | null,
    ) => {
      let accountId: number | null = null;
      if (consented !== null) {
        const phone = `010${randomInt(10_000_000, 99_999_999)}`;
        accountId = (
          await prisma.account.create({
            data: {
              email: `home-${phone}@test.invalid`,
              passwordHash: '!',
              realName: name,
              birthDate: new Date('1998-07-12'),
              phone,
              status: 'JOINED',
              ...(consented && {
                isHqSharingConsented: true,
                hqSharingConsentVersion: 'v1.0',
                hqSharingAgreedAt: new Date(),
              }),
            },
          })
        ).accountId;
        accountIds.push(accountId);
      }
      const s = await prisma.staffMember.create({
        data: {
          storeId,
          name,
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType,
          jobTitle: '바리스타',
          joinStatus: accountId ? 'JOINED' : 'DRAFT',
          accountId,
        },
      });
      staffIds.push(s.staffMemberId);
      return s.staffMemberId;
    };
    const jian = await staff(directStoreId, '서지안', 'FULL_TIME', null);
    const hidden = await staff(franchiseStoreId, '미동의', 'PART_TIME', null);
    const shown = await staff(franchiseStoreId, '동의', 'PART_TIME', true);

    // 지안: 종료일 3일 뒤인 체결 완료(경고 밴드). 가맹 두 사람: 서명 대기
    renewalContractId = (
      await prisma.contract.create({
        data: {
          staffMemberId: jian,
          storeId: directStoreId,
          createdBy: baId,
          status: 'SIGNED',
          startDate: addDays(today, -300),
          endDate: addDays(today, 3),
        },
      })
    ).contractId;
    for (const staffMemberId of [hidden, shown])
      await prisma.contract.create({
        data: {
          staffMemberId,
          storeId: franchiseStoreId,
          createdBy: baId,
          status: 'PENDING_SIGNATURE',
          startDate: today,
          sentAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        },
      });

    // 오늘 시작해 이미 시작한 근무스케줄 — 지안 · 미동의 직원. 출퇴근 기록은 없다
    const startAt = new Date(
      Math.max(kstDayStart(today).getTime(), Date.now() - 60_000),
    );
    for (const [staffMemberId, storeId] of [
      [jian, directStoreId],
      [hidden, franchiseStoreId],
    ])
      await prisma.workSchedule.create({
        data: {
          staffMemberId,
          storeId,
          startAt,
          endAt: new Date(startAt.getTime() + 4 * 60 * 60 * 1000),
          createdBy: baId,
        },
      });
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    await prisma.workSchedule.deleteMany({ where: byStaff });
    await prisma.contract.deleteMany({ where: byStaff });
    await prisma.staffMember.deleteMany({ where: byStaff });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: [baId, pmId] } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: [baId, pmId] } },
    });
    await prisma.roleGroupMenu.deleteMany({ where: { roleGroupId } });
    await prisma.roleGroup.deleteMany({ where: { roleGroupId } });
    await prisma.store.deleteMany({
      where: { storeId: { in: [directStoreId, franchiseStoreId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  // 관리자 토큰은 살아 있는 관리자 세션(admin_sessions)이 있어야 가드를 통과한다.
  const tokenOf = async (sub: number) =>
    (
      await app.get(AdminSessionService).issue({ adminAccountId: sub }, (sid) =>
        app.get(JwtService).signAsync({
          sub,
          type: 'admin',
          loginId: `admin${sub}`,
          typ: 'access',
          sid,
        }),
      )
    ).accessToken;
  const get = async (path: string, sub: number) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
  const scope = () => `storeIds=${directStoreId},${franchiseStoreId}`;

  it('GET /home/summary — 권한 없는 영역은 null, 본사 역할에게 미동의 가맹 직원은 총수 · 근무 예정에만 든다', async () => {
    const res = await get(`/home/summary?${scope()}`, baId);
    expect(res.status).toBe(200);
    const body = res.body as HomeSummaryResponseDto;
    expect(body.platform).toBe(false);
    expect(body.cards).toMatchObject({
      // 총수는 그대로, 고용 형태 나눔은 동의한 직원만
      staff: { total: 3, fullTime: 1, partTime: 1 },
      // 서명 대기 둘 중 미동의 직원 것은 세지 않는다
      unsignedContractCount: 1,
      stores: { total: 2, direct: 1, franchise: 1 },
      // 근무 예정은 그대로, 미출근은 동의한 직원만
      todayAttendance: { scheduled: 2, checkedIn: 0, notCheckedIn: 1 },
      // 문의사항 조회 권한이 없다
      myInquiries: null,
    });
    const franchise = body.storeTable.items.find(
      (r) => r.storeId === franchiseStoreId,
    );
    expect(franchise).toMatchObject({
      staffCount: 2,
      unsignedContractCount: 1,
      // 가맹 점포의 근무 예정은 미동의 직원 한 명 — 가림 없이 든다
      scheduledCount: 1,
      checkedInCount: 0,
      pendingActionCount: 1,
    });
  });

  it('GET /home/pending — 플랫폼 계정은 빈 결과, BP 관리자는 경고 밴드 · 동의한 직원의 서명 대기만', async () => {
    const platform = await get(`/home/pending`, pmId);
    expect(platform.status).toBe(200);
    expect(platform.body).toMatchObject({
      platform: true,
      renewals: null,
      items: [],
    });

    const res = await get(`/home/pending?${scope()}`, baId);
    expect(res.status).toBe(200);
    const body = res.body as HomePendingResponseDto;
    expect(body.renewals).toEqual([
      expect.objectContaining({
        contractId: renewalContractId,
        name: '서지안',
        storeId: directStoreId,
        endDate: addDays(today, 3).toISOString().slice(0, 10),
      }),
    ]);
    expect(body.items.map((i) => i.type)).toEqual([
      'CONTRACT_RENEWAL',
      'CONTRACT_PENDING_SIGNATURE',
    ]);
    expect(body.items[1]).toMatchObject({
      count: 1,
      firstName: '동의',
      waitingDays: 2,
      filter: { storeIds: [franchiseStoreId] },
    });
  });
});
