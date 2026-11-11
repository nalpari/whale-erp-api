import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import type {
  FacilityDetailResponseDto,
  FacilityListResponseDto,
} from '../src/facilities/dto/facility.response.dto';
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
  let emptyRoleGroupId: number;
  const adminIds: number[] = [];
  let bmToken: string;
  /** 일부 점포(storeId)만 맡은 BP 관리자 */
  let baToken: string;
  let pmToken: string;
  let fmToken: string;
  let noMenuToken: string;
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
    const s = randomInt(100_000, 999_996);
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
    const staff = (name: string, employmentStatus: 'EMPLOYED' | 'RETIRED') =>
      prisma.staffMember.create({
        data: {
          storeId,
          name,
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          jobTitle: '홀',
          employmentType: 'PART_TIME',
          employmentStatus,
          // 퇴직이면 퇴직일이 있어야 한다(staff_members_retired_date_required)
          ...(employmentStatus === 'RETIRED' && {
            retiredDate: new Date('2026-10-31'),
          }),
        },
      });
    ({ staffMemberId } = await staff('정하윤', 'EMPLOYED'));
    ({ staffMemberId: retiredStaffMemberId } = await staff(
      '퇴직자',
      'RETIRED',
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
      if (emptyRoleGroupId !== undefined)
        await prisma.roleGroup.deleteMany({
          where: { roleGroupId: emptyRoleGroupId },
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
    const leaving = await prisma.staffMember.create({
      data: {
        storeId,
        name: '곧 퇴직',
        phone: `010${randomInt(10_000_000, 99_999_999)}`,
        jobTitle: '홀',
        employmentType: 'PART_TIME',
      },
    });
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

  it('범위 밖 id 는 DB 에 묻지 않고 404', async () => {
    await call('get', '/facilities/2147483648').expect(404);
    await call('get', '/facilities/abc').expect(404);
  });
});
