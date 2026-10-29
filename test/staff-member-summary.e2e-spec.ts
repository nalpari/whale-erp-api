import { randomBytes, randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ACCESS_DENIED_MESSAGE,
  READ_DENIED_MESSAGE,
} from '../src/auth/access-messages';
import { addDays, kstDayStart, kstToday } from '../src/staff-members/kst-date';
import type { StaffMemberDetailResponseDto } from '../src/staff-members/dto/staff-member-list.response.dto';
import type {
  StaffMemberContractSummaryResponseDto,
  StaffMemberPayslipSummaryResponseDto,
  StaffMemberTodoSummaryResponseDto,
  StaffMemberWeekScheduleResponseDto,
} from '../src/staff-members/dto/staff-member-summary.response.dto';
import {
  encryptPersonalData,
  staffTaxProfileAad,
} from '../src/common/personal-data-cipher';
import { HQ_SHARING_CONSENT_VERSION } from '../src/admin-scope/hq-sharing';

// 직원 상세 요약(WHALEERP-183)을 실제 DB 로 확인한다. 영역 메뉴 권한은 권한 그룹 · 메뉴 url 조인이라, 그리고 「한 영역이
// 실패해도 나머지는 온다」는 경로가 실제로 나뉘어 있어야 성립하므로 목으로는 증명되지 않는다.
describe('직원 상세 요약 (e2e, DB)', () => {
  // 키가 비어 있으면 이 테스트용 키를 쓴다. 앱이 뜨기 전에 넣어야 ConfigService 가 읽는다.
  process.env.PERSONAL_DATA_ENCRYPTION_KEY ||=
    randomBytes(32).toString('base64');
  const key = Buffer.from(process.env.PERSONAL_DATA_ENCRYPTION_KEY, 'base64');
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const n = randomInt(100_000, 999_999);
  const pad = (v: number) => String(v % 1_000_000).padStart(6, '0');

  let bpCodeId: number;
  let otherBpId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let otherStoreId: number;
  let bmId: number; // BP 마스터(고정 그룹, 모든 메뉴 조회), 전체 점포
  let staffAndTodoId: number; // 직원 정보 관리 · TO-DO 조회만 있는 BP 관리자
  let noStaffReadId: number; // 직원 정보 관리 조회가 없는 BP 관리자(TO-DO 조회는 있다)
  let staffOnlyId: number; // 직원 정보 관리 조회만 — TO-DO 칸(목록 · 요약) 모두 403 이어야 한다
  let fmId: number; // 가맹마스터(고정 그룹), 가맹 점포 매핑 — 동의하지 않은 직원도 본다
  const roleGroupIds: number[] = [];
  const adminIds: number[] = [];
  const staffIds: number[] = [];
  const accountIds: number[] = [];
  const payslipIds: Record<string, number> = {};

  let jianId: number; // 직영 점포, 가입 완료 · 체결 완료 계약 · 스케줄 · 명세서 · TO-DO
  let draftId: number; // 직영 점포, 가입 전 — 생년월일은 계약에 관리자가 적은 값
  let maskedId: number; // 가맹 점포, 계정 없음(동의 없음) — BM 에게 가린다
  let consentedId: number; // 가맹 점포, 본사 제공 동의
  let otherBpStaffId: number; // 다른 BP 점포

  const today = kstToday();
  const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const at = (day: Date, hh: number) =>
    new Date(kstDayStart(day).getTime() + hh * 60 * 60 * 1000);

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

    const bp = async (code: number, name: string) =>
      (
        await prisma.bpCode.create({
          data: {
            bpCode: `BP${pad(code)}`,
            isPlatform: false,
            accountStatusCode: 'ACTIVE',
            tradeName: name,
          },
        })
      ).bpCodeId;
    const store = async (
      code: number,
      bp: number,
      storeTypeCode: string,
      name: string,
    ) =>
      (
        await prisma.store.create({
          data: {
            storeCode: `ST${pad(code)}`,
            bpCodeId: bp,
            storeTypeCode,
            name,
            storeStatusCode: 'OPERATING',
          },
        })
      ).storeId;
    bpCodeId = await bp(n, '요약 테스트 BP');
    otherBpId = await bp(n + 1, '다른 BP');
    directStoreId = await store(n, bpCodeId, 'DIRECT', '요약 직영점');
    franchiseStoreId = await store(n + 1, bpCodeId, 'FRANCHISE', '요약 가맹점');
    otherStoreId = await store(n + 2, otherBpId, 'DIRECT', '다른 BP 점포');

    const admin = async (loginId: string, roleGroupId: number) => {
      const a = await prisma.adminAccount.create({
        data: {
          loginId,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode: 'BA',
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: true,
        },
      });
      adminIds.push(a.adminAccountId);
      return a.adminAccountId;
    };
    const fixedBm = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    bmId = await admin(`sumbm${n}`, fixedBm.roleGroupId);
    await prisma.adminAccount.update({
      where: { adminAccountId: bmId },
      data: { roleTypeCode: 'BM' },
    });
    const fixedFm = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'FM000001' },
    });
    fmId = await admin(`sumfm${n}`, fixedFm.roleGroupId);
    await prisma.adminAccount.update({
      where: { adminAccountId: fmId },
      data: {
        roleTypeCode: 'FM',
        isAllStores: false,
        storeMappings: { create: { storeId: franchiseStoreId } },
      },
    });
    const menuId = async (menuCode: string) =>
      (await prisma.menu.findFirstOrThrow({ where: { menuCode } })).menuId;
    const group = async (code: number, readable: string[]) => {
      const g = await prisma.roleGroup.create({
        data: {
          roleCode: `BA${pad(code)}`,
          bpCodeId,
          roleTypeCode: 'BA',
          name: `요약 권한 ${code}`,
          menus: {
            create: await Promise.all(
              readable.map(async (m) => ({
                menuId: await menuId(m),
                isReadable: true,
              })),
            ),
          },
        },
      });
      roleGroupIds.push(g.roleGroupId);
      return g.roleGroupId;
    };
    // 직원 정보 관리(MN000005) · TO-DO(MN000026) 조회만 — 근로계약 · 근무스케줄 · 급여명세서 영역은 403 이어야 한다
    staffAndTodoId = await admin(
      `sumtodo${n}`,
      await group(n, ['MN000005', 'MN000026']),
    );
    noStaffReadId = await admin(
      `sumnostaff${n}`,
      await group(n + 1, ['MN000026']),
    );
    staffOnlyId = await admin(
      `sumstaffonly${n}`,
      await group(n + 2, ['MN000005']),
    );

    const account = async (extra: object = {}) => {
      const phone = `010${randomInt(10_000_000, 99_999_999)}`;
      const a = await prisma.account.create({
        data: {
          email: `sum-${phone}@test.invalid`,
          passwordHash: '!',
          realName: '요약계정',
          birthDate: new Date('1998-07-12'),
          phone,
          status: 'JOINED',
          ...extra,
        },
      });
      accountIds.push(a.accountId);
      return a.accountId;
    };
    const staff = async (storeId: number, name: string, extra: object) => {
      const s = await prisma.staffMember.create({
        data: {
          storeId,
          name,
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'FULL_TIME',
          jobTitle: '바리스타',
          ...extra,
        },
      });
      staffIds.push(s.staffMemberId);
      return s.staffMemberId;
    };
    jianId = await staff(directStoreId, '서지안', {
      joinStatus: 'JOINED',
      accountId: await account(),
      hiredDate: new Date('2026-03-01'),
    });
    draftId = await staff(directStoreId, '가입전', { joinStatus: 'DRAFT' });
    maskedId = await staff(franchiseStoreId, '미동의', { joinStatus: 'DRAFT' });
    consentedId = await staff(franchiseStoreId, '동의', {
      joinStatus: 'JOINED',
      accountId: await account({
        isHqSharingConsented: true,
        hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        hqSharingAgreedAt: new Date(),
      }),
    });
    otherBpStaffId = await staff(otherStoreId, '다른BP', {
      joinStatus: 'DRAFT',
    });

    // 근로계약 — 지안은 체결 완료(종료일 60일 뒤), 가입 전 직원은 생년월일을 적은 발송 대기
    const endDate = addDays(today, 60);
    const { contractId } = await prisma.contract.create({
      data: {
        staffMemberId: jianId,
        storeId: directStoreId,
        createdBy: bmId,
        employmentType: 'FULL_TIME',
        contractMethod: 'ELECTRONIC',
        status: 'SIGNED',
        startDate: new Date('2026-03-01'),
        endDate,
        sentAt: new Date('2026-02-24T01:00:00Z'),
      },
    });
    const draftContract = await prisma.contract.create({
      data: {
        staffMemberId: draftId,
        storeId: directStoreId,
        createdBy: bmId,
        status: 'PENDING_SEND',
        contractParty: { create: { enteredBirthDate: new Date('2001-05-05') } },
      },
    });
    // 더 새 임시저장 계약은 생년월일이 없다 — 예전 계약에 적은 값이 그대로 보여야 한다
    await prisma.contract.create({
      data: {
        staffMemberId: draftId,
        storeId: directStoreId,
        createdBy: bmId,
        status: 'DRAFT',
        createdAt: new Date(Date.now() + 60_000),
      },
    });

    // 근무스케줄 — 이번 주 월요일 09~17시(휴게 60), 다음 주 월요일 하나(이번 주에 들지 않는다), 지운 것 하나
    await prisma.workSchedule.createMany({
      data: [
        {
          staffMemberId: jianId,
          storeId: directStoreId,
          startAt: at(monday, 9),
          endAt: at(monday, 17),
          breakMinutes: 60,
          createdBy: bmId,
        },
        // 일요일 22시 ~ 다음 날(월) 02시 — 근무일은 시작한 일요일이라 이번 주에 든다
        {
          staffMemberId: jianId,
          storeId: directStoreId,
          startAt: at(addDays(monday, 6), 22),
          endAt: at(addDays(monday, 7), 2),
          breakMinutes: 0,
          createdBy: bmId,
        },
        {
          staffMemberId: jianId,
          storeId: directStoreId,
          startAt: at(addDays(monday, 7), 9),
          endAt: at(addDays(monday, 7), 13),
          breakMinutes: 0,
          createdBy: bmId,
        },
        {
          staffMemberId: jianId,
          storeId: directStoreId,
          startAt: at(addDays(monday, 2), 9),
          endAt: at(addDays(monday, 2), 13),
          breakMinutes: 0,
          createdBy: bmId,
          isDeleted: true,
        },
      ],
    });

    // 급여명세서 — 넉 달: 석 달 전 · 두 달 전 발송 완료, 지난달 검토 중, 이번 달 작성 중. 최근 3건이면 석 달 전이 빠진다
    const monthStart = (back: number) =>
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
    type Status = 'SENT' | 'REVIEWING' | 'DRAFTING';
    const payslip = (start: Date, status: Status, gross: number) => {
      const end = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
      );
      return {
        staffMemberId: jianId,
        storeId: directStoreId,
        contractId,
        periodStartDate: start,
        periodEndDate: end,
        employmentType: 'FULL_TIME' as const,
        attendanceStartDate: start,
        attendanceEndDate: end,
        status,
        grossPayAmount: gross,
        totalDeductionAmount: 200_000,
        netPayAmount: gross - 200_000,
        ...(status === 'SENT'
          ? { confirmedAt: new Date(), confirmedBy: bmId }
          : {}),
      };
    };
    const masterOf = async (itemCode: string) =>
      (
        await prisma.payslipItemMaster.findUniqueOrThrow({
          where: { itemCode },
        })
      ).payslipItemMasterId;
    const basePayMaster = await masterOf('BASE_PAY');
    const mealMaster = await masterOf('MEAL_ALLOWANCE');
    const item = (
      payslipItemMasterId: number,
      itemName: string,
      calculatedAmount: number | null,
      adjustedAmount: number | null = null,
      isEntered = true,
    ) => ({
      itemCategory: 'EARNING' as const,
      payslipItemMasterId,
      itemName,
      calculatedAmount,
      adjustedAmount,
      isEntered,
    });
    payslipIds.oldest = (
      await prisma.payslip.create({
        data: {
          ...payslip(monthStart(3), 'SENT', 2_900_000),
          payslipItems: { create: [item(basePayMaster, '기본급', 2_500_000)] },
        },
      })
    ).payslipId;
    // 두 달 전 — 기본급 수정값이 계산값보다 먼저, 식대는 수당으로 센다
    payslipIds.sent = (
      await prisma.payslip.create({
        data: {
          ...payslip(monthStart(2), 'SENT', 3_000_000),
          payslipItems: {
            create: [
              item(basePayMaster, '기본급', 2_500_000, 2_600_000),
              item(mealMaster, '식대', 200_000),
            ],
          },
        },
      })
    ).payslipId;
    payslipIds.reviewing = (
      await prisma.payslip.create({
        data: {
          ...payslip(monthStart(1), 'REVIEWING', 3_100_000),
          payslipItems: { create: [item(basePayMaster, '기본급', 2_400_000)] },
        },
      })
    ).payslipId;
    // 이번 달 작성 중 — 기본급 항목이 없다
    payslipIds.drafting = (
      await prisma.payslip.create({
        data: payslip(monthStart(0), 'DRAFTING', 2_000_000),
      })
    ).payslipId;

    // 가입 전 직원 — 기본급 계산값은 있지만 넣지 않은 줄(isEntered = false)
    payslipIds.notEntered = (
      await prisma.payslip.create({
        data: {
          ...payslip(monthStart(0), 'DRAFTING', 2_000_000),
          staffMemberId: draftId,
          contractId: draftContract.contractId,
          payslipItems: {
            create: [item(basePayMaster, '기본급', 1_800_000, null, false)],
          },
        },
      })
    ).payslipId;

    // TO-DO — 완료 1 · 대기 1 · 지운 것 1
    const todo = async (
      title: string,
      status: 'DONE' | 'PENDING',
      del = false,
    ) =>
      prisma.todo.create({
        data: {
          storeId: directStoreId,
          title,
          assigneeType: 'INDIVIDUAL',
          executionMode: 'EACH',
          dueDate: today,
          status,
          createdBy: bmId,
          isDeleted: del,
          todoAssignees: {
            create: { staffMemberId: jianId, isCompleted: status === 'DONE' },
          },
          todoStatusHistories: {
            create: [
              { toStatus: 'PENDING', changedBy: bmId },
              ...(status === 'DONE'
                ? [
                    {
                      fromStatus: 'PENDING' as const,
                      toStatus: 'DONE' as const,
                      staffMemberId: jianId,
                      changedAt: new Date(Date.now() + 1000),
                    },
                  ]
                : []),
            ],
          },
        },
      });
    await todo('냉장고 정리', 'DONE');
    await todo('POP 교체', 'PENDING');
    await todo('지운 것', 'PENDING', true);

    // 신고 정보 — 지안(계약 있음) · 동의 직원(계약 없음) · 미동의 직원(BM 에게 가려진다). 계좌번호는 하이픈 없는 숫자
    const taxProfile = (id: number, account: string) =>
      prisma.staffTaxProfile.create({
        data: {
          staffMemberId: id,
          rrnEncrypted: encryptPersonalData(
            key,
            '9807121234567',
            staffTaxProfileAad('rrn_encrypted', id),
          ),
          bankCode: 'B004',
          payrollAccountNumberEncrypted: encryptPersonalData(
            key,
            account,
            staffTaxProfileAad('payroll_account_number_encrypted', id),
          ),
          purpose: '취득 신고 · 원천징수 · 급여 이체',
        },
      });
    await taxProfile(jianId, '12345678901234');
    await taxProfile(consentedId, '22223333444455');
    await taxProfile(maskedId, '99998888777766');
    await taxProfile(otherBpStaffId, '55556666777788');
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    const todos = { todoAssignees: { some: byStaff } };
    await prisma.todoStatusHistory.deleteMany({ where: { todo: todos } });
    const todoIds = (
      await prisma.todo.findMany({ where: todos, select: { todoId: true } })
    ).map((t) => t.todoId);
    await prisma.todoAssignee.deleteMany({ where: byStaff });
    await prisma.todo.deleteMany({ where: { todoId: { in: todoIds } } });
    await prisma.payslipItem.deleteMany({ where: { payslip: byStaff } });
    await prisma.payslip.deleteMany({ where: byStaff });
    await prisma.workSchedule.deleteMany({ where: byStaff });
    await prisma.contractParty.deleteMany({ where: { contract: byStaff } });
    await prisma.contract.deleteMany({ where: byStaff });
    await prisma.staffTaxProfile.deleteMany({ where: byStaff });
    await prisma.staffMember.deleteMany({ where: byStaff });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.adminStoreMapping.deleteMany({ where: byAdmin });
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    const byGroup = { roleGroupId: { in: roleGroupIds } };
    await prisma.roleGroupMenu.deleteMany({ where: byGroup });
    await prisma.roleGroup.deleteMany({ where: byGroup });
    await prisma.store.deleteMany({
      where: {
        storeId: { in: [directStoreId, franchiseStoreId, otherStoreId] },
      },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpId] } },
    });
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
  const get = async (path: string, sub = bmId) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
  const AREAS = ['contracts', 'work-schedules', 'payslips', 'todos'];

  it('본사 제공 동의 상태 — 직영 점포 직원은 null, 가맹 점포는 동의 · 미동의(가입 전은 미동의)', async () => {
    const direct = await get(`/staff-members/${jianId}`);
    expect(
      (direct.body as StaffMemberDetailResponseDto).hqSharingConsent,
    ).toBeNull();
    const agreed = await get(`/staff-members/${consentedId}`);
    expect((agreed.body as StaffMemberDetailResponseDto).hqSharingConsent).toBe(
      'AGREED',
    );
    // 본사 역할은 미동의 직원 상세를 열지 못한다(ATT-30) — 가맹 역할로 본다
    expect((await get(`/staff-members/${maskedId}`)).status).toBe(404);
    const notAgreed = await get(`/staff-members/${maskedId}`, fmId);
    expect(notAgreed.status).toBe(200);
    expect(
      (notAgreed.body as StaffMemberDetailResponseDto).hqSharingConsent,
    ).toBe('NOT_AGREED');
  });

  it('상세 기본 정보 — 직무 · 입사일 · 생년월일(가입한 계정 값)', async () => {
    const res = await get(`/staff-members/${jianId}`);
    expect(res.status).toBe(200);
    expect(res.body as StaffMemberDetailResponseDto).toMatchObject({
      jobTitle: '바리스타',
      hiredDate: '2026-03-01',
      birthDate: '1998-07-12',
    });
  });

  it('가입 전 직원의 생년월일은 생년월일이 적힌 가장 최근 계약의 값 — 더 새 임시저장에 값이 없어도', async () => {
    const res = await get(`/staff-members/${draftId}`);
    expect(res.status).toBe(200);
    expect(res.body as StaffMemberDetailResponseDto).toMatchObject({
      birthDate: '2001-05-05',
      hiredDate: null,
    });
  });

  it('본사 역할(BM)이 동의한 가맹 점포 직원 상세를 열면 생년월일은 내고 이메일은 null — 동의는 자료까지, 계정 정보는 아니다', async () => {
    const res = await get(`/staff-members/${consentedId}`);
    expect(res.status).toBe(200);
    expect(res.body as StaffMemberDetailResponseDto).toMatchObject({
      birthDate: '1998-07-12',
      email: null,
    });
  });

  it('근로계약 요약 — 유형 · 기간 · 상태 · 최근 발송일 · 갱신 예정일', async () => {
    const res = await get(`/staff-members/${jianId}/summary/contracts`);
    expect(res.status).toBe(200);
    const end = addDays(today, 60);
    expect(res.body as StaffMemberContractSummaryResponseDto).toMatchObject({
      contract: {
        employmentType: 'FULL_TIME',
        contractMethod: 'ELECTRONIC',
        status: 'SIGNED',
        startDate: '2026-03-01',
        endDate: ymd(end),
        lastSentAt: '2026-02-24T01:00:00.000Z',
        renewalDate: ymd(addDays(end, -30)),
      },
    });
  });

  it('근로계약 요약의 급여 계좌 — 신고 정보의 은행 이름 · 계좌번호 전체(하이픈 없음)', async () => {
    const res = await get(`/staff-members/${jianId}/summary/contracts`);
    expect(res.status).toBe(200);
    const body = res.body as StaffMemberContractSummaryResponseDto;
    // 본사 역할(BM) + 직영 점포 직원 — 본사 쪽에도 그대로 보인다
    expect(body.canViewPayrollAccount).toBe(true);
    expect(body.payrollAccount).toEqual({
      bankName: 'KB국민은행',
      accountNumber: '12345678901234',
    });
  });

  it('근로계약 요약의 급여 계좌 — 가맹마스터(FM)가 가맹 점포 직원을 보면 계약이 없어도 신고 정보가 온다', async () => {
    const res = await get(
      `/staff-members/${consentedId}/summary/contracts`,
      fmId,
    );
    expect(res.status).toBe(200);
    expect(res.body as StaffMemberContractSummaryResponseDto).toEqual({
      contract: null,
      canViewPayrollAccount: true,
      payrollAccount: {
        bankName: 'KB국민은행',
        accountNumber: '22223333444455',
      },
    });
  });

  it('근로계약 요약의 급여 계좌 — 가맹마스터(FM)는 미동의 가맹 직원도 canViewPayrollAccount true — 판정은 동의와 상관없다', async () => {
    const res = await get(`/staff-members/${maskedId}/summary/contracts`, fmId);
    expect(res.status).toBe(200);
    const body = res.body as StaffMemberContractSummaryResponseDto;
    expect(body.canViewPayrollAccount).toBe(true);
    expect(body.payrollAccount).toEqual({
      bankName: 'KB국민은행',
      accountNumber: '99998888777766',
    });
  });

  it('근로계약 요약의 급여 계좌 — 본사 역할(BM)은 본사 제공 동의한 가맹 직원의 계좌를 못 본다(canViewPayrollAccount false, 본문에 계좌번호 없음)', async () => {
    const res = await get(`/staff-members/${consentedId}/summary/contracts`);
    expect(res.status).toBe(200);
    expect(res.body as StaffMemberContractSummaryResponseDto).toEqual({
      contract: null,
      canViewPayrollAccount: false,
      payrollAccount: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('22223333444455');
  });

  it('근로계약 요약의 급여 계좌 — 신고 정보가 없으면 null', async () => {
    const res = await get(`/staff-members/${draftId}/summary/contracts`);
    expect(res.status).toBe(200);
    const body = res.body as StaffMemberContractSummaryResponseDto;
    expect(body.canViewPayrollAccount).toBe(true);
    expect(body.payrollAccount).toBeNull();
  });

  it('신고 정보가 있어도 본사 역할에게 가려진 직원이면 요약 경로가 막힌다(404) — 계좌가 새지 않는다', async () => {
    const res = await get(`/staff-members/${maskedId}/summary/contracts`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('99998888777766');
  });

  it('신고 정보(계좌)가 있어도 근로계약 메뉴 조회 권한이 없으면 403, 범위 밖 직원이면 404 — 본문에 계좌번호가 없다', async () => {
    const denied = await get(
      `/staff-members/${jianId}/summary/contracts`,
      staffOnlyId,
    );
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('12345678901234');
    const outOfScope = await get(
      `/staff-members/${otherBpStaffId}/summary/contracts`,
    );
    expect(outOfScope.status).toBe(404);
    expect(JSON.stringify(outOfScope.body)).not.toContain('55556666777788');
  });

  it('근무스케줄 — 이번 주만, 지운 것 빼고, 주간 합계', async () => {
    const res = await get(`/staff-members/${jianId}/summary/work-schedules`);
    expect(res.status).toBe(200);
    const body = res.body as StaffMemberWeekScheduleResponseDto;
    expect(body).toMatchObject({
      weekStart: ymd(monday),
      weekEnd: ymd(addDays(monday, 6)),
      totalWorkMinutes: 660,
    });
    expect(body.items).toEqual([
      expect.objectContaining({
        workDate: ymd(monday),
        startTime: '09:00',
        endTime: '17:00',
        storeName: '요약 직영점',
        workMinutes: 420,
      }),
      expect.objectContaining({
        workDate: ymd(addDays(monday, 6)),
        startTime: '22:00',
        endTime: '02:00',
        workMinutes: 240,
      }),
    ]);

    const next = await get(
      `/staff-members/${jianId}/summary/work-schedules?weekStart=${ymd(addDays(monday, 9))}`,
    );
    expect(next.status).toBe(200);
    expect(next.body as StaffMemberWeekScheduleResponseDto).toMatchObject({
      weekStart: ymd(addDays(monday, 7)),
      totalWorkMinutes: 240,
    });
  });

  it('근무스케줄 — weekStart 형식 오류는 400', async () => {
    const res = await get(
      `/staff-members/${jianId}/summary/work-schedules?weekStart=2026-02-30`,
    );
    expect(res.status).toBe(400);
  });

  it('급여명세서 — 최근 3건(작성 중 포함, 급여 기간 최신순) · 기본급 · 수당 · 미발송', async () => {
    const res = await get(`/staff-members/${jianId}/summary/payslips`);
    expect(res.status).toBe(200);
    const body = res.body as StaffMemberPayslipSummaryResponseDto;
    // 넉 달 중 석 달 전은 빠진다
    expect(body.recent.map((p) => p.payslipId)).toEqual([
      payslipIds.drafting,
      payslipIds.reviewing,
      payslipIds.sent,
    ]);
    const end = (back: number) =>
      ymd(
        new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back + 1, 0),
        ),
      );
    const start = (back: number) =>
      ymd(
        new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1),
        ),
      );
    expect(body.recent).toEqual([
      // 기본급 항목이 없다 — 기본급 null, 수당은 지급 총액 그대로
      {
        payslipId: payslipIds.drafting,
        periodStartDate: start(0),
        periodEndDate: end(0),
        basePayAmount: null,
        allowanceAmount: 2_000_000,
        totalDeductionAmount: 200_000,
        netPayAmount: 1_800_000,
        status: 'DRAFTING',
      },
      {
        payslipId: payslipIds.reviewing,
        periodStartDate: start(1),
        periodEndDate: end(1),
        basePayAmount: 2_400_000,
        allowanceAmount: 700_000,
        totalDeductionAmount: 200_000,
        netPayAmount: 2_900_000,
        status: 'REVIEWING',
      },
      // 수정값이 계산값보다 먼저, 식대 항목은 기본급이 아니다
      {
        payslipId: payslipIds.sent,
        periodStartDate: start(2),
        periodEndDate: end(2),
        basePayAmount: 2_600_000,
        allowanceAmount: 400_000,
        totalDeductionAmount: 200_000,
        netPayAmount: 2_800_000,
        status: 'SENT',
      },
    ]);
    // 작성 중 · 검토 중
    expect(body.unsentCount).toBe(2);
  });

  it('급여명세서 — 기본급 계산값이 있어도 넣지 않은 줄이면 기본급 null, 수당은 지급 총액 그대로', async () => {
    const res = await get(`/staff-members/${draftId}/summary/payslips`);
    expect(res.status).toBe(200);
    const body = res.body as StaffMemberPayslipSummaryResponseDto;
    expect(body.recent).toEqual([
      expect.objectContaining({
        payslipId: payslipIds.notEntered,
        basePayAmount: null,
        allowanceAmount: 2_000_000,
        status: 'DRAFTING',
      }),
    ]);
    expect(body.unsentCount).toBe(1);
  });

  it('TO-DO — 지운 것 빼고 전체 · 완료 · 미완료와 최근 이력', async () => {
    const res = await get(`/staff-members/${jianId}/summary/todos`);
    expect(res.status).toBe(200);
    const body = res.body as StaffMemberTodoSummaryResponseDto;
    expect(body).toMatchObject({ total: 2, doneCount: 1, notDoneCount: 1 });
    expect(body.recentHistories[0]).toMatchObject({
      title: '냉장고 정리',
      toStatus: 'DONE',
      actor: 'STAFF',
    });
    expect(body.recentHistories).toHaveLength(3);
    expect(body.recentHistories.map((h) => h.title)).not.toContain('지운 것');
  });

  it('영역 메뉴 조회 권한이 없으면 그 영역만 403 「조회 권한이 없습니다.」 — 다른 영역 · 상세는 그대로 200', async () => {
    for (const area of ['contracts', 'work-schedules', 'payslips']) {
      const res = await get(
        `/staff-members/${jianId}/summary/${area}`,
        staffAndTodoId,
      );
      expect([
        area,
        res.status,
        (res.body as { message: string }).message,
      ]).toEqual([area, 403, READ_DENIED_MESSAGE]);
    }
    const todos = await get(
      `/staff-members/${jianId}/summary/todos`,
      staffAndTodoId,
    );
    expect(todos.status).toBe(200);
    expect(todos.body as StaffMemberTodoSummaryResponseDto).toMatchObject({
      total: 2,
    });
    expect((await get(`/staff-members/${jianId}`, staffAndTodoId)).status).toBe(
      200,
    );
  });

  it('TO-DO 관리 조회가 없으면 직원 상세의 TO-DO 칸은 목록 · 요약 모두 403 「조회 권한이 없습니다.」 — 상세는 200', async () => {
    for (const path of [
      `/staff-members/${jianId}/todos`,
      `/staff-members/${jianId}/summary/todos`,
    ]) {
      const res = await get(path, staffOnlyId);
      expect([
        path,
        res.status,
        (res.body as { message: string }).message,
      ]).toEqual([path, 403, READ_DENIED_MESSAGE]);
    }
    expect((await get(`/staff-members/${jianId}`, staffOnlyId)).status).toBe(
      200,
    );
    // TO-DO 관리 조회가 있으면 목록은 그대로 200
    expect(
      (await get(`/staff-members/${jianId}/todos`, staffAndTodoId)).status,
    ).toBe(200);
  });

  it('영역 권한이 없으면 없는 직원 ID 도 같은 403 — 권한을 범위보다 먼저 본다', async () => {
    const res = await get(
      '/staff-members/2147483646/summary/contracts',
      staffAndTodoId,
    );
    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toBe(READ_DENIED_MESSAGE);
  });

  it('직원 정보 관리 조회 권한이 없으면 영역 메뉴 권한이 있어도 가드가 403', async () => {
    const res = await get(
      `/staff-members/${jianId}/summary/todos`,
      noStaffReadId,
    );
    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toBe(
      ACCESS_DENIED_MESSAGE,
    );
  });

  it.each(AREAS)(
    '%s — 업무 범위 밖(다른 BP) · 본사 역할에게 동의 없는 가맹 점포 직원 · 없는 ID 는 같은 404',
    async (area) => {
      for (const id of [otherBpStaffId, maskedId, 2147483646])
        expect([
          id,
          (await get(`/staff-members/${id}/summary/${area}`)).status,
        ]).toEqual([id, 404]);
    },
  );

  it.each(AREAS)(
    '%s — 본사 제공 동의한 가맹 점포 직원은 BP 마스터에게 200',
    async (area) => {
      const res = await get(`/staff-members/${consentedId}/summary/${area}`);
      expect(res.status).toBe(200);
    },
  );
});
