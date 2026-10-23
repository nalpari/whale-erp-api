import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { BpBusinessVerificationResponseDto } from '../src/auth/dto/bp-business-verification.response.dto';
import type { BpProfileResponseDto } from '../src/auth/dto/bp-profile.response.dto';
import type { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { NtsBusinessClient } from '../src/nts/nts-business.client';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Whale-admin-1';

// MY PAGE BP 사업자정보(S-UOJVUR)를 실제 DB 로 확인한다. advisory lock 이 번호별 동시 저장을
// 정말 한 쪽만 남기는지, BM 이 아니면 403 인지는 목으로 증명되지 않는다(CLAUDE.md
// 「Concurrency, row locks … are only proven there」). 요청 제한 가드는 끈다 — 한도 자체는
// bp-profile.service.spec.ts 의 countNtsCall 테스트가 다룬다.
describe('MY PAGE BP 사업자정보 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let passwordHash: string;
  let roleGroupId: number;
  const nts = { verify: jest.fn().mockResolvedValue('MATCH') };
  const bpCodeIds: number[] = [];
  const adminIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      // 국세청은 부르지 않는다 — 진위 판정은 nts-business.client.spec 과 business-verification
      // .service.spec 이 다룬다. 여기서는 번호별 동시 저장이 실제로 직렬화되는지만 본다.
      .overrideProvider(NtsBusinessClient)
      .useValue(nts)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    passwordHash = await hashPassword(PASSWORD);
    ({ roleGroupId } = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    }));
  });

  afterAll(async () => {
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.bpChangeHistory.deleteMany({
      where: { bpCodeId: { in: bpCodeIds } },
    });
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    await prisma.bpCode.deleteMany({ where: { bpCodeId: { in: bpCodeIds } } });
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const newBizNumber = () =>
    `9${String(randomBytes(4).readUInt32BE()).padStart(9, '0').slice(0, 9)}`;

  /** BM 마스터 한 명과 그 소속 BP 를 새로 만들고, 로그인한 접근 토큰을 돌려준다. */
  async function createBm(roleTypeCode = 'BM') {
    const n = randomBytes(4).readUInt32BE();
    const bp = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n.toString().slice(0, 6).padStart(6, '0')}`,
        tradeName: 'e2e 테스트 BP',
        accountStatusCode: 'ACTIVE',
      },
    });
    bpCodeIds.push(bp.bpCodeId);
    const admin = await prisma.adminAccount.create({
      data: {
        loginId: `e2ebp${n}`,
        bpCodeId: bp.bpCodeId,
        name: '김하늘',
        passwordHash,
        roleTypeCode,
        roleGroupId,
        joinPathCode: 'SIGNUP',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    });
    adminIds.push(admin.adminAccountId);
    const res = await api()
      .post('/auth/admin/login')
      .send({ loginId: admin.loginId, password: PASSWORD })
      .expect(200);
    const accessToken = (res.body as AdminLoginResponseDto).accessToken;
    return {
      bpCodeId: bp.bpCodeId,
      adminAccountId: admin.adminAccountId,
      accessToken,
    };
  }

  const getProfile = (token: string) =>
    api().get('/auth/admin/me/bp').set('Authorization', `Bearer ${token}`);
  const updateProfile = (token: string, body: Record<string, unknown>) =>
    api()
      .patch('/auth/admin/me/bp')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const verify = (token: string, body: Record<string, unknown>) =>
    api()
      .post('/auth/admin/me/bp/business-verification')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('조회는 BM 만 — 그 밖의 권한은 403', async () => {
    const bm = await createBm();
    const other = await createBm('FM');

    const ok = await getProfile(bm.accessToken).expect(200);
    expect((ok.body as BpProfileResponseDto).bizRegistrationNumber).toBe('');

    await getProfile(other.accessToken).expect(403);
  });

  it('직접 수정 항목은 바로 저장되고, 인증 토큰 없이 저장해도 사업자등록번호 등은 그대로다', async () => {
    const bm = await createBm();
    const profile = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;

    await updateProfile(bm.accessToken, {
      tradeName: '한강상회',
      updatedAt: profile.updatedAt,
    }).expect(204);

    const after = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;
    expect(after.tradeName).toBe('한강상회');
    expect(after.bizRegistrationNumber).toBe('');
    expect(after.bizVerifiedAt).toBeNull();
  });

  it('인증 토큰을 실어 저장하면 세 값과 인증일시가 같은 저장에 반영된다', async () => {
    const bm = await createBm();
    const bizRegistrationNumber = newBizNumber();
    const verified = await verify(bm.accessToken, {
      bizRegistrationNumber,
      bizCeoName: '김하늘',
      bizOpenDate: '2020-03-02',
    }).expect(200);
    const { verificationToken } =
      verified.body as BpBusinessVerificationResponseDto;

    const profile = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;
    await updateProfile(bm.accessToken, {
      tradeName: '한강상회',
      updatedAt: profile.updatedAt,
      businessVerificationToken: verificationToken,
    }).expect(204);

    const after = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;
    expect(after.bizRegistrationNumber).toBe(bizRegistrationNumber);
    expect(after.bizCeoName).toBe('김하늘');
    expect(after.bizOpenDate).toBe('2020-03-02');
    expect(after.bizVerifiedAt).not.toBeNull();
  });

  it('clearBusinessVerification 으로 저장하면 인증된 세 값과 인증일시가 비워진다 — 점포와 달리 BP 는 지울 수 있다', async () => {
    const bm = await createBm();
    const bizRegistrationNumber = newBizNumber();
    const verified = await verify(bm.accessToken, {
      bizRegistrationNumber,
      bizCeoName: '김하늘',
      bizOpenDate: '2020-03-02',
    }).expect(200);
    const { verificationToken } =
      verified.body as BpBusinessVerificationResponseDto;
    let profile = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;
    await updateProfile(bm.accessToken, {
      tradeName: '한강상회',
      updatedAt: profile.updatedAt,
      businessVerificationToken: verificationToken,
    }).expect(204);

    profile = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;
    await updateProfile(bm.accessToken, {
      tradeName: '한강상회',
      updatedAt: profile.updatedAt,
      clearBusinessVerification: true,
    }).expect(204);

    const after = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;
    expect(after.bizRegistrationNumber).toBe('');
    expect(after.bizCeoName).toBe('');
    expect(after.bizOpenDate).toBeNull();
    expect(after.bizVerifiedAt).toBeNull();

    // 지운 번호는 바로 다른 BP 가 다시 쓸 수 있다 — 더는 DB 에 살아 있지 않으므로 중복에 걸리지 않는다.
    const other = await createBm();
    const reverified = await verify(other.accessToken, {
      bizRegistrationNumber,
      bizCeoName: '남도현',
      bizOpenDate: '2021-03-15',
    }).expect(200);
    expect(
      (reverified.body as BpBusinessVerificationResponseDto).verificationToken,
    ).toEqual(expect.any(String));
  });

  it('clearBusinessVerification 을 businessVerificationToken 과 함께 보내면 400', async () => {
    const bm = await createBm();
    const profile = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;
    await updateProfile(bm.accessToken, {
      tradeName: '한강상회',
      updatedAt: profile.updatedAt,
      clearBusinessVerification: true,
      businessVerificationToken: 'whatever',
    }).expect(400);
  });

  // pr-review-toolkit 리뷰로 찾음 — advisory lock(stores:biz:<번호>)이 번호별 동시 저장을 실제로
  // 직렬화하는지는 목으로 증명되지 않는다. admin-signup.e2e-spec.ts 의 같은 모양 테스트와 같다.
  it('같은 번호로 받은 두 토큰을 두 BP 가 동시에 저장하면 하나만 되고, 진 쪽은 409 다', async () => {
    const [first, second] = await Promise.all([createBm(), createBm()]);
    const bizRegistrationNumber = newBizNumber();

    const [firstVerify, secondVerify] = await Promise.all([
      verify(first.accessToken, {
        bizRegistrationNumber,
        bizCeoName: '김하늘',
        bizOpenDate: '2020-03-02',
      }).expect(200),
      verify(second.accessToken, {
        bizRegistrationNumber,
        bizCeoName: '남도현',
        bizOpenDate: '2021-03-15',
      }).expect(200),
    ]);
    const firstToken = (firstVerify.body as BpBusinessVerificationResponseDto)
      .verificationToken;
    const secondToken = (secondVerify.body as BpBusinessVerificationResponseDto)
      .verificationToken;

    const [firstProfile, secondProfile] = await Promise.all([
      getProfile(first.accessToken).expect(200),
      getProfile(second.accessToken).expect(200),
    ]);

    const [firstSave, secondSave] = await Promise.all([
      updateProfile(first.accessToken, {
        tradeName: '한강상회',
        updatedAt: (firstProfile.body as BpProfileResponseDto).updatedAt,
        businessVerificationToken: firstToken,
      }),
      updateProfile(second.accessToken, {
        tradeName: '남도상사',
        updatedAt: (secondProfile.body as BpProfileResponseDto).updatedAt,
        businessVerificationToken: secondToken,
      }),
    ]);
    const statuses = [firstSave.status, secondSave.status].sort();
    expect(statuses).toEqual([204, 409]);

    // 트랜잭션 안에서 다시 본 중복에 막히므로, 진 쪽의 번호는 DB 에 남지 않는다 — 이긴 쪽 하나뿐이다.
    await expect(
      prisma.bpCode.count({ where: { bizRegistrationNumber } }),
    ).resolves.toBe(1);
  });

  it('동시 수정(updatedAt 이 지금과 다름)이면 409', async () => {
    const bm = await createBm();
    const profile = (await getProfile(bm.accessToken).expect(200))
      .body as BpProfileResponseDto;

    await updateProfile(bm.accessToken, {
      tradeName: '먼저 저장',
      updatedAt: profile.updatedAt,
    }).expect(204);

    // 같은(이제는 낡은) updatedAt 으로 다시 저장을 시도한다.
    await updateProfile(bm.accessToken, {
      tradeName: '늦게 저장',
      updatedAt: profile.updatedAt,
    }).expect(409);
  });
});
