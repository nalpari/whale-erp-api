import { randomInt } from 'node:crypto';
import ExcelJS from 'exceljs';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { HQ_SHARING_CONSENT_VERSION } from '../src/admin-scope/hq-sharing';
import { hashPassword } from '../src/auth/password';
import type {
  FacilityDetailResponseDto,
  FacilityListResponseDto,
} from '../src/facilities/dto/facility.response.dto';
import { BULK_HEADERS } from '../src/facilities/facility-bulk';
import {
  COMPANY_PHONE_PATTERN,
  PHONE_PATTERN,
} from '../src/facilities/facility-format';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';

const PASSWORD = 'Whale-admin-1';
const PDF = Buffer.from('%PDF-1.4\n%test\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

/**
 * 시설물 및 장비 관리(MN000022, /facilities)를 실제 DB 로 — 메뉴 권한 · 점포 범위 · 공통코드 검증 · 폐점 점포 조회만 ·
 * 낙관적 잠금 · 논리 삭제 · 문서 3종. 저장소(S3)는 메모리 가짜다.
 */
describe('시설물 및 장비 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let bpCodeId: number;
  let bpCode: string;
  let storeId: number;
  let otherStoreId: number;
  /** 다른 BP 와 그 점포 · 시설물 — 격리 확인용 */
  let foreignBpCodeId: number;
  let foreignBpCode: string;
  let foreignStoreId: number;
  let closedStoreId: number;
  let staffMemberId: number;
  let retiredStaffMemberId: number;
  let draftStaffMemberId: number;
  let franchiseStoreId: number;
  let consentedStaffMemberId: number;
  let unconsentedStaffMemberId: number;
  const accountIds: number[] = [];

  /** 가입 완료 직원 — 계정과 함께 만든다. consented 면 본사 제공 동의(지금 버전) */
  const joinedStaff = async (
    store: number,
    name: string,
    {
      employmentStatus = 'EMPLOYED',
      consented = false,
    }: { employmentStatus?: 'EMPLOYED' | 'RETIRED'; consented?: boolean } = {},
  ) => {
    const n = randomInt(10_000_000, 99_999_999);
    const { accountId } = await prisma.account.create({
      data: {
        email: `fac-${n}@test.invalid`,
        passwordHash: '!',
        realName: name,
        birthDate: new Date('1990-01-01'),
        phone: `010${n}`,
        status: 'JOINED',
        ...(consented && {
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: new Date(),
        }),
      },
    });
    accountIds.push(accountId);
    return prisma.staffMember.create({
      data: {
        storeId: store,
        accountId,
        name,
        phone: `010${n}`,
        jobTitle: '홀',
        employmentType: 'PART_TIME',
        joinStatus: 'JOINED',
        employmentStatus,
        // 퇴직이면 퇴직일이 있어야 한다(staff_members_retired_date_required)
        ...(employmentStatus === 'RETIRED' && {
          retiredDate: new Date('2026-10-31'),
        }),
      },
    });
  };
  let emptyRoleGroupId: number;
  const adminIds: number[] = [];
  let bmToken: string;
  /** 일부 점포(storeId)만 맡은 BP 관리자 */
  let baToken: string;
  let pmToken: string;
  let fmToken: string;
  let noMenuToken: string;
  /** 시설물 메뉴에 조회 · 등록만 있는 BP 관리자 */
  let createOnlyRoleGroupId: number;
  let createOnlyToken: string;
  let createOnlyAdminId: number;
  const objects = new Map<string, Buffer>();
  const storage = {
    put: jest.fn((key: string, body: Buffer) => {
      objects.set(key, body);
      return Promise.resolve();
    }),
    delete: jest.fn((key: string) => {
      objects.delete(key);
      return Promise.resolve();
    }),
    downloadUrl: jest.fn((key: string) =>
      Promise.resolve(`https://signed.test/${key}`),
    ),
    thumbnailUrl: jest.fn((key: string) =>
      Promise.resolve(`https://thumb.test/${key}`),
    ),
  };

  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    token = bmToken,
    bp?: number,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);
    return bp === undefined ? req : req.set('X-Bp-Code-Id', String(bp));
  };

  const base = () => ({
    storeId,
    name: 'EK43S 전자동 원두 커피 그라인더',
    facilityStatusCode: 'OPERATING',
    facilityGroupCode: 'STORE_EQUIPMENT',
    facilityCategoryCode: 'GRINDER',
  });
  const create = async (body: object = {}, token = bmToken) =>
    (
      await call('post', '/facilities', token)
        .send({ ...base(), ...body })
        .expect(201)
    ).body as { facilityId: number };
  const detail = async (id: number, token = bmToken) =>
    (await call('get', `/facilities/${id}`, token).expect(200))
      .body as FacilityDetailResponseDto;
  /** 상세를 그대로 돌려보내는 수정 몸통 */
  const formOf = (d: FacilityDetailResponseDto) => ({
    name: d.name,
    facilityStatusCode: d.facilityStatusCode,
    facilityGroupCode: d.facilityGroupCode,
    facilityCategoryCode: d.facilityCategoryCode,
    inspectionCycleCode: d.inspectionCycleCode,
    managerStaffMemberId: d.manager?.staffMemberId ?? null,
    updatedAt: d.updatedAt,
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(STORAGE)
      .useValue(storage)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const n = randomInt(100_000, 999_998);
    bpCode = `BP${n}`;
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode,
        tradeName: '시설물 DB 테스트 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
    // BP 적용을 켠 것처럼 분류 · 점검 주기를 이 BP 로 복사한다 — 하나는 BP 가 이름을 고치고, 하나는 미사용으로 둔다.
    await prisma.codeItem.createMany({
      data: [
        ['STORE_EQUIPMENT', 'GRINDER', '원두 그라인더', 'ACTIVE'],
        ['STORE_EQUIPMENT', 'COFFEE_MACHINE', '커피머신', 'ACTIVE'],
        ['STORE_EQUIPMENT', 'ICE_MAKER', '제빙기', 'INACTIVE'],
        ['STORE_FACILITY', 'HVAC', '냉난방', 'ACTIVE'],
        ['INSPECTION_CYCLE', 'DAILY', '매일', 'ACTIVE'],
        ['INSPECTION_CYCLE', 'MONTHLY', '매월', 'INACTIVE'],
      ].map(([groupCode, itemCode, label, status]) => ({
        groupCode,
        itemCode,
        bpCode,
        label,
        manageOwnerCode: 'PLATFORM_PROVIDED',
        status: status as 'ACTIVE' | 'INACTIVE',
      })),
    });
    const makeStore = async (code: string, status = 'OPERATING') =>
      (
        await prisma.store.create({
          data: {
            storeCode: code,
            bpCodeId,
            storeTypeCode: 'DIRECT',
            name: `시설 ${code}`,
            storeStatusCode: status,
          },
        })
      ).storeId;
    const s = randomInt(100_000, 999_995);
    storeId = await makeStore(`ST${s}`);
    otherStoreId = await makeStore(`ST${s + 1}`);
    closedStoreId = await makeStore(`ST${s + 2}`, 'CLOSED');

    // 다른 BP — 점포 하나와 시설물 하나. 이 BP 의 데이터가 첫 BP 계정에게 보이면 안 된다.
    foreignBpCode = `BP${n + 1}`;
    ({ bpCodeId: foreignBpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: foreignBpCode,
        tradeName: '시설물 DB 테스트 다른 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
    await prisma.codeItem.create({
      data: {
        groupCode: 'STORE_EQUIPMENT',
        itemCode: 'GRINDER',
        bpCode: foreignBpCode,
        label: '그라인더',
        manageOwnerCode: 'PLATFORM_PROVIDED',
      },
    });
    ({ storeId: foreignStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${s + 3}`,
        bpCodeId: foreignBpCodeId,
        storeTypeCode: 'DIRECT',
        name: '다른 BP 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    ({ staffMemberId } = await joinedStaff(storeId, '정하윤'));
    ({ staffMemberId: retiredStaffMemberId } = await joinedStaff(
      storeId,
      '퇴직자',
      { employmentStatus: 'RETIRED' },
    ));
    // 가입 전(초안) 직원 — 계약 삭제 · 대체가 물리 삭제하는 레코드라 담당자로 고를 수 없다
    ({ staffMemberId: draftStaffMemberId } = await prisma.staffMember.create({
      data: {
        storeId,
        name: '가입 전',
        phone: `010${randomInt(10_000_000, 99_999_999)}`,
        jobTitle: '홀',
        employmentType: 'PART_TIME',
      },
    }));
    // 가맹 점포 — 본사 역할(BM · BA)에게 본사 제공 미동의 직원은 가려진다(ATT-30)
    ({ storeId: franchiseStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${s + 4}`,
        bpCodeId,
        storeTypeCode: 'FRANCHISE',
        name: '가맹 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    ({ staffMemberId: consentedStaffMemberId } = await joinedStaff(
      franchiseStoreId,
      '동의 직원',
      { consented: true },
    ));
    ({ staffMemberId: unconsentedStaffMemberId } = await joinedStaff(
      franchiseStoreId,
      '미동의 직원',
    ));

    ({ roleGroupId: emptyRoleGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${n}`,
        bpCodeId,
        roleTypeCode: 'BA',
        name: `메뉴 없음 ${n}`,
      },
    }));
    const platform = await prisma.bpCode.findFirstOrThrow({
      where: { isPlatform: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    const loginAs = async (
      roleTypeCode: string,
      isAllStores: boolean,
      {
        roleCode = 'BM000001',
        roleGroupId,
        bp = bpCodeId,
      }: { roleCode?: string; roleGroupId?: number; bp?: number } = {},
    ) => {
      roleGroupId ??= (
        await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } })
      ).roleGroupId;
      const admin = await prisma.adminAccount.create({
        data: {
          loginId: `fac${randomInt(10_000_000, 99_999_999)}`,
          bpCodeId: bp,
          name: '정하윤',
          passwordHash,
          roleTypeCode,
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(admin.adminAccountId);
      const res = await request(app.getHttpServer())
        .post('/auth/admin/login')
        .send({ loginId: admin.loginId, password: PASSWORD })
        .expect(200);
      return {
        token: (res.body as AdminLoginResponseDto).accessToken,
        adminAccountId: admin.adminAccountId,
      };
    };
    bmToken = (await loginAs('BM', true)).token;
    const ba = await loginAs('BA', false);
    baToken = ba.token;
    await prisma.adminStoreMapping.create({
      data: { adminAccountId: ba.adminAccountId, storeId },
    });
    pmToken = (
      await loginAs('PM', true, { roleCode: 'PM000001', bp: platform.bpCodeId })
    ).token;
    fmToken = (await loginAs('FM', true, { roleCode: 'FM000001' })).token;
    noMenuToken = (await loginAs('BA', true, { roleGroupId: emptyRoleGroupId }))
      .token;
    // 시설물 메뉴에 조회 · 등록만 있는 권한 그룹(수정 · 삭제 없음)
    const facilitiesMenu = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000022' },
    });
    ({ roleGroupId: createOnlyRoleGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${n + 1}`,
        bpCodeId,
        roleTypeCode: 'BA',
        name: `시설물 조회 · 등록만 ${n}`,
      },
    }));
    await prisma.roleGroupMenu.create({
      data: {
        roleGroupId: createOnlyRoleGroupId,
        menuId: facilitiesMenu.menuId,
        isReadable: true,
        isCreatable: true,
      },
    });
    ({ token: createOnlyToken, adminAccountId: createOnlyAdminId } =
      await loginAs('BA', true, { roleGroupId: createOnlyRoleGroupId }));
  });

  afterAll(async () => {
    // bpCodeId 가 없으면(준비 실패) 아무것도 지우지 않는다 — where 의 undefined 는 조건 없음이다.
    if (prisma && bpCodeId !== undefined) {
      const bpIds = [bpCodeId, foreignBpCodeId].filter(
        (id): id is number => id !== undefined,
      );
      const stores = await prisma.store.findMany({
        where: { bpCodeId: { in: bpIds } },
        select: { storeId: true },
      });
      const byStore = { storeId: { in: stores.map((s) => s.storeId) } };
      const byAdmin = { adminAccountId: { in: adminIds } };
      await prisma.facilityDocument.deleteMany({
        where: { facility: byStore },
      });
      await prisma.facility.deleteMany({ where: byStore });
      await prisma.staffMember.deleteMany({ where: byStore });
      await prisma.account.deleteMany({
        where: { accountId: { in: accountIds } },
      });
      await prisma.adminStoreMapping.deleteMany({ where: byStore });
      await prisma.store.deleteMany({ where: byStore });
      await prisma.codeItem.deleteMany({
        where: {
          bpCode: {
            in: [bpCode, foreignBpCode].filter((c) => c !== undefined),
          },
        },
      });
      await prisma.adminLoginLog.deleteMany({ where: byAdmin });
      await prisma.adminSession.deleteMany({ where: byAdmin });
      await prisma.adminAccount.deleteMany({ where: byAdmin });
      const roleGroupIds = [emptyRoleGroupId, createOnlyRoleGroupId].filter(
        (id): id is number => id !== undefined,
      );
      await prisma.roleGroupMenu.deleteMany({
        where: { roleGroupId: { in: roleGroupIds } },
      });
      await prisma.roleGroup.deleteMany({
        where: { roleGroupId: { in: roleGroupIds } },
      });
      await prisma.bpCode.deleteMany({ where: { bpCodeId: { in: bpIds } } });
    }
    await app?.close();
  });

  it('등록하면 상세에 그대로 보이고 총금액은 서버가 단가 × 수량으로 계산한다', async () => {
    const { facilityId } = await create({
      memo: '첫 줄\n둘째 줄',
      brand: '말코닉',
      manufacturer: '말코닉',
      vendorName: '커피상사',
      vendorPhone: '02-2222-8888',
      unitPriceAmount: 10_000_000,
      quantity: 2,
      purchaseDate: '2025-01-01',
      installationDate: '2025-01-03',
      managerStaffMemberId: staffMemberId,
      managerPhone: '01012345678',
      inspectionCycleCode: 'DAILY',
      inspectionNote: '매일 마감 때',
      serviceCenterZipCode: '04522',
      serviceCenterAddress: '서울 중구 삼봉로 98',
      serviceCenterAddressDetail: '1층 2호',
      serviceCenterPhone: '0222228888',
    });
    const d = await detail(facilityId);
    expect(d).toMatchObject({
      facilityId,
      name: 'EK43S 전자동 원두 커피 그라인더',
      store: { storeId, isClosed: false },
      facilityStatusCode: 'OPERATING',
      facilityStatusLabel: '운영',
      facilityGroupCode: 'STORE_EQUIPMENT',
      facilityGroupLabel: '점포 장비',
      facilityCategoryCode: 'GRINDER',
      facilityCategoryLabel: '원두 그라인더',
      isFacilityCategoryActive: true,
      memo: '첫 줄\n둘째 줄',
      vendorPhone: '0222228888',
      unitPriceAmount: 10_000_000,
      quantity: 2,
      totalAmount: 20_000_000,
      isVatIncluded: true,
      purchaseDate: '2025-01-01',
      installationDate: '2025-01-03',
      manager: { staffMemberId, name: '정하윤' },
      managerPhone: '01012345678',
      inspectionCycleCode: 'DAILY',
      inspectionCycleLabel: '매일',
      serviceCenterZipCode: '04522',
      documents: [],
      createdByName: '정하윤',
      updatedByName: null,
    });
  });

  it('목록은 등록일 최신순 · 필터 · 쪽 나눔이고 지운 것은 빠진다', async () => {
    const a = await create({
      name: '목록 냉난방기',
      facilityGroupCode: 'STORE_FACILITY',
      facilityCategoryCode: 'HVAC',
    });
    const b = await create({
      name: '목록 커피머신',
      facilityCategoryCode: 'COFFEE_MACHINE',
      facilityStatusCode: 'STORED',
    });
    const gone = await create({ name: '목록 지울 것' });
    await call('delete', `/facilities/${gone.facilityId}`).expect(204);

    const all = (await call('get', '/facilities?keyword=목록').expect(200))
      .body as FacilityListResponseDto;
    expect(all.total).toBe(2);
    expect(all.items.map((i) => i.facilityId)).toEqual([
      b.facilityId,
      a.facilityId,
    ]);
    expect(all.items[0]).toMatchObject({
      storeId,
      isStoreClosed: false,
      facilityStatusLabel: '보관',
      facilityGroupLabel: '점포 장비',
      facilityCategoryLabel: '커피머신',
    });

    const stored = (
      await call(
        'get',
        '/facilities?keyword=목록&facilityStatusCode=STORED',
      ).expect(200)
    ).body as FacilityListResponseDto;
    expect(stored.items.map((i) => i.facilityId)).toEqual([b.facilityId]);

    const hvac = (
      await call(
        'get',
        '/facilities?keyword=목록&facilityGroupCode=STORE_FACILITY&facilityCategoryCode=HVAC',
      ).expect(200)
    ).body as FacilityListResponseDto;
    expect(hvac.items.map((i) => i.facilityId)).toEqual([a.facilityId]);

    // 분류는 그룹을 골라야 걸 수 있다(PL-3)
    await call('get', '/facilities?facilityCategoryCode=HVAC').expect(400);
    await call('get', '/facilities?pageSize=20').expect(400);
  });

  it('점포 범위 — 일부 점포만 맡은 관리자는 그 점포의 것만 보고 다른 점포에는 등록하지 못한다', async () => {
    const mine = await create({ name: '범위 내 점포' });
    const other = await create({ name: '범위 밖 점포', storeId: otherStoreId });
    const list = (
      await call('get', '/facilities?keyword=범위', baToken).expect(200)
    ).body as FacilityListResponseDto;
    expect(list.items.map((i) => i.facilityId)).toEqual([mine.facilityId]);
    await call('get', `/facilities/${other.facilityId}`, baToken).expect(404);
    await call('post', '/facilities', baToken)
      .send({ ...base(), storeId: otherStoreId })
      .expect(400);
    // 고른 점포로만 좁힌다
    const picked = (
      await call(
        'get',
        `/facilities?keyword=범위&storeIds=${otherStoreId}`,
      ).expect(200)
    ).body as FacilityListResponseDto;
    expect(picked.items.map((i) => i.facilityId)).toEqual([other.facilityId]);
  });

  it('메뉴 권한이 없으면 403, 플랫폼 계정은 BP 를 골라야 한다(400) · 고르면 그 BP 를 본다', async () => {
    await call('get', '/facilities', noMenuToken).expect(403);
    await call('get', '/facilities', pmToken).expect(400);
    const { facilityId } = await create({ name: '플랫폼이 보는 장비' });
    await call('get', `/facilities/${facilityId}`, pmToken, bpCodeId).expect(
      200,
    );
  });

  it('가맹 마스터도 이 메뉴의 등록 · 수정 · 삭제 권한이 있다', async () => {
    const { facilityId } = await create({ name: '가맹 마스터 장비' }, fmToken);
    await call('delete', `/facilities/${facilityId}`, fmToken).expect(204);
  });

  it('공통코드 검증 — 없는 운영상태 · 다른 그룹의 분류 · 미사용 분류 · 미사용 점검 주기는 등록 400', async () => {
    await call('post', '/facilities')
      .send({ ...base(), facilityStatusCode: 'BROKEN' })
      .expect(400);
    await call('post', '/facilities')
      .send({ ...base(), facilityCategoryCode: 'HVAC' })
      .expect(400);
    await call('post', '/facilities')
      .send({ ...base(), facilityCategoryCode: 'ICE_MAKER' })
      .expect(400);
    await call('post', '/facilities')
      .send({ ...base(), inspectionCycleCode: 'MONTHLY' })
      .expect(400);
    // 플랫폼 원본에만 있고 이 BP 로 복사되지 않은 분류(BP 적용 전)도 고를 수 없다
    await call('post', '/facilities')
      .send({
        ...base(),
        facilityGroupCode: 'STORE_FACILITY',
        facilityCategoryCode: 'WATER_SUPPLY',
      })
      .expect(400);
  });

  it('미사용으로 바뀐 분류 · 점검 주기는 지금 값이면 수정에서 그대로 둘 수 있고, 다른 값에서 되돌릴 수는 없다(PL-3 · PL-6)', async () => {
    const { facilityId } = await create({
      name: '미사용 분류 장비',
      facilityCategoryCode: 'COFFEE_MACHINE',
      inspectionCycleCode: 'DAILY',
    });
    // 등록 뒤 BP 가 그 분류를 미사용으로 바꿨다고 친다 — 지금 값을 미사용 코드로 직접 옮긴다.
    await prisma.facility.update({
      where: { facilityId },
      data: {
        facilityCategoryCode: 'ICE_MAKER',
        inspectionCycleCode: 'MONTHLY',
      },
    });
    const d = await detail(facilityId);
    expect(d).toMatchObject({
      facilityCategoryLabel: '제빙기',
      isFacilityCategoryActive: false,
      inspectionCycleLabel: '매월',
      isInspectionCycleActive: false,
    });
    const kept = await call('put', `/facilities/${facilityId}`)
      .send({ ...formOf(d), name: '이름만 바꿈' })
      .expect(200);
    const after = await detail(facilityId);
    expect(after.facilityCategoryCode).toBe('ICE_MAKER');
    expect(after.updatedByName).toBe('정하윤');
    expect((kept.body as { updatedAt: string }).updatedAt).toBe(
      after.updatedAt,
    );
    // 다른 분류로 바꾼 뒤에는 미사용 분류로 되돌릴 수 없다
    await call('put', `/facilities/${facilityId}`)
      .send({ ...formOf(after), facilityCategoryCode: 'GRINDER' })
      .expect(200);
    await call('put', `/facilities/${facilityId}`)
      .send({
        ...formOf(await detail(facilityId)),
        facilityCategoryCode: 'ICE_MAKER',
      })
      .expect(400);
  });

  it('설치일이 구매일보다 앞서면 400 · A/S센터 상세주소만 있으면 400', async () => {
    const res = await call('post', '/facilities')
      .send({
        ...base(),
        purchaseDate: '2025-01-03',
        installationDate: '2025-01-01',
      })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      '설치일은 구매일보다 앞설 수 없습니다.',
    );
    await call('post', '/facilities')
      .send({ ...base(), serviceCenterAddressDetail: '1층' })
      .expect(400);
  });

  it('관리 담당자는 그 점포의 재직 직원만 — 퇴직자 · 다른 점포 직원은 400, 선택지에도 재직자만', async () => {
    await call('post', '/facilities')
      .send({ ...base(), managerStaffMemberId: retiredStaffMemberId })
      .expect(400);
    await call('post', '/facilities')
      .send({
        ...base(),
        storeId: otherStoreId,
        managerStaffMemberId: staffMemberId,
      })
      .expect(400);
    const options = (
      await call(
        'get',
        `/facilities/manager-options?storeId=${storeId}`,
      ).expect(200)
    ).body as {
      items: { staffMemberId: number; name: string; phone: string }[];
    };
    expect(options.items.map((i) => i.staffMemberId)).toEqual([staffMemberId]);
    expect(options.items[0].phone).toMatch(/^010\d{8}$/);
    await call(
      'get',
      `/facilities/manager-options?storeId=${otherStoreId}`,
      baToken,
    ).expect(404);
  });

  it('점포 선택지 — 등록은 폐점 점포를 빼고, 목록 필터용(includeClosed)은 넣는다', async () => {
    const forForm = (await call('get', '/facilities/store-options').expect(200))
      .body as { items: { storeId: number }[] };
    expect(forForm.items.map((s) => s.storeId)).not.toContain(closedStoreId);
    expect(forForm.items.map((s) => s.storeId)).toEqual(
      expect.arrayContaining([storeId, otherStoreId]),
    );
    const forFilter = (
      await call('get', '/facilities/store-options?includeClosed=true').expect(
        200,
      )
    ).body as { items: { storeId: number; storeStatusCode: string }[] };
    expect(forFilter.items.map((s) => s.storeId)).toContain(closedStoreId);
  });

  it('폐점 점포 — 등록 400, 이미 있는 것은 조회만(수정 · 삭제 · 문서 409)', async () => {
    await call('post', '/facilities')
      .send({ ...base(), storeId: closedStoreId })
      .expect(400);
    const row = await prisma.facility.create({
      data: {
        storeId: closedStoreId,
        name: '폐점 점포 장비',
        facilityStatusCode: 'OPERATING',
        facilityGroupCode: 'STORE_EQUIPMENT',
        facilityCategoryCode: 'GRINDER',
        createdBy: adminIds[0],
      },
    });
    const d = await detail(row.facilityId);
    expect(d.store.isClosed).toBe(true);
    await call('put', `/facilities/${row.facilityId}`)
      .send(formOf(d))
      .expect(409);
    await call('delete', `/facilities/${row.facilityId}`).expect(409);
    await call('put', `/facilities/${row.facilityId}/documents/USER_MANUAL`)
      .attach('file', PDF, 'manual.pdf')
      .expect(409);
    await call(
      'delete',
      `/facilities/${row.facilityId}/documents/WARRANTY`,
    ).expect(409);
    const list = (
      await call('get', '/facilities?keyword=폐점 점포').expect(200)
    ).body as FacilityListResponseDto;
    expect(list.items[0].isStoreClosed).toBe(true);
  });

  it('동시 수정 — 상세의 updatedAt 이 지금과 다르면 409', async () => {
    const { facilityId } = await create({ name: '동시 수정' });
    const d = await detail(facilityId);
    await call('put', `/facilities/${facilityId}`)
      .send({ ...formOf(d), name: '먼저' })
      .expect(200);
    await call('put', `/facilities/${facilityId}`)
      .send({ ...formOf(d), name: '나중' })
      .expect(409);
  });

  it('수정은 화면 전체를 다시 보낸다 — 빠진 선택 칸은 지운다(관리 정보는 칸을 비워 저장, PL-4)', async () => {
    const { facilityId } = await create({
      name: '비우기',
      brand: '말코닉',
      unitPriceAmount: 1000,
      quantity: 3,
    });
    const d = await detail(facilityId);
    await call('put', `/facilities/${facilityId}`).send(formOf(d)).expect(200);
    const after = await detail(facilityId);
    expect(after).toMatchObject({
      brand: null,
      unitPriceAmount: null,
      totalAmount: null,
      quantity: 1,
    });
  });

  it('문서 — 종류마다 하나, JPG · PNG · PDF, 바꾸면 옛 것은 지움 표시, 빼면 상세에서 사라진다', async () => {
    const { facilityId } = await create({ name: '문서 장비' });
    const first = await call(
      'put',
      `/facilities/${facilityId}/documents/USER_MANUAL`,
    )
      .attach('file', PDF, 'EK43S_사용매뉴얼.pdf')
      .expect(200);
    expect(first.body).toMatchObject({
      documentKind: 'USER_MANUAL',
      fileName: 'EK43S_사용매뉴얼.pdf',
      fileType: 'PDF',
    });
    await call('put', `/facilities/${facilityId}/documents/USER_MANUAL`)
      .attach('file', PNG, '매뉴얼.png')
      .expect(200);
    await call('put', `/facilities/${facilityId}/documents/WARRANTY`)
      .attach('file', PDF, '보증서.pdf')
      .expect(200);
    await call('put', `/facilities/${facilityId}/documents/PRECAUTION`)
      .attach('file', Buffer.from('not a file'), '주의사항.hwp')
      .expect(400);
    await call('put', `/facilities/${facilityId}/documents/INVOICE`)
      .attach('file', PDF, 'x.pdf')
      .expect(404);

    let d = await detail(facilityId);
    expect(d.documents.map((x) => [x.documentKind, x.fileName])).toEqual([
      ['USER_MANUAL', '매뉴얼.png'],
      ['WARRANTY', '보증서.pdf'],
    ]);
    expect(d.documents[0].downloadUrl).toMatch(
      /^https:\/\/signed\.test\/facilities\//,
    );
    expect(d.documents[0].thumbnailUrl).toMatch(/^https:\/\/thumb\.test\//);
    expect(d.documents[1].thumbnailUrl).toBeNull();
    expect(
      await prisma.facilityDocument.count({
        where: { facilityId, documentKind: 'USER_MANUAL' },
      }),
    ).toBe(2);

    await call('delete', `/facilities/${facilityId}/documents/WARRANTY`).expect(
      204,
    );
    d = await detail(facilityId);
    expect(d.documents.map((x) => x.documentKind)).toEqual(['USER_MANUAL']);
  });

  it('삭제하면 목록 · 상세에서 빠지고(논리 삭제) 문서도 함께 지움 표시한다', async () => {
    const { facilityId } = await create({ name: '삭제할 장비' });
    await call('put', `/facilities/${facilityId}/documents/WARRANTY`)
      .attach('file', PDF, '보증서.pdf')
      .expect(200);
    await call('delete', `/facilities/${facilityId}`).expect(204);
    await call('get', `/facilities/${facilityId}`).expect(404);
    await call('delete', `/facilities/${facilityId}`).expect(404);
    const row = await prisma.facility.findUniqueOrThrow({
      where: { facilityId },
    });
    expect(row.isDeleted).toBe(true);
    expect(
      await prisma.facilityDocument.count({
        where: { facilityId, isDeleted: false },
      }),
    ).toBe(0);
  });

  it('총금액 CHECK — 한쪽만 NULL 이거나 단가 × 수량과 다르면 DB 가 막는다', async () => {
    const { facilityId } = await create({
      name: 'CHECK 장비',
      unitPriceAmount: 5,
      quantity: 2,
    });
    const set = (data: {
      unitPriceAmount?: number | null;
      totalAmount: number | null;
    }) => prisma.facility.update({ where: { facilityId }, data });
    await expect(set({ totalAmount: null })).rejects.toThrow(
      /facilities_total_amount_product/,
    );
    await expect(
      set({ unitPriceAmount: null, totalAmount: 10 }),
    ).rejects.toThrow(/facilities_total_amount_product/);
    await expect(set({ totalAmount: 11 })).rejects.toThrow(
      /facilities_total_amount_product/,
    );
    await expect(
      set({ unitPriceAmount: null, totalAmount: null }),
    ).resolves.toBeDefined();
  });

  it('대표번호(15xx · 16xx · 18xx 8자리) — 구매처 · A/S센터는 API 로 저장되고, 사람 번호 칸은 API 400', async () => {
    const { facilityId } = await create({
      name: '대표번호 장비',
      vendorPhone: '1588-1234',
      serviceCenterPhone: '1644-0000',
    });
    expect(await detail(facilityId)).toMatchObject({
      vendorPhone: '15881234',
      serviceCenterPhone: '16440000',
    });
    await call('post', '/facilities', bmToken)
      .send({ ...base(), managerPhone: '1588-1234' })
      .expect(400);
  });

  it('전화번호 CHECK 는 칸마다 API 패턴과 같다 — 구매처 · A/S센터는 COMPANY_PHONE_PATTERN, 영업사원 · 관리 담당자는 PHONE_PATTERN', async () => {
    const { facilityId } = await create({ name: '전화 CHECK 장비' });
    const samples = [
      '15881234',
      '16440000',
      '18001234',
      '12345678',
      '17001234',
      '19001234',
      '13001234',
      '1588123',
      '158812345',
      '0212345678',
      '050712345678',
      '0505123456789',
    ];
    const columns = {
      vendorPhone: COMPANY_PHONE_PATTERN,
      serviceCenterPhone: COMPANY_PHONE_PATTERN,
      salesRepresentativePhone: PHONE_PATTERN,
      managerPhone: PHONE_PATTERN,
    };
    const mismatches: string[] = [];
    for (const [column, pattern] of Object.entries(columns))
      for (const value of samples) {
        const expected = pattern.test(value);
        const stored = await prisma.facility
          .update({ where: { facilityId }, data: { [column]: value } })
          .then(
            () => true,
            (e: Error) => {
              if (!/facilities_phone_format/.test(e.message)) throw e;
              return false;
            },
          );
        if (stored !== expected)
          mismatches.push(
            `${column}=${value}: API ${String(expected)} · DB ${String(stored)}`,
          );
      }
    expect(mismatches).toEqual([]);
  });

  it('다른 BP 격리 — 다른 BP 의 시설물 · 점포는 어느 경로로도 보이지 않고 고칠 수 없다', async () => {
    const foreign = await prisma.facility.create({
      data: {
        storeId: foreignStoreId,
        name: '다른 BP 장비',
        facilityStatusCode: 'OPERATING',
        facilityGroupCode: 'STORE_EQUIPMENT',
        facilityCategoryCode: 'GRINDER',
        createdBy: adminIds[0],
      },
    });
    const id = foreign.facilityId;
    await call('get', `/facilities/${id}`).expect(404);
    await call('put', `/facilities/${id}`)
      .send({
        ...base(),
        storeId: undefined,
        updatedAt: foreign.updatedAt.toISOString(),
      })
      .expect(404);
    await call('delete', `/facilities/${id}`).expect(404);
    await call('put', `/facilities/${id}/documents/USER_MANUAL`)
      .attach('file', PDF, 'm.pdf')
      .expect(404);
    await call('delete', `/facilities/${id}/documents/USER_MANUAL`).expect(404);

    // 키워드 없이 · 그 점포를 골라도 목록에 없다
    const all = (await call('get', '/facilities?pageSize=100').expect(200))
      .body as FacilityListResponseDto;
    expect(all.items.map((i) => i.facilityId)).not.toContain(id);
    const picked = (
      await call('get', `/facilities?storeIds=${foreignStoreId}`).expect(200)
    ).body as FacilityListResponseDto;
    expect(picked).toEqual({ items: [], total: 0 });

    const stores = (
      await call('get', '/facilities/store-options?includeClosed=true').expect(
        200,
      )
    ).body as { items: { storeId: number }[] };
    expect(stores.items.map((s) => s.storeId)).not.toContain(foreignStoreId);
    await call(
      'get',
      `/facilities/manager-options?storeId=${foreignStoreId}`,
    ).expect(404);
    await call('post', '/facilities')
      .send({ ...base(), storeId: foreignStoreId })
      .expect(400);

    // 플랫폼 계정은 고른 BP 만 본다 — 다른 BP 를 고르면 첫 BP 의 시설물은 404
    const mine = await create({ name: '첫 BP 장비' });
    await call(
      'get',
      `/facilities/${mine.facilityId}`,
      pmToken,
      foreignBpCodeId,
    ).expect(404);
    await call('get', `/facilities/${id}`, pmToken, foreignBpCodeId).expect(
      200,
    );
  });

  it('플랫폼 계정의 등록 — 고른 BP 의 공통코드 행으로 분류를 본다', async () => {
    // 플랫폼 원본에만 있는 분류(이 BP 로 복사 안 됨)는 400
    await call('post', '/facilities', pmToken, bpCodeId)
      .send({
        ...base(),
        facilityGroupCode: 'STORE_FACILITY',
        facilityCategoryCode: 'WATER_SUPPLY',
      })
      .expect(400);
    const { facilityId } = (
      await call('post', '/facilities', pmToken, bpCodeId)
        .send({ ...base(), name: '플랫폼이 등록' })
        .expect(201)
    ).body as { facilityId: number };
    const d = await detail(facilityId);
    expect(d.facilityCategoryLabel).toBe('원두 그라인더');
  });

  it('수정에서 지금 담당자는 그 사이 퇴직했어도 그대로 둘 수 있고, 다른 담당자에서 퇴직자로 되돌릴 수는 없다(PL-6)', async () => {
    const leaving = await joinedStaff(storeId, '곧 퇴직');
    const { facilityId } = await create({
      name: '담당자 퇴직 장비',
      managerStaffMemberId: leaving.staffMemberId,
    });
    await prisma.staffMember.update({
      where: { staffMemberId: leaving.staffMemberId },
      data: {
        employmentStatus: 'RETIRED',
        retiredDate: new Date('2026-11-01'),
      },
    });
    const d = await detail(facilityId);
    expect(d.manager).toEqual({
      staffMemberId: leaving.staffMemberId,
      name: '곧 퇴직',
    });
    await call('put', `/facilities/${facilityId}`)
      .send({ ...formOf(d), name: '이름만 바꿈' })
      .expect(200);
    await call('put', `/facilities/${facilityId}`)
      .send({
        ...formOf(await detail(facilityId)),
        managerStaffMemberId: staffMemberId,
      })
      .expect(200);
    await call('put', `/facilities/${facilityId}`)
      .send({
        ...formOf(await detail(facilityId)),
        managerStaffMemberId: leaving.staffMemberId,
      })
      .expect(400);
    // 담당자를 비워도 되고, 담당자 없이 전화번호만 둘 수도 있다(2026-11-11 사용자 결정)
    await call('put', `/facilities/${facilityId}`)
      .send({
        ...formOf(await detail(facilityId)),
        managerStaffMemberId: null,
        managerPhone: '0212345678',
      })
      .expect(200);
    expect(await detail(facilityId)).toMatchObject({
      manager: null,
      managerPhone: '0212345678',
    });
  });

  it('일부 점포만 맡은 관리자 — 범위 밖 시설물의 수정 · 삭제 · 문서는 404, 점포 선택지는 맡은 점포만', async () => {
    const other = await create({ name: 'BA 범위 밖', storeId: otherStoreId });
    const d = await detail(other.facilityId);
    await call('put', `/facilities/${other.facilityId}`, baToken)
      .send(formOf(d))
      .expect(404);
    await call('delete', `/facilities/${other.facilityId}`, baToken).expect(
      404,
    );
    await call(
      'put',
      `/facilities/${other.facilityId}/documents/USER_MANUAL`,
      baToken,
    )
      .attach('file', PDF, 'm.pdf')
      .expect(404);
    await call(
      'delete',
      `/facilities/${other.facilityId}/documents/USER_MANUAL`,
      baToken,
    ).expect(404);
    const options = (
      await call(
        'get',
        '/facilities/store-options?includeClosed=true',
        baToken,
      ).expect(200)
    ).body as { items: { storeId: number }[] };
    expect(options.items.map((s) => s.storeId)).toEqual([storeId]);
  });

  it('가입 전 직원은 담당자로 고를 수 없다 — 계약 삭제가 지우는 레코드라 담당자 외래키가 그 삭제를 막지 않게', async () => {
    const options = (
      await call(
        'get',
        `/facilities/manager-options?storeId=${storeId}`,
      ).expect(200)
    ).body as { items: { staffMemberId: number }[] };
    expect(options.items.map((i) => i.staffMemberId)).not.toContain(
      draftStaffMemberId,
    );
    await call('post', '/facilities')
      .send({ ...base(), managerStaffMemberId: draftStaffMemberId })
      .expect(400);
    // 시설물이 가리키지 않으므로 계약 삭제 경로의 물리 삭제가 외래키에 막히지 않는다
    await expect(
      prisma.staffMember.delete({
        where: { staffMemberId: draftStaffMemberId },
      }),
    ).resolves.toBeDefined();
  });

  it('본사 역할(BM)에게 가맹 점포의 본사 제공 미동의 직원은 가려진다 — 선택지 · 등록 · 상세(ATT-30)', async () => {
    const forBm = (
      await call(
        'get',
        `/facilities/manager-options?storeId=${franchiseStoreId}`,
      ).expect(200)
    ).body as { items: { staffMemberId: number }[] };
    expect(forBm.items.map((i) => i.staffMemberId)).toEqual([
      consentedStaffMemberId,
    ]);
    // 가맹 마스터는 자기 직원이라 모두 본다
    const forFm = (
      await call(
        'get',
        `/facilities/manager-options?storeId=${franchiseStoreId}`,
        fmToken,
      ).expect(200)
    ).body as { items: { staffMemberId: number }[] };
    expect(
      forFm.items.map((i) => i.staffMemberId).sort((a, b) => a - b),
    ).toEqual(
      [consentedStaffMemberId, unconsentedStaffMemberId].sort((a, b) => a - b),
    );

    const franchiseBase = {
      ...base(),
      storeId: franchiseStoreId,
      name: '가맹 점포 장비',
    };
    await call('post', '/facilities')
      .send({
        ...franchiseBase,
        managerStaffMemberId: unconsentedStaffMemberId,
      })
      .expect(400);

    // 가맹 마스터가 미동의 직원을 담당자로 등록하면, 본사에게는 이름 · 번호가 가려진다
    const { facilityId } = (
      await call('post', '/facilities', fmToken)
        .send({
          ...franchiseBase,
          managerStaffMemberId: unconsentedStaffMemberId,
          managerPhone: '01099998888',
        })
        .expect(201)
    ).body as { facilityId: number };
    const hidden = await detail(facilityId);
    expect(hidden).toMatchObject({
      manager: { staffMemberId: unconsentedStaffMemberId, name: null },
      managerPhone: null,
      isManagerHidden: true,
    });
    expect(await detail(facilityId, fmToken)).toMatchObject({
      manager: { name: '미동의 직원' },
      managerPhone: '01099998888',
      isManagerHidden: false,
    });

    // 본사가 담당자를 그대로 두고 다른 칸만 고치면 — 화면은 번호를 받지 못해 비워 보낸다 — 저장된 번호를 지킨다
    await call('put', `/facilities/${facilityId}`)
      .send({
        ...formOf(hidden),
        name: '본사가 이름만 고침',
        managerPhone: null,
      })
      .expect(200);
    expect(await detail(facilityId, fmToken)).toMatchObject({
      name: '본사가 이름만 고침',
      manager: { staffMemberId: unconsentedStaffMemberId },
      managerPhone: '01099998888',
    });
  });

  it('미사용이 된 운영상태도 지금 값이면 수정에서 그대로 둘 수 있다', async () => {
    const { facilityId } = await create({
      name: '보관 장비',
      facilityStatusCode: 'STORED',
    });
    await prisma.codeItem.update({
      where: {
        groupCode_itemCode_bpCode: {
          groupCode: 'FACILITY_STATUS',
          itemCode: 'STORED',
          bpCode: 'BP000000',
        },
      },
      data: { status: 'INACTIVE' },
    });
    try {
      const d = await detail(facilityId);
      expect(d.isFacilityStatusActive).toBe(false);
      await call('put', `/facilities/${facilityId}`)
        .send({ ...formOf(d), name: '메모만 고침' })
        .expect(200);
      // 다른 값에서 미사용 값으로는 못 돌아간다
      await call('post', '/facilities')
        .send({ ...base(), facilityStatusCode: 'STORED' })
        .expect(400);
    } finally {
      await prisma.codeItem.update({
        where: {
          groupCode_itemCode_bpCode: {
            groupCode: 'FACILITY_STATUS',
            itemCode: 'STORED',
            bpCode: 'BP000000',
          },
        },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('등록 권한만 있으면 직접 등록한 시설물에 처음 올리는 문서만 — 교체 · 남의 시설물은 403(수정 권한)', async () => {
    const mine = (
      await call('post', '/facilities', createOnlyToken)
        .send({ ...base(), name: '등록 권한 장비' })
        .expect(201)
    ).body as { facilityId: number };
    expect(
      (
        await prisma.facility.findUniqueOrThrow({
          where: { facilityId: mine.facilityId },
        })
      ).createdBy,
    ).toBe(createOnlyAdminId);
    // 등록 화면 흐름 — 방금 등록한 시설물에 처음 올리기
    await call(
      'put',
      `/facilities/${mine.facilityId}/documents/WARRANTY`,
      createOnlyToken,
    )
      .attach('file', PDF, '보증서.pdf')
      .expect(200);
    // 이미 있는 문서를 바꾸는 것은 수정이다
    await call(
      'put',
      `/facilities/${mine.facilityId}/documents/WARRANTY`,
      createOnlyToken,
    )
      .attach('file', PDF, '보증서2.pdf')
      .expect(403);
    await call(
      'delete',
      `/facilities/${mine.facilityId}/documents/WARRANTY`,
      createOnlyToken,
    ).expect(403);
    // 남이 등록한 시설물에는 처음 올리는 문서도 안 된다
    const others = await create({ name: '남이 등록한 장비' });
    await call(
      'put',
      `/facilities/${others.facilityId}/documents/USER_MANUAL`,
      createOnlyToken,
    )
      .attach('file', PDF, '매뉴얼.pdf')
      .expect(403);
    const d = await detail(mine.facilityId);
    expect(d.documents.map((x) => [x.documentKind, x.fileName])).toEqual([
      ['WARRANTY', '보증서.pdf'],
    ]);
  });

  it('범위 밖 id 는 DB 에 묻지 않고 404', async () => {
    await call('get', '/facilities/2147483648').expect(404);
    await call('get', '/facilities/abc').expect(404);
  });

  describe('엑셀 일괄 등록(PL-7)', () => {
    const LABELS: string[] = BULK_HEADERS.map((h) => h.label);
    const codeOf = async (id: number) =>
      (
        await prisma.store.findUniqueOrThrow({
          where: { storeId: id },
          select: { storeCode: true },
        })
      ).storeCode;
    const sheet = async (rows: Record<string, string>[]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('시설물·장비');
      ws.addRow(LABELS);
      for (const r of rows) ws.addRow(LABELS.map((l) => r[l] ?? null));
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    const binary = (req: request.Test) =>
      req.buffer(true).parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    const load = async (buffer: Buffer) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      return wb;
    };
    type Preview = {
      totalCount: number;
      validCount: number;
      errorCount: number;
      columns: { key: string; label: string }[];
      rows: {
        rowNumber: number;
        isValid: boolean;
        values: Record<string, string>;
        errors: string[];
      }[];
    };
    const line = (store: string, over: Record<string, string> = {}) => ({
      '점포*': store,
      '시설물/장비명*': '일괄 그라인더',
      '운영상태*': '운영',
      '그룹*': '점포 장비',
      '분류*': '원두 그라인더',
      ...over,
    });
    const countOf = (name: string) =>
      prisma.facility.count({ where: { name, isDeleted: false } });

    it('양식 — xlsx 로 내려오고, 둘째 시트는 범위 안 열린 점포 · 분류 드롭다운은 그 BP 의 사용 중인 분류', async () => {
      const res = await binary(call('get', '/facilities/bulk-template'));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(res.headers['content-disposition']).toContain(
        encodeURIComponent('시설물장비_일괄등록_양식.xlsx'),
      );
      const wb = await load(res.body as Buffer);
      expect((wb.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual(
        LABELS,
      );
      // 첫 열은 점포 드롭다운 값 「점포명 [점포코드]」
      const mine = await codeOf(storeId);
      expect(wb.worksheets[1].getColumn(1).values.slice(2)).toContain(
        `시설 ${mine} [${mine}]`,
      );
      const codes = wb.worksheets[1].getColumn(2).values.slice(2);
      expect(codes).toEqual(
        expect.arrayContaining([
          await codeOf(storeId),
          await codeOf(otherStoreId),
          await codeOf(franchiseStoreId),
        ]),
      );
      expect(codes).not.toContain(await codeOf(closedStoreId));
      expect(codes).not.toContain(await codeOf(foreignStoreId));
      const choices = wb.worksheets[2];
      expect(choices.state).toBe('hidden');
      // 드롭다운 값은 「코드명 [코드값]」 — 코드명만 떼어 본다
      const categoryValues = choices.getColumn(3).values.slice(2).map(String);
      for (const v of categoryValues) expect(v).toMatch(/ \[[A-Z0-9_]+\]$/);
      const categories = categoryValues.map((v) =>
        v.replace(/ \[[A-Z0-9_]+\]$/, ''),
      );
      expect(categories).toEqual(
        expect.arrayContaining(['원두 그라인더', '커피머신', '냉난방']),
      );
      expect(categories).not.toContain('제빙기'); // 이 BP 에서 미사용
    });

    it('미리보기 — 줄마다 결과와 「칸: 사유」, 저장하지 않는다', async () => {
      const ok = await codeOf(storeId);
      const res = await call('post', '/facilities/bulk-validations')
        .attach(
          'file',
          await sheet([
            line(ok, {
              '시설물/장비명*': '미리보기만',
              단가: '1,000',
              수량: '2',
            }),
            line(await codeOf(closedStoreId)),
            line(await codeOf(foreignStoreId)),
            line(ok, {
              '분류*': '제빙기',
              설치일: '2026-01-01',
              구매일: '2026-02-01',
            }),
          ]),
          '시설물.xlsx',
        )
        .expect(200);
      const body = res.body as Preview;
      expect(body).toMatchObject({
        totalCount: 4,
        validCount: 1,
        errorCount: 3,
      });
      expect(body.columns.map((c) => c.label)).toEqual([
        '점포',
        '그룹',
        '분류',
        '시설물/장비명',
        '구매일',
        '설치일',
      ]);
      expect(body.rows.map((r) => [r.rowNumber, r.isValid, r.errors])).toEqual([
        [2, true, []],
        [3, false, ['점포: 폐점 점포에는 등록할 수 없습니다.']],
        [4, false, ['점포: 관리하는 점포가 아닙니다.']],
        [
          5,
          false,
          [
            '분류: 「점포 장비」에 없는 분류입니다.',
            '설치일: 구매일보다 앞설 수 없습니다.',
          ],
        ],
      ]);
      expect(body.rows[0].values).toMatchObject({
        storeName: `시설 ${ok}`,
        group: '점포 장비',
        category: '원두 그라인더',
      });
      expect(await countOf('미리보기만')).toBe(0);
    });

    it('오류 파일 — 올린 파일 끝에 「오류 사유」, 이름은 「올린파일이름_오류.xlsx」', async () => {
      const res = await binary(
        call('post', '/facilities/bulk-error-file').attach(
          'file',
          await sheet([line(await codeOf(storeId)), line('ST000000')]),
          '내 목록.xlsx',
        ),
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain(
        encodeURIComponent('내 목록_오류.xlsx'),
      );
      const ws = (await load(res.body as Buffer)).worksheets[0];
      expect(ws.getCell(1, 25).value).toBe('오류 사유');
      expect(ws.getCell(2, 25).value ?? null).toBeNull();
      expect(ws.getCell(3, 25).value).toBe('점포: 관리하는 점포가 아닙니다.');
    });

    it('등록 — 오류가 한 줄이라도 있으면 하나도 넣지 않고 400', async () => {
      await call('post', '/facilities/bulk')
        .attach(
          'file',
          await sheet([
            line(await codeOf(storeId), { '시설물/장비명*': '섞인 파일' }),
            line(await codeOf(closedStoreId), {
              '시설물/장비명*': '섞인 파일',
            }),
          ]),
          'a.xlsx',
        )
        .expect(400)
        .expect((r) =>
          expect((r.body as { message: string }).message).toBe(
            '오류를 고친 파일을 다시 올려 주세요.',
          ),
        );
      expect(await countOf('섞인 파일')).toBe(0);
    });

    it('등록 — 모두 정상이면 201 · 건수, 목록 · 상세에 보이고 등록자와 총금액이 남는다', async () => {
      const res = await call('post', '/facilities/bulk')
        .attach(
          'file',
          await sheet([
            line(await codeOf(storeId), {
              '시설물/장비명*': '일괄 등록 A',
              단가: '1500000',
              수량: '3',
              '부가세 포함(Y/N)': 'N',
              '점검 주기': '매일',
              '구매처 전화번호': '02-123-4567',
              메모: '첫 줄\n둘째 줄',
            }),
            // 드롭다운 값 「점포명 [점포코드]」 그대로
            line(`가맹 점포 [${await codeOf(franchiseStoreId)}]`, {
              '시설물/장비명*': '일괄 등록 B',
              '그룹*': '점포 시설물',
              '분류*': '냉난방',
              '운영상태*': '보관',
            }),
          ]),
          'ok.xlsx',
        )
        .expect(201);
      expect(res.body).toEqual({ createdCount: 2 });
      const [a] = await prisma.facility.findMany({
        where: { name: '일괄 등록 A' },
      });
      const d = await detail(a.facilityId);
      expect(d).toMatchObject({
        facilityGroupCode: 'STORE_EQUIPMENT',
        facilityCategoryCode: 'GRINDER',
        unitPriceAmount: 1_500_000,
        quantity: 3,
        totalAmount: 4_500_000,
        isVatIncluded: false,
        inspectionCycleCode: 'DAILY',
        vendorPhone: '021234567',
        memo: '첫 줄\n둘째 줄',
        manager: null,
      });
      expect(d.createdByName).toBe('정하윤');
      const b = await prisma.facility.findFirstOrThrow({
        where: { name: '일괄 등록 B' },
      });
      expect(b).toMatchObject({
        storeId: franchiseStoreId,
        facilityStatusCode: 'STORED',
        facilityCategoryCode: 'HVAC',
        quantity: 1,
        isVatIncluded: true,
      });
    });

    it('파일 검사 — 양식이 아니면 · 내용이 없으면 · 파일이 없으면 400', async () => {
      const message = async (req: request.Test) =>
        ((await req.expect(400)).body as { message: string }).message;
      expect(
        await message(
          call('post', '/facilities/bulk-validations').attach(
            'file',
            PDF,
            'a.xlsx',
          ),
        ),
      ).toBe('내려받은 양식으로 작성한 파일만 올릴 수 있습니다.');
      expect(
        await message(
          call('post', '/facilities/bulk-validations').attach(
            'file',
            await sheet([]),
            'a.xlsx',
          ),
        ),
      ).toBe('등록할 시설물·장비가 없습니다.');
      expect(await message(call('post', '/facilities/bulk-validations'))).toBe(
        '올릴 파일을 선택해 주세요.',
      );
    });

    it('권한 · 범위 — 메뉴 권한 없으면 403, 플랫폼은 BP 를 골라야(400), 일부 점포만 맡으면 다른 점포는 범위 밖', async () => {
      const file = await sheet([line(await codeOf(otherStoreId))]);
      await call('get', '/facilities/bulk-template', noMenuToken).expect(403);
      await call('post', '/facilities/bulk', noMenuToken)
        .attach('file', file, 'a.xlsx')
        .expect(403);
      await call('get', '/facilities/bulk-template', pmToken).expect(400);
      await binary(
        call('get', '/facilities/bulk-template', pmToken, bpCodeId),
      ).expect(200);
      const res = await call('post', '/facilities/bulk-validations', baToken)
        .attach('file', file, 'a.xlsx')
        .expect(200);
      expect((res.body as Preview).rows[0].errors).toEqual([
        '점포: 관리하는 점포가 아닙니다.',
      ]);
      // 등록 권한만 있어도 일괄 등록은 된다
      await call('post', '/facilities/bulk', createOnlyToken)
        .attach(
          'file',
          await sheet([
            line(await codeOf(storeId), { '시설물/장비명*': '등록 권한만' }),
          ]),
          'a.xlsx',
        )
        .expect(201);
    });

    it('날짜 4종과 경계값(단가 10자리 × 수량 9,999 · 이모지 100자 · 메모 200자 · 전화 12자리)이 DB 에 그대로 저장된다', async () => {
      const name = '🧊'.repeat(100);
      const memo = `첫 줄\n${'가'.repeat(196)}`;
      await call('post', '/facilities/bulk')
        .attach(
          'file',
          await sheet([
            line(await codeOf(storeId), {
              '시설물/장비명*': name,
              단가: '9,999,999,999',
              수량: '9,999',
              구매일: '2026-01-31',
              설치일: '2026-02-01',
              '사용 유효기한': '2030-12-31',
              '품질 보증기한': '2028-02-29',
              메모: memo,
              영업사원: '영'.repeat(50),
              '영업사원 전화번호': '0505-1234-5678',
              'A/S센터 전화번호': '050512345678',
            }),
          ]),
          'edge.xlsx',
        )
        .expect(201);
      const row = await prisma.facility.findFirstOrThrow({ where: { name } });
      const d = await detail(row.facilityId);
      expect(d).toMatchObject({
        name,
        memo,
        unitPriceAmount: 9_999_999_999,
        quantity: 9_999,
        totalAmount: 9_999_999_999 * 9_999,
        purchaseDate: '2026-01-31',
        installationDate: '2026-02-01',
        usageExpiryDate: '2030-12-31',
        warrantyExpiryDate: '2028-02-29',
        salesRepresentativeName: '영'.repeat(50),
        salesRepresentativePhone: '050512345678',
        serviceCenterPhone: '050512345678',
      });
    });

    it('미리보기 뒤 점포가 폐점 · 삭제되면 등록은 400 이고 아무것도 넣지 않는다', async () => {
      const code = `ST${randomInt(100_000, 999_999)}`;
      const { storeId: tempStoreId } = await prisma.store.create({
        data: {
          storeCode: code,
          bpCodeId,
          storeTypeCode: 'DIRECT',
          name: '곧 닫을 점포',
          storeStatusCode: 'OPERATING',
        },
      });
      const file = await sheet([
        line(`곧 닫을 점포 [${code}]`, { '시설물/장비명*': '폐점 경쟁' }),
      ]);
      const preview = await call('post', '/facilities/bulk-validations')
        .attach('file', file, 'a.xlsx')
        .expect(200);
      expect((preview.body as Preview).validCount).toBe(1);
      await prisma.store.update({
        where: { storeId: tempStoreId },
        data: { storeStatusCode: 'CLOSED' },
      });
      await call('post', '/facilities/bulk')
        .attach('file', file, 'a.xlsx')
        .expect(400)
        .expect((r) =>
          expect((r.body as { message: string }).message).toBe(
            '오류를 고친 파일을 다시 올려 주세요.',
          ),
        );
      await prisma.store.update({
        where: { storeId: tempStoreId },
        data: { storeStatusCode: 'OPERATING', isDeleted: true },
      });
      await call('post', '/facilities/bulk')
        .attach('file', file, 'a.xlsx')
        .expect(400);
      expect(await countOf('폐점 경쟁')).toBe(0);
    });

    it('미리보기 뒤 분류가 미사용이 되면 등록은 400', async () => {
      const file = await sheet([
        line(await codeOf(storeId), {
          '시설물/장비명*': '미사용 경쟁',
          '분류*': '커피머신',
        }),
      ]);
      await call('post', '/facilities/bulk-validations')
        .attach('file', file, 'a.xlsx')
        .expect(200)
        .expect((r) => expect((r.body as Preview).validCount).toBe(1));
      const coffee = {
        groupCode: 'STORE_EQUIPMENT',
        itemCode: 'COFFEE_MACHINE',
        bpCode,
      };
      await prisma.codeItem.update({
        where: { groupCode_itemCode_bpCode: coffee },
        data: { status: 'INACTIVE' },
      });
      try {
        await call('post', '/facilities/bulk')
          .attach('file', file, 'a.xlsx')
          .expect(400);
        expect(await countOf('미사용 경쟁')).toBe(0);
      } finally {
        await prisma.codeItem.update({
          where: { groupCode_itemCode_bpCode: coffee },
          data: { status: 'ACTIVE' },
        });
      }
    });

    it('플랫폼 계정 — 고른 BP 의 점포 · 공통코드로 미리보기 · 등록한다', async () => {
      const file = await sheet([
        line(await codeOf(storeId), { '시설물/장비명*': '플랫폼 일괄 등록' }),
      ]);
      await call('post', '/facilities/bulk-validations', pmToken)
        .attach('file', file, 'a.xlsx')
        .expect(400);
      await call('post', '/facilities/bulk-validations', pmToken, bpCodeId)
        .attach('file', file, 'a.xlsx')
        .expect(200)
        .expect((r) => expect((r.body as Preview).validCount).toBe(1));
      await call('post', '/facilities/bulk', pmToken, bpCodeId)
        .attach('file', file, 'a.xlsx')
        .expect(201);
      const row = await prisma.facility.findFirstOrThrow({
        where: { name: '플랫폼 일괄 등록' },
      });
      expect(row).toMatchObject({
        storeId,
        facilityCategoryCode: 'GRINDER',
      });
    });

    it('업로드 계약 — 5MB 를 넘거나 파일이 둘이면 400, 오류 파일은 xlsx 로 내려오고 오류 줄이 없으면 400', async () => {
      const message = async (req: request.Test) =>
        ((await req.expect(400)).body as { message: string }).message;
      expect(
        await message(
          call('post', '/facilities/bulk-validations').attach(
            'file',
            Buffer.alloc(5 * 1024 * 1024 + 1),
            'big.xlsx',
          ),
        ),
      ).toBe('파일은 5MB까지 올릴 수 있습니다.');
      const one = await sheet([line(await codeOf(storeId))]);
      expect(
        await message(
          call('post', '/facilities/bulk-validations')
            .attach('file', one, 'a.xlsx')
            .attach('file', one, 'b.xlsx'),
        ),
      ).toBe('파일은 1개까지 올릴 수 있습니다.');
      const res = await binary(
        call('post', '/facilities/bulk-error-file').attach(
          'file',
          await sheet([line('ST000000')]),
          'e.xlsx',
        ),
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(
        await message(
          call('post', '/facilities/bulk-error-file').attach(
            'file',
            one,
            'a.xlsx',
          ),
        ),
      ).toBe('오류가 있는 줄이 없습니다.');
    });
  });
});
