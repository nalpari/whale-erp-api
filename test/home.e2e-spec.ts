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
// 조건(AND 로 묶은 staffMember · 계정 동의), distinct + orderBy 는 목으로는 증명되지 않는다. 오늘 출퇴근(가려지는 출근 기록 ·
// 출근 없는 퇴근 · 밤샘 퇴근), 소속 확인 거절의 열림/닫힘과 순서, 긴급 TO-DO 의 미완료 줄 세기도 실제 DB 로 본다(WHALEERP-620).
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
  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

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
                hqSharingConsentVersion: 'v1',
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

    // 재직 직원 하나 더 — 체결 완료(종료일 없음, 경고 밴드에 안 든다)나 지정한 상태의 근로계약 하나를 함께 만든다
    const employed = async (
      storeId: number,
      name: string,
      contract: { status?: 'SIGNED' | 'REJECTED'; createdAt?: Date } = {},
      consented: boolean | null = null,
    ) => {
      const id = await staff(storeId, name, 'FULL_TIME', consented);
      await prisma.contract.create({
        data: {
          staffMemberId: id,
          storeId,
          createdBy: baId,
          status: contract.status ?? 'SIGNED',
          startDate: addDays(today, -30),
          createdAt: contract.createdAt,
        },
      });
      return id;
    };
    const checkOutOnly = await employed(directStoreId, '퇴근만');
    const overnight = await employed(directStoreId, '밤샘');

    // 오늘 시작해 이미 시작한 근무스케줄 — 지안 · 미동의 · 동의 · 퇴근만 · 밤샘
    const startAt = new Date(
      Math.max(kstDayStart(today).getTime(), Date.now() - 60_000),
    );
    for (const [staffMemberId, storeId] of [
      [jian, directStoreId],
      [hidden, franchiseStoreId],
      [shown, franchiseStoreId],
      [checkOutOnly, directStoreId],
      [overnight, directStoreId],
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

    // 오늘 출퇴근 기록. 지안은 없다(미출근). 동의 · 미동의 직원은 출근했다 — 미동의 직원 것은 본사 역할에게 가려져 오늘 출근에
    // 들지 않는다. 퇴근만: 출근 없는 퇴근 한 짝(출근 미등록이라 미출근이 아니다). 밤샘: 어제 출근의 짝 퇴근만 오늘에 있다 —
    // 어제 날에 붙으므로 오늘은 기록 없는 날, 미출근이다
    const punch = (
      staffMemberId: number,
      storeId: number,
      kind: 'CHECK_IN' | 'CHECK_OUT',
      recordedAt: Date,
      checkInAttendanceRecordId?: number,
    ) =>
      prisma.attendanceRecord.create({
        data: {
          staffMemberId,
          storeId,
          kind,
          recordedAt,
          checkInAttendanceRecordId,
        },
      });
    await punch(shown, franchiseStoreId, 'CHECK_IN', startAt);
    await punch(hidden, franchiseStoreId, 'CHECK_IN', startAt);
    await punch(checkOutOnly, directStoreId, 'CHECK_OUT', startAt);
    const lastNight = await punch(
      overnight,
      directStoreId,
      'CHECK_IN',
      new Date(kstDayStart(today).getTime() - 2 * 60 * 60 * 1000),
    );
    await punch(
      overnight,
      directStoreId,
      'CHECK_OUT',
      startAt,
      lastNight.attendanceRecordId,
    );

    // 소속 확인 거절. 열린 것: 복귀 확인 1일 전 · 소속 추가 확인 3일 전(오래 기다린 것이 앞), 미동의 가맹 직원의 거절(본사
    // 역할에게 가려진다). 닫힌 것: 거절 뒤 새 근로계약을 만든 직원, 거절 뒤 다시 보낸 초대가 마지막인 직원
    const confirm = (
      staffMemberId: number,
      invitationType: 'AFFILIATION_CONFIRM' | 'RETURN_CONFIRM',
      status: 'REJECTED' | 'SENT',
      daysAgo: number,
    ) => {
      const at = new Date(Date.now() - daysAgo * DAY);
      return prisma.invitation.create({
        data: {
          staffMemberId,
          invitationType,
          channel: 'ALIMTALK',
          status,
          sentAt: new Date(at.getTime() - 60 * 60 * 1000),
          expiresAt: addDays(at, 30),
          respondedAt: status === 'REJECTED' ? at : null,
        },
      });
    };
    const rejected = { status: 'REJECTED', createdAt: daysAgo(5) } as const;
    // 늦게 거절한 쪽을 먼저 만든다 — 순서가 만든 순서가 아니라 거절 시각에서 나오는지 본다
    await confirm(
      await employed(directStoreId, '복귀거절', rejected),
      'RETURN_CONFIRM',
      'REJECTED',
      1,
    );
    await confirm(
      await employed(directStoreId, '추가거절', rejected),
      'AFFILIATION_CONFIRM',
      'REJECTED',
      3,
    );
    await confirm(
      await employed(franchiseStoreId, '가맹거절', rejected),
      'AFFILIATION_CONFIRM',
      'REJECTED',
      4,
    );
    const recontracted = await employed(directStoreId, '새계약', rejected);
    await confirm(recontracted, 'AFFILIATION_CONFIRM', 'REJECTED', 4);
    // 기존 근로계약 대체 — 거절보다 늦게 만든 임시저장(미체결에 들지 않는다)
    await prisma.contract.create({
      data: {
        staffMemberId: recontracted,
        storeId: directStoreId,
        createdBy: baId,
        status: 'DRAFT',
        createdAt: daysAgo(1),
      },
    });
    const resent = await employed(directStoreId, '재발송', rejected);
    await confirm(resent, 'AFFILIATION_CONFIRM', 'REJECTED', 4);
    await confirm(resent, 'AFFILIATION_CONFIRM', 'SENT', 2);

    // 긴급 TO-DO. 미완료(대기 · 진행 중)만 센다 — 완료 · 긴급 아님 · 삭제는 빠진다. 배정 그룹은 완료 행이 섞여도 한 줄이다
    const todo = (
      storeId: number,
      title: string,
      extra: Partial<{
        status: 'PENDING' | 'IN_PROGRESS' | 'DONE';
        isUrgent: boolean;
        isDeleted: boolean;
        assignmentGroupId: number;
        createdAt: Date;
      }> = {},
    ) =>
      prisma.todo.create({
        data: {
          storeId,
          title,
          assigneeType: extra.assignmentGroupId ? 'ALL' : 'INDIVIDUAL',
          executionMode: 'EACH',
          dueDate: today,
          isUrgent: true,
          createdBy: baId,
          ...extra,
        },
      });
    for (const status of ['DONE', 'PENDING'] as const)
      await todo(directStoreId, `긴급 그룹 ${n}`, {
        status,
        assignmentGroupId: n,
        createdAt: daysAgo(3),
      });
    await todo(directStoreId, `긴급 대기 ${n}`, { createdAt: daysAgo(2) });
    await todo(directStoreId, `긴급 진행 ${n}`, {
      status: 'IN_PROGRESS',
      createdAt: daysAgo(1),
    });
    await todo(franchiseStoreId, `긴급 가맹 ${n}`);
    await todo(directStoreId, `긴급 완료 ${n}`, { status: 'DONE' });
    await todo(directStoreId, `보통 ${n}`, { isUrgent: false });
    await todo(directStoreId, `긴급 삭제 ${n}`, { isDeleted: true });
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    const byStore = { storeId: { in: [directStoreId, franchiseStoreId] } };
    await prisma.todo.deleteMany({ where: byStore });
    await prisma.invitation.deleteMany({ where: byStaff });
    // 짝 퇴근이 출근을 가리킨다(RESTRICT) — 퇴근부터 지운다
    await prisma.attendanceRecord.deleteMany({
      where: { ...byStaff, checkInAttendanceRecordId: { not: null } },
    });
    await prisma.attendanceRecord.deleteMany({ where: byStaff });
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

  it('GET /home/summary — 권한 없는 영역은 null, 본사 역할에게 미동의 가맹 직원은 총수 · 근무 예정에만 든다, 출근 없는 퇴근 · 밤샘 퇴근은 미출근 판정대로', async () => {
    const res = await get(`/home/summary?${scope()}`, baId);
    expect(res.status).toBe(200);
    const body = res.body as HomeSummaryResponseDto;
    expect(body.platform).toBe(false);
    expect(body.cards).toMatchObject({
      // 총수는 그대로(10명), 고용 형태 나눔은 동의한 직원만 — 직영 7명은 정직원, 가맹은 동의 직원(파트) 하나
      staff: { total: 10, fullTime: 7, partTime: 1 },
      // 서명 대기 둘 중 미동의 직원 것은 세지 않는다. 거부 · 임시저장 · 체결 완료는 미체결이 아니다
      unsignedContractCount: 1,
      stores: { total: 2, direct: 1, franchise: 1 },
      // 근무 예정은 그대로(5명). 오늘 출근은 동의 직원 하나 — 미동의 직원의 출근 기록은 가려진다. 미출근은 지안 · 밤샘 —
      // 퇴근만(출근 없는 퇴근)은 출근 미등록이고, 미동의 직원은 세지 않는다
      todayAttendance: { scheduled: 5, checkedIn: 1, notCheckedIn: 2 },
      // 문의사항 조회 권한이 없다
      myInquiries: null,
    });
    const row = (storeId: number) =>
      body.storeTable.items.find((r) => r.storeId === storeId);
    expect(row(franchiseStoreId)).toMatchObject({
      staffCount: 3,
      unsignedContractCount: 1,
      // 가맹 점포의 근무 예정은 동의 · 미동의 두 명 — 가림 없이 든다. 출근은 동의 직원만
      scheduledCount: 2,
      checkedInCount: 1,
      // 동의 직원의 서명 대기 + 긴급 TO-DO 하나. 미동의 직원의 거절은 가려진다
      pendingActionCount: 2,
    });
    expect(row(directStoreId)).toMatchObject({
      staffCount: 7,
      unsignedContractCount: 0,
      scheduledCount: 3,
      checkedInCount: 0,
      // 열린 거절 둘 + 긴급 TO-DO 미완료 세 줄(그룹 · 대기 · 진행 중)
      pendingActionCount: 5,
    });
    // 미조치가 많은 점포가 앞이다
    expect(body.storeTable.items.map((r) => r.storeId)).toEqual([
      directStoreId,
      franchiseStoreId,
    ]);
  });

  it('GET /home/pending — 플랫폼 계정은 빈 결과, BP 관리자는 경고 밴드 · 동의한 직원의 서명 대기 · 열린 소속 확인 거절 · 긴급 TO-DO', async () => {
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
      'AFFILIATION_REJECTED',
      'URGENT_TODO',
    ]);
    expect(body.items[1]).toMatchObject({
      count: 1,
      firstName: '동의',
      waitingDays: 2,
      filter: { storeIds: [franchiseStoreId] },
    });
    // 열린 거절은 추가거절(3일) · 복귀거절(1일) — 오래 기다린 것이 앞. 새 계약 · 재발송 직원은 닫혔고, 미동의 가맹 직원의
    // 거절(4일)은 본사 역할에게 가려진다
    expect(body.items[2]).toEqual({
      type: 'AFFILIATION_REJECTED',
      count: 2,
      firstName: '추가거절',
      isFirstNameMasked: false,
      othersCount: 1,
      waitingDays: 3,
      filter: { storeIds: [directStoreId], status: ['REJECTED'] },
    });
    // 긴급 TO-DO 미완료 네 줄 — 그룹(완료 행이 섞여도 한 줄) · 대기 · 진행 중 · 가맹. 등록이 이른 것이 앞이다
    expect(body.items[3]).toEqual({
      type: 'URGENT_TODO',
      count: 4,
      firstName: `긴급 그룹 ${n}`,
      isFirstNameMasked: false,
      othersCount: 3,
      waitingDays: 3,
      filter: {
        storeIds: [directStoreId, franchiseStoreId].sort((a, b) => a - b),
        status: ['PENDING', 'IN_PROGRESS'],
      },
    });
  });
});
