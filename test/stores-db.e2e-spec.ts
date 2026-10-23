import { randomInt } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { ContractStatus } from '@prisma/client';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  ACCESS_DENIED_MESSAGE,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
} from '../src/auth/access-messages';
import { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';
import { StorageService } from '../src/storage/storage.service';
import { STORE_BUSINESS_VERIFIER } from '../src/stores/store-business-verifier';
import type {
  CreateStoreResponseDto,
  StoreDetailResponseDto,
  StoreListResponseDto,
} from '../src/stores/dto/store.response.dto';

const PASSWORD = 'Whale-admin-1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
// 실제 PostgreSQL 에서만 도는 동시성 검사. PGlite 는 세션이 하나라 연결이 서로 잠금을 기다리지 않는다.
const onRealPostgres = process.env.E2E_REAL_POSTGRES === '1' ? it : it.skip;

/**
 * 점포 정보 관리를 실제 DB 로 — 관계 필터 · 채번 · 낙관적 잠금 왕복 · 409 롤백 · 부분 고유 인덱스.
 * 저장소(S3)는 메모리 가짜로, 국세청 진위확인은 늘 맞다고 답하는 가짜로 바꾼다.
 */
describe('점포 정보 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let bpCodeId: number;
  /** 두 번째 고객 BP — 플랫폼 계정이 모든 BP 를 보는지, 고객 BP 소속 PM 이 못 보는지 가른다. */
  let otherBpCodeId: number;
  /** 메뉴 권한이 하나도 없는 권한 그룹 */
  let emptyRoleGroupId: number;
  const adminIds: number[] = [];
  let bmToken: string;
  let baToken: string;
  /** 플랫폼 계정 — PM, 플랫폼 BP 소속, PM000001 */
  let pmToken: string;
  /** 고객 BP 소속인데 권한 유형이 PM 인 계정 — 플랫폼 계정이 아니다 */
  let customerPmToken: string;
  /** 가맹 마스터 — FM000001(조회 · 수정만) */
  let fmToken: string;
  /** 메뉴 권한 없는 BP 관리자 */
  let noMenuToken: string;
  /** 강제 비밀번호 변경 대상으로 바꿀 BP 마스터 */
  let pendingToken: string;
  let pendingAdminId: number;
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
  /** 국세청 진위확인 가짜 — 늘 맞다고 답한다. 권한 없는 호출이 여기까지 오지 않는지도 이것으로 본다. */
  const verifier = { verify: jest.fn(() => Promise.resolve(true)) };
  // 사업자번호는 테스트마다 새로 만든다 — 같은 DB 에서 다시 돌려도 겹치지 않게.
  const nextBizNumber = () => String(randomInt(1_000_000_000, 9_999_999_999));

  /** bp 는 상단에서 고른 BP(X-Bp-Code-Id) — 플랫폼 계정은 이것 없이 점포를 다루지 못한다. */
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

  const create = async (name: string, token = bmToken) => {
    const res = await call('post', '/stores', token)
      .send({ storeTypeCode: 'DIRECT', name })
      .expect(201);
    return res.body as CreateStoreResponseDto;
  };
  const detail = async (storeId: number) =>
    (await call('get', `/stores/${storeId}`).expect(200))
      .body as StoreDetailResponseDto;
  /** 상세를 그대로 돌려보내는 수정 몸통 */
  const formOf = (d: StoreDetailResponseDto) => ({
    name: d.name,
    storeStatus: d.storeStatusCode,
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
      .overrideProvider(STORE_BUSINESS_VERIFIER)
      .useValue(verifier)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const n = randomInt(100_000, 999_998);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        tradeName: '점포 관리 DB 테스트 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ bpCodeId: otherBpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n + 1}`,
        tradeName: '점포 관리 DB 테스트 다른 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
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
          loginId: `str${randomInt(10_000_000, 99_999_999)}`,
          bpCodeId: bp,
          name: '홍길동',
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
    // 일부 점포만 맡은 BP 관리자 — 같은 권한 그룹이라 메뉴 권한은 같고 범위만 다르다.
    baToken = (await loginAs('BA', false)).token;
    pmToken = (
      await loginAs('PM', true, {
        roleCode: 'PM000001',
        bp: platform.bpCodeId,
      })
    ).token;
    // 권한 그룹은 BM000001(메뉴 권한 있음) — 막히는 것이 메뉴 권한이 아니라 범위임을 보려고.
    customerPmToken = (await loginAs('PM', true)).token;
    fmToken = (await loginAs('FM', true, { roleCode: 'FM000001' })).token;
    noMenuToken = (await loginAs('BA', true, { roleGroupId: emptyRoleGroupId }))
      .token;
    ({ token: pendingToken, adminAccountId: pendingAdminId } = await loginAs(
      'BM',
      true,
    ));
  });

  afterAll(async () => {
    // bpCodeId 가 없으면(준비 실패) 아무것도 지우지 않는다 — Prisma 는 where 의 undefined 를 조건 없음으로 읽어
    // DB 의 모든 점포 · BP 를 지운다.
    if (prisma && bpCodeId !== undefined) {
      const bpIds = [bpCodeId, otherBpCodeId].filter(
        (id): id is number => id !== undefined,
      );
      const stores = await prisma.store.findMany({
        where: { bpCodeId: { in: bpIds } },
        select: { storeId: true },
      });
      const byStore = { storeId: { in: stores.map((s) => s.storeId) } };
      const byAdmin = { adminAccountId: { in: adminIds } };
      // 계약 테스트가 중간에 깨져 남긴 계약 · 직원도 지운다 — 남으면 점포 삭제가 외래키에 막힌다.
      await prisma.contract.deleteMany({ where: byStore });
      await prisma.staffMember.deleteMany({ where: byStore });
      await prisma.storeImageFile.deleteMany({ where: byStore });
      await prisma.storeFloor.deleteMany({ where: byStore });
      await prisma.storeBusinessProfile.deleteMany({ where: byStore });
      await prisma.storeChangeHistory.deleteMany({ where: byStore });
      await prisma.adminStoreMapping.deleteMany({ where: byStore });
      await prisma.store.deleteMany({ where: byStore });
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

  it('점포코드는 지운 점포를 포함한 마지막 코드 다음이다 — 지운 코드를 다시 쓰지 않는다', async () => {
    const first = await create('채번 1');
    await call('delete', `/stores/${first.storeId}`).expect(204);
    const second = await create('채번 2');
    expect(Number(second.storeCode.slice(2))).toBeGreaterThan(
      Number(first.storeCode.slice(2)),
    );
    expect(second.storeCode).toMatch(/^ST\d{6}$/);
  });

  // 050X 평생번호는 12자리다. 앱 검증과 DB CHECK(stores_phone_format)가 함께 넓어져야 저장된다 — 한쪽만이면
  // 400 이나 500 이 된다. 13자리는 앱이 400 으로 막는다.
  it('점포 연락처에 050X 평생번호(12자리)를 저장하고, 13자리는 400 이다', async () => {
    const { storeId } = await create('평생번호');
    const before = await detail(storeId);
    await call('put', `/stores/${storeId}`)
      .send({ ...formOf(before), phone: '050720331334' })
      .expect(204);
    expect((await detail(storeId)).phone).toBe('050720331334');

    const after = await detail(storeId);
    await call('put', `/stores/${storeId}`)
      .send({ ...formOf(after), phone: '0507203313345' })
      .expect(400);
    expect((await detail(storeId)).phone).toBe('050720331334');
  });

  // 409 는 쓰기 전에 나므로 이 테스트는 롤백이 아니라 updatedAt 왕복을 증명한다(롤백은 단위 테스트가 본다).
  it('상세의 updatedAt 을 그대로 돌려보내면 저장되고, 같은 값으로 다시 보내면 409 이고 아무것도 바뀌지 않는다', async () => {
    const { storeId } = await create('낙관적 잠금');
    const before = await detail(storeId);
    await call('put', `/stores/${storeId}`)
      .send({ ...formOf(before), name: '낙관적 잠금 1' })
      .expect(204);

    const floorsBefore = await prisma.storeFloor.count({ where: { storeId } });
    const historiesBefore = await prisma.storeChangeHistory.count({
      where: { storeId },
    });
    // 옛 updatedAt — 층 · 사업자정보 · 이력을 함께 바꾸려 해도 하나도 남지 않아야 한다.
    await call('put', `/stores/${storeId}`)
      .send({
        ...formOf(before),
        name: '낙관적 잠금 2',
        floors: [{ floorTypeCode: 'GROUND', floorNumber: 1 }],
        business: { tradeName: '모리' },
      })
      .expect(409);
    expect(await prisma.storeFloor.count({ where: { storeId } })).toBe(
      floorsBefore,
    );
    expect(await prisma.storeChangeHistory.count({ where: { storeId } })).toBe(
      historiesBefore,
    );
    expect(
      await prisma.storeBusinessProfile.count({ where: { storeId } }),
    ).toBe(0);
    expect((await detail(storeId)).name).toBe('낙관적 잠금 1');
  });

  it('사업자등록번호는 미운영 · 운영 점포끼리만 고유하다 — 폐점하면 다른 점포가 쓸 수 있다', async () => {
    const number = nextBizNumber();
    const identity = {
      bizRegistrationNumber: number,
      ceoName: '김대표',
      openDate: '2020-03-02',
    };
    const a = await create('번호 A');
    await call('put', `/stores/${a.storeId}`)
      .send({
        ...formOf(await detail(a.storeId)),
        businessVerification: identity,
      })
      .expect(204);

    await call('post', '/stores')
      .send({
        storeTypeCode: 'DIRECT',
        name: '번호 B',
        businessVerification: identity,
      })
      .expect(409);
    await call('post', '/stores/business-verifications')
      .send(identity)
      .expect(200, { result: 'DUPLICATE' });

    await call('put', `/stores/${a.storeId}`)
      .send({ ...formOf(await detail(a.storeId)), storeStatus: 'CLOSED' })
      .expect(204);
    const b = await call('post', '/stores')
      .send({
        storeTypeCode: 'DIRECT',
        name: '번호 B',
        businessVerification: identity,
      })
      .expect(201);

    // 목록의 사업자번호 검색은 관계 필터로, 하이픈 · 일부만 넣어도 찾는다.
    const hyphenated = `${number.slice(0, 3)}-${number.slice(3, 5)}`;
    const list = (
      await call(
        'get',
        `/stores?bizRegistrationNumber=${hyphenated}&statuses=NOT_OPERATING,CLOSED`,
      ).expect(200)
    ).body as StoreListResponseDto;
    expect(list.items.map((i) => i.storeId).sort()).toEqual(
      [a.storeId, (b.body as CreateStoreResponseDto).storeId].sort(),
    );
  });

  it('인증과 좌표가 있으면 운영으로 바꾸고, 폐점일은 한국 날짜로 남는다', async () => {
    const { storeId } = await create('운영 전환');
    await call('put', `/stores/${storeId}`)
      .send({
        ...formOf(await detail(storeId)),
        storeStatus: 'OPERATING',
        latitude: 37.491234,
        longitude: 127.012345,
        businessVerification: {
          bizRegistrationNumber: nextBizNumber(),
          ceoName: '김대표',
          openDate: '2020-03-02',
        },
      })
      .expect(204);
    const operating = await detail(storeId);
    expect(operating).toMatchObject({
      storeStatusCode: 'OPERATING',
      latitude: 37.491234,
      longitude: 127.012345,
      business: { isVerified: true },
    });

    await call('put', `/stores/${storeId}`)
      .send({
        ...formOf(operating),
        storeStatus: 'CLOSED',
        latitude: 37.491234,
        longitude: 127.012345,
      })
      .expect(204);
    const kstToday = new Date(Date.now() + 9 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    expect((await detail(storeId)).closedDate).toBe(kstToday);
  });

  // 폐점 · 삭제 규칙이 보는 근로계약 건수를 실제 행으로 확인한다. 계약 · 직원은 afterAll 이 점포와 함께 지운다.
  it('진행 중인 근로계약이 있는 점포는 폐점 · 삭제가 409 이고 상태는 그대로다', async () => {
    const { storeId } = await create('계약 있는 점포');
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        name: '김직원',
        phone: `010${randomInt(10_000_000, 99_999_999)}`,
        jobTitle: '홀',
        employmentType: 'PART_TIME',
        joinStatus: 'DRAFT',
      },
    });
    await prisma.contract.create({
      data: {
        staffMemberId: staff.staffMemberId,
        storeId,
        status: 'DRAFT',
        contractMethod: 'ELECTRONIC',
        createdBy: adminIds[0],
      },
    });
    await call('delete', `/stores/${storeId}`).expect(409);
    await call('put', `/stores/${storeId}`)
      .send({ ...formOf(await detail(storeId)), storeStatus: 'CLOSED' })
      .expect(409);
    expect((await detail(storeId)).storeStatusCode).toBe('NOT_OPERATING');
  });

  // 재직 직원 수(WHALEERP-138)를 실제 행으로 — 관계 필터(contracts some)가 레코드를 한 번만 세는지까지. 계약 · 직원은
  // afterAll 이 점포와 함께 지운다.
  it('재직 직원은 퇴직하지 않았고 체결 완료 근로계약이 있는 레코드만 센다 — 목록 · 상세가 같다', async () => {
    const { storeId } = await create('재직 직원 수');
    const phone = () => `010${randomInt(10_000_000, 99_999_999)}`;
    const staffWith = async (
      statuses: ContractStatus[],
      member: {
        joinStatus?: 'DRAFT' | 'INVITED' | 'JOINED';
        retired?: boolean;
        phone?: string;
        contractMethod?: 'ELECTRONIC' | 'PAPER';
        endDate?: Date;
      } = {},
    ) => {
      const staff = await prisma.staffMember.create({
        data: {
          storeId,
          name: '김직원',
          phone: member.phone ?? phone(),
          jobTitle: '홀',
          employmentType: 'PART_TIME',
          joinStatus: member.joinStatus ?? 'JOINED',
          ...(member.retired && {
            employmentStatus: 'RETIRED',
            retiredDate: new Date('2026-09-30'),
          }),
        },
      });
      for (const status of statuses)
        await prisma.contract.create({
          data: {
            staffMemberId: staff.staffMemberId,
            storeId,
            status,
            contractMethod: member.contractMethod ?? 'ELECTRONIC',
            // 체결 완료는 시작일이 있어야 한다(contracts_start_date_required_when_signed)
            startDate: new Date('2026-09-01'),
            endDate: member.endDate,
            createdBy: adminIds[0],
          },
        });
    };
    // 세지 않는다 — 초안만 · 초대 발송만 · 서명 대기만(가입한 직원의 첫 계약) · 퇴직(아래)
    await staffWith(['DRAFT'], { joinStatus: 'DRAFT' });
    await staffWith(['PENDING_SEND'], { joinStatus: 'INVITED' });
    await staffWith(['PENDING_SIGNATURE']);
    // 체결 완료가 없으면 세지 않는다 — 수정 요청(진행 중) · 거부 · 만료, 그리고 대체(replaceContracts)되어 종료만 남은
    // 가입 전 종이 계약 레코드
    await staffWith(['REJECTED']);
    await staffWith(['EXPIRED']);
    await staffWith(['CORRECTION_REQUESTED']);
    await staffWith(['ENDED'], {
      joinStatus: 'DRAFT',
      contractMethod: 'PAPER',
    });
    const returning = phone();
    await staffWith(['SIGNED'], { retired: true, phone: returning });
    // 센다 — 체결 · 종료일이 지난 체결 완료(기간 만료로 닫는 배치가 없다) · 종이 계약(가입 전 체결 완료) · 재입사(새
    // 레코드의 새 계약 체결) · 가입 전 종이 계약 레코드에 새 계약 초대(체결 완료가 남는다 — 가입한 재직 직원에게는 같은
    // 점포 새 계약을 만들 수 없다). 수는 상태만 보므로 계약 방식은 레코드마다 하나로 둔다
    await staffWith(['SIGNED']);
    await staffWith(['SIGNED'], { endDate: new Date('2026-09-15') });
    await staffWith(['SIGNED'], {
      joinStatus: 'DRAFT',
      contractMethod: 'PAPER',
    });
    await staffWith(['SIGNED'], { phone: returning });
    await staffWith(['SIGNED', 'PENDING_SEND'], {
      joinStatus: 'INVITED',
      contractMethod: 'PAPER',
    });

    expect((await detail(storeId)).staffCount).toBe(5);
    const list = (
      await call('get', `/stores?keyword=${encodeURI('재직 직원 수')}`).expect(
        200,
      )
    ).body as StoreListResponseDto;
    expect(list.items.map((s) => [s.storeId, s.staffCount])).toEqual([
      [storeId, 5],
    ]);
  });

  it('대표 이미지를 바꾸면 살아 있는 행은 늘 하나다(부분 고유 인덱스) — 지우면 없다', async () => {
    const { storeId } = await create('이미지');
    const put = (name: string) =>
      call('put', `/stores/${storeId}/image`)
        .attach('file', PNG, name)
        .expect(200);
    await put('첫 사진.png');
    await put('둘째 사진.png');
    const live = await prisma.storeImageFile.findMany({
      where: { storeId, isDeleted: false },
    });
    expect(live.map((i) => i.fileName)).toEqual(['둘째 사진.png']);
    expect((await detail(storeId)).image).toMatchObject({
      fileName: '둘째 사진.png',
      fileType: 'PNG',
      url: expect.stringContaining(`stores/${storeId}/`) as string,
    });

    await call('delete', `/stores/${storeId}/image`).expect(204);
    expect(
      await prisma.storeImageFile.count({
        where: { storeId, isDeleted: false },
      }),
    ).toBe(0);
    expect(await prisma.storeImageFile.count({ where: { storeId } })).toBe(2);
    const fields = (
      await prisma.storeChangeHistory.findMany({
        where: { storeId, field: '대표 이미지' },
        orderBy: { changeId: 'asc' },
      })
    ).map((h) => [h.beforeValue, h.afterValue]);
    expect(fields).toEqual([
      [null, '첫 사진.png'],
      ['첫 사진.png', '둘째 사진.png'],
      ['둘째 사진.png', null],
    ]);
  });

  it('일부 점포만 맡은 관리자는 자기가 등록한 점포만 본다 — 매핑이 실제로 걸린다', async () => {
    const mine = await create('BA 의 점포', baToken);
    const others = await create('BM 의 점포');
    const list = (
      await call('get', '/stores?pageSize=100', baToken).expect(200)
    ).body as StoreListResponseDto;
    const ids = list.items.map((i) => i.storeId);
    expect(ids).toContain(mine.storeId);
    expect(ids).not.toContain(others.storeId);
    await call('get', `/stores/${others.storeId}`, baToken).expect(404);
  });

  it('플랫폼 계정(PM, 플랫폼 BP)은 상단에서 고른 BP(X-Bp-Code-Id)의 점포만 보고, 그 BP 에 등록한다', async () => {
    const tag = `고른BP${randomInt(100_000, 999_999)}`;
    const mine = await create(`${tag} BP1`);
    const other = (
      await call('post', '/stores', pmToken, otherBpCodeId)
        .send({ storeTypeCode: 'DIRECT', name: `${tag} BP2` })
        .expect(201)
    ).body as CreateStoreResponseDto;
    const saved = await prisma.store.findUniqueOrThrow({
      where: { storeId: other.storeId },
    });
    expect(saved.bpCodeId).toBe(otherBpCodeId);

    const listOf = async (bp: number) =>
      (
        (
          await call(
            'get',
            `/stores?keyword=${encodeURI(tag)}`,
            pmToken,
            bp,
          ).expect(200)
        ).body as StoreListResponseDto
      ).items.map((i) => i.storeId);
    expect(await listOf(bpCodeId)).toEqual([mine.storeId]);
    expect(await listOf(otherBpCodeId)).toEqual([other.storeId]);
    await call('get', `/stores/${mine.storeId}`, pmToken, bpCodeId).expect(200);
    // 고른 BP 밖의 점포는 ID 로도 404
    await call('get', `/stores/${mine.storeId}`, pmToken, otherBpCodeId).expect(
      404,
    );
    // 본문의 BP 는 헤더와 같을 때만 받는다
    await call('post', '/stores', pmToken, bpCodeId)
      .send({
        storeTypeCode: 'DIRECT',
        name: `${tag} 다른 BP`,
        bpCodeId: otherBpCodeId,
      })
      .expect(400);
    // BP 를 고르지 않으면(헤더 없음) 어느 경로든 400 — BP 권한 그룹과 같다. 문구까지 본다: 등록은 본문 BP 불일치도
    // 400 이라, 상태만 보면 「BP 누락」이 깨져도 통과한다.
    const noBp = { message: '점포를 볼 BP 를 골라 주세요' };
    await call('get', `/stores?keyword=${encodeURI(tag)}`, pmToken)
      .expect(400)
      .expect((res) => expect(res.body).toMatchObject(noBp));
    await call('get', `/stores/${mine.storeId}`, pmToken)
      .expect(400)
      .expect((res) => expect(res.body).toMatchObject(noBp));
    await call('post', '/stores', pmToken)
      .send({
        storeTypeCode: 'DIRECT',
        name: `${tag} BP 없음`,
        bpCodeId: otherBpCodeId,
      })
      .expect(400)
      .expect((res) => expect(res.body).toMatchObject(noBp));
  });

  it('고객 BP 소속 PM 은 플랫폼 계정이 아니다 — 자기 BP 점포만 보고 다른 BP 에 등록하지 못한다', async () => {
    const tag = `고객PM${randomInt(100_000, 999_999)}`;
    const mine = await create(`${tag} BP1`);
    const other = (
      await call('post', '/stores', pmToken, otherBpCodeId)
        .send({ storeTypeCode: 'DIRECT', name: `${tag} BP2` })
        .expect(201)
    ).body as CreateStoreResponseDto;

    const list = (
      await call(
        'get',
        `/stores?keyword=${encodeURI(tag)}`,
        customerPmToken,
      ).expect(200)
    ).body as StoreListResponseDto;
    expect(list.items.map((i) => i.storeId)).toEqual([mine.storeId]);
    await call('get', `/stores/${other.storeId}`, customerPmToken).expect(404);
    await call('post', '/stores', customerPmToken)
      .send({
        storeTypeCode: 'DIRECT',
        name: `${tag} 남의 BP`,
        bpCodeId: otherBpCodeId,
      })
      .expect(400);
    // 헤더 · 본문 BP 없이 등록하면 자기 BP 에 만든다(플랫폼 계정이라면 400 이다).
    const own = (
      await call('post', '/stores', customerPmToken)
        .send({ storeTypeCode: 'DIRECT', name: `${tag} 자기 BP` })
        .expect(201)
    ).body as CreateStoreResponseDto;
    const ownRow = await prisma.store.findUniqueOrThrow({
      where: { storeId: own.storeId },
    });
    expect(ownRow.bpCodeId).toBe(bpCodeId);
  });

  it('가맹 마스터(FM000001)는 점포를 볼 수 있지만 등록은 403', async () => {
    await call('get', '/stores', fmToken).expect(200);
    const res = await call('post', '/stores', fmToken)
      .send({ storeTypeCode: 'FRANCHISE', name: '가맹 등록' })
      .expect(403);
    expect((res.body as { message: string }).message).toBe(
      ACCESS_DENIED_MESSAGE,
    );
    expect(
      await prisma.store.count({ where: { bpCodeId, name: '가맹 등록' } }),
    ).toBe(0);
  });

  // 진위확인은 등록 · 수정 화면이 함께 쓴다 — 가드가 동작 배열(['create', 'update'])을 OR 로 본다.
  it('점포 사업자 진위확인은 수정 권한만 있어도(FM000001) 통과하고, 등록 · 수정이 다 없으면 403 이며 국세청을 부르지 않는다', async () => {
    const identity = () => ({
      bizRegistrationNumber: nextBizNumber(),
      ceoName: '김대표',
      openDate: '2020-03-02',
    });

    verifier.verify.mockClear();
    await call('post', '/stores/business-verifications', fmToken)
      .send(identity())
      .expect(200, { result: 'VERIFIED' });
    expect(verifier.verify).toHaveBeenCalledTimes(1);

    verifier.verify.mockClear();
    const res = await call(
      'post',
      '/stores/business-verifications',
      noMenuToken,
    )
      .send(identity())
      .expect(403);
    expect((res.body as { message: string }).message).toBe(
      ACCESS_DENIED_MESSAGE,
    );
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('메뉴 권한이 없는 관리자는 조회 · 이미지 올리기 모두 403 이고 저장소에 아무것도 올라가지 않는다', async () => {
    const { storeId } = await create('메뉴 권한 없음');
    await call('get', '/stores', noMenuToken).expect(403);
    await call('get', `/stores/${storeId}`, noMenuToken).expect(403);
    const res = await call('put', `/stores/${storeId}/image`, noMenuToken)
      .attach('file', PNG, '권한 없음.png')
      .expect(403);
    expect((res.body as { message: string }).message).toBe(
      ACCESS_DENIED_MESSAGE,
    );
    expect(
      [...objects.keys()].some((k) => k.startsWith(`stores/${storeId}/`)),
    ).toBe(false);
    expect(await prisma.storeImageFile.count({ where: { storeId } })).toBe(0);
  });

  it('강제 비밀번호 변경 전이면 점포 경로는 403(이미지 올리기 포함)', async () => {
    const { storeId } = await create('강제 변경');
    await prisma.adminAccount.update({
      where: { adminAccountId: pendingAdminId },
      data: { isPasswordChangeRequired: true },
    });
    try {
      const res = await call('get', '/stores', pendingToken).expect(403);
      expect((res.body as { message: string }).message).toBe(
        PASSWORD_CHANGE_REQUIRED_MESSAGE,
      );
      await call('put', `/stores/${storeId}/image`, pendingToken)
        .attach('file', PNG, '강제 변경.png')
        .expect(403);
      expect(await prisma.storeImageFile.count({ where: { storeId } })).toBe(0);
    } finally {
      await prisma.adminAccount.update({
        where: { adminAccountId: pendingAdminId },
        data: { isPasswordChangeRequired: false },
      });
    }
  });

  it('엑셀은 목록과 같은 조건으로 실제 행을 담는다', async () => {
    await create('엑셀 점포');
    await create('다른 점포');
    const res = await call(
      'get',
      `/stores/excel?keyword=${encodeURI('엑셀 점포')}`,
    )
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as ArrayBuffer);
    const names: unknown[] = [];
    workbook.worksheets[0].eachRow((row, i) => {
      if (i > 1) names.push(row.getCell(2).value);
    });
    expect(names).toEqual(['엑셀 점포']);
  });

  // ── 아래는 연결 두 개가 필요하다. 실제 PostgreSQL 일회용 DB 에서 E2E_REAL_POSTGRES=1 로 돌린다. ──

  onRealPostgres(
    '동시에 등록해도 점포코드가 겹치지 않는다(채번 잠금)',
    async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => create(`동시 등록 ${i}`)),
      );
      const codes = results.map((r) => r.storeCode);
      expect(new Set(codes).size).toBe(codes.length);
    },
  );

  onRealPostgres(
    '같은 사업자번호를 동시에 등록하면 하나만 된다(번호 잠금 뒤 다시 세기)',
    async () => {
      const identity = {
        bizRegistrationNumber: nextBizNumber(),
        ceoName: '김대표',
        openDate: '2020-03-02',
      };
      const statuses = await Promise.all(
        [1, 2].map(
          async (i) =>
            (
              await call('post', '/stores').send({
                storeTypeCode: 'DIRECT',
                name: `동시 번호 ${i}`,
                businessVerification: identity,
              })
            ).status,
        ),
      );
      expect(statuses.sort()).toEqual([201, 409]);
    },
  );

  onRealPostgres(
    '같은 점포의 이미지를 동시에 바꿔도 500 없이 살아 있는 행은 하나다',
    async () => {
      const { storeId } = await create('동시 이미지');
      const statuses = await Promise.all(
        [1, 2, 3].map(
          async (i) =>
            (
              await call('put', `/stores/${storeId}/image`).attach(
                'file',
                PNG,
                `${i}.png`,
              )
            ).status,
        ),
      );
      expect(statuses).toEqual([200, 200, 200]);
      expect(
        await prisma.storeImageFile.count({
          where: { storeId, isDeleted: false },
        }),
      ).toBe(1);
    },
  );
});

// StorageService 를 가짜로 바꿨으니 키 모양 검사는 직접 확인해 둔다 — 서비스가 만든 키가 저장소 규칙에 맞는지.
describe('점포 이미지 키 모양', () => {
  it('stores/{점포}/{uuid}.png 는 StorageService 가 받는 키다', () => {
    expect(StorageService.newKey('stores', 11, 'PNG')).toMatch(
      /^stores\/11\/[0-9a-f-]{36}\.png$/,
    );
  });
});
