import { randomInt } from 'node:crypto';
import { ConflictException, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { ACCESS_DENIED_MESSAGE } from '../src/auth/access-messages';
import type {
  BpMasterDetailResponseDto,
  BpMasterHistoryListResponseDto,
  BpMasterListResponseDto,
  CreateBpMasterResponseDto,
} from '../src/bp-masters/dto/bp-master.response.dto';
import { ExcelExportsService } from '../src/excel-exports/excel-exports.service';
import { PLATFORM_ADMIN_MAIL } from '../src/platform-admins/platform-admin-mail';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * BP 마스터 계정 관리를 실제 DB 로 — 메뉴 권한(MN000203) · 플랫폼 계정 판정, BP 코드 채번 잠금(동시 등록),
 * 공통코드 복사, 이력 두 표의 UNION 쪽 나눔, 미사용 연쇄, 삭제 조건. 단위 테스트는 이것들을 목의 인자로만 본다.
 *
 * 메일은 보내지 않는다(발송 수단 null) — 등록은 「미발송」으로 남고 초기화는 503 이다.
 */
describe('BP 마스터 계정 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 999_999);
  const adminIds: number[] = [];
  const bpCodeIds: number[] = [];
  let pmId: number;
  let bmCallerId: number;
  /** 1분 제한 · 1만 건 · 이력은 공통 엑셀 e2e(excel-exports.e2e-spec)가 실제 DB 로 본다. 여기서는 경로 · 응답 모양만. */
  const excelExports = {
    request: jest.fn().mockResolvedValue({
      kind: 'file',
      fileName: 'BP목록_20261028.xlsx',
      buffer: Buffer.from('PK'),
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PLATFORM_ADMIN_MAIL)
      .useValue(null)
      .overrideProvider(ExcelExportsService)
      .useValue(excelExports)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    const pmGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'PM000001' },
    });
    const bmGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    const { bpCodeId: callerBpId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: 'BP 마스터 테스트 호출자 BP',
      },
    });
    bpCodeIds.push(callerBpId);
    const admin = async (
      prefix: string,
      data: { roleTypeCode: string; roleGroupId: number; bpCodeId: number },
    ) => {
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `${prefix}${n}`,
          name: '테스트관리자',
          phone: '01012345678',
          email: `${prefix}${n}@whale.test`,
          passwordHash: '!',
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          ...data,
        },
      });
      adminIds.push(adminAccountId);
      return adminAccountId;
    };
    pmId = await admin('bmpm', {
      roleTypeCode: 'PM',
      roleGroupId: pmGroup.roleGroupId,
      bpCodeId: platformBp.bpCodeId,
    });
    bmCallerId = await admin('bmbm', {
      roleTypeCode: 'BM',
      roleGroupId: bmGroup.roleGroupId,
      bpCodeId: callerBpId,
    });
  });

  afterAll(async () => {
    // 준비가 중간에 실패해 id 가 비어 있으면 그 조건을 빼고 지우지 않는다 — Prisma 는 where 의 undefined 를
    // 조건 없음으로 읽어 DB 의 모든 행을 지운다.
    if (prisma) {
      if (bpCodeIds.length) {
        const bps = await prisma.bpCode.findMany({
          where: { bpCodeId: { in: bpCodeIds } },
          select: { bpCode: true },
        });
        const accounts = await prisma.adminAccount.findMany({
          where: { bpCodeId: { in: bpCodeIds } },
          select: { adminAccountId: true },
        });
        adminIds.push(...accounts.map((a) => a.adminAccountId));
        await prisma.codeItem.deleteMany({
          where: { bpCode: { in: bps.map((b) => b.bpCode) } },
        });
        await prisma.bpChangeHistory.deleteMany({
          where: { bpCodeId: { in: bpCodeIds } },
        });
        // BP 와 계정이 서로를 가리킨다(등록자 · 소속) — 등록자를 먼저 비워야 계정을 지울 수 있다.
        await prisma.bpCode.updateMany({
          where: { bpCodeId: { in: bpCodeIds } },
          data: { createdBy: null, updatedBy: null },
        });
      }
      if (adminIds.length) {
        const where = { adminAccountId: { in: adminIds } };
        await prisma.adminChangeHistory.deleteMany({ where });
        await prisma.adminSession.deleteMany({ where });
        await prisma.temporaryPassword.deleteMany({ where });
        await prisma.adminAccount.deleteMany({ where });
      }
      if (bpCodeIds.length)
        await prisma.bpCode.deleteMany({
          where: { bpCodeId: { in: bpCodeIds } },
        });
    }
    await app?.close();
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
  const call = async (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    body?: object,
    sub = pmId,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    return body === undefined ? req : req.send(body);
  };
  const createBody = (suffix: string) => ({
    loginId: `bpm${suffix}${n}`,
    name: '김하늘',
    phone: '01012345678',
    email: `bpm${suffix}${n}@whale.test`,
    tradeName: `한강상회 ${suffix}${n}`,
  });

  describe('엑셀 — 공통 엑셀을 거친다', () => {
    beforeEach(() => excelExports.request.mockClear());

    it(':id 로 잡히지 않고 xlsx 로 내려오며, 대상 BP 없이 조건을 넘긴다', async () => {
      // 파일 몸통을 받으려면 supertest 체인에 buffer · parse 를 걸어야 해 call 대신 직접 부른다
      const res = await request(app.getHttpServer())
        .get('/bp-masters/excel?statuses=ACTIVE')
        .set('Authorization', `Bearer ${await tokenOf(pmId)}`)
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect((res.body as Buffer).toString()).toBe('PK');
      expect(excelExports.request).toHaveBeenCalledWith(
        expect.objectContaining({ menuUrl: '/bp-masters' }),
        { adminAccountId: pmId, bp: null },
        expect.objectContaining({ statuses: ['ACTIVE'] }),
      );
    });

    it('1만 건 이상이면 202 와 안내 JSON — 응답이 끝까지 온다(passthrough)', async () => {
      excelExports.request.mockResolvedValueOnce({
        kind: 'scheduled',
        excelDownloadId: 52,
        rowCount: 10_050,
      });
      const res = await call('get', '/bp-masters/excel');
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ excelDownloadId: 52, rowCount: 10_050 });
    });

    it('같은 화면이 만드는 중이면 409', async () => {
      excelExports.request.mockRejectedValueOnce(
        new ConflictException('엑셀 파일을 만드는 중입니다'),
      );
      const res = await call('get', '/bp-masters/excel');
      expect(res.status).toBe(409);
    });

    it('BP 계정은 엑셀도 403 — 공통 엑셀까지 가지 않는다', async () => {
      const res = await call('get', '/bp-masters/excel', undefined, bmCallerId);
      expect(res.status).toBe(403);
      expect(excelExports.request).not.toHaveBeenCalled();
    });
  });

  it('BP 계정은 403', async () => {
    const res = await call('get', '/bp-masters', undefined, bmCallerId);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: ACCESS_DENIED_MESSAGE });
  });

  it('동시에 등록해도 BP 코드가 겹치지 않는다', async () => {
    const [a, b] = await Promise.all([
      call('post', '/bp-masters', createBody('a')),
      call('post', '/bp-masters', createBody('b')),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const [ra, rb] = [a.body, b.body] as CreateBpMasterResponseDto[];
    bpCodeIds.push(ra.bpCodeId, rb.bpCodeId);
    expect(ra.bpCode).not.toBe(rb.bpCode);
    expect(ra.isMailSent).toBe(false);
  });

  describe('한 BP 의 처음부터 끝까지', () => {
    let bpCodeId: number;
    let bpCode: string;
    let baId: number;

    beforeAll(async () => {
      const res = await call('post', '/bp-masters', createBody('c'));
      expect(res.status).toBe(201);
      ({ bpCodeId, bpCode } = res.body as CreateBpMasterResponseDto);
      bpCodeIds.push(bpCodeId);
    });

    it('플랫폼제공 공통코드를 새 BP 로 복사했다', async () => {
      const [copied, originals] = await Promise.all([
        prisma.codeItem.count({ where: { bpCode } }),
        prisma.codeItem.count({
          where: {
            bpCode: 'BP000000',
            isDeleted: false,
            manageOwnerCode: { not: 'BP_ONLY' },
            codeGroup: {
              manageOwnerCode: 'PLATFORM_PROVIDED',
              isDeleted: false,
            },
          },
        }),
      ]);
      expect(copied).toBe(originals);
    });

    it('목록에서 BP 코드로 찾힌다', async () => {
      const res = await call(
        'get',
        `/bp-masters?searchType=BP_CODE&keyword=${bpCode}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as BpMasterListResponseDto;
      expect(body.total).toBe(1);
      expect(body.items[0]).toMatchObject({
        bpCode,
        loginId: `bpmc${n}`,
        joinPath: 'PLATFORM_REGISTERED',
        accountStatus: 'ACTIVE',
      });
    });

    it('상세 — 미발송, 지울 수 있음', async () => {
      const res = await call('get', `/bp-masters/${bpCodeId}`);
      expect(res.status).toBe(200);
      expect(res.body as BpMasterDetailResponseDto).toMatchObject({
        isInitialPasswordUnsent: true,
        isPasswordChangeRequired: true,
        storeCount: 0,
        subAdminCount: 0,
        deletion: { isDeletable: true, reasons: [] },
      });
    });

    it('수정 뒤 이력은 BP 와 계정의 줄을 합쳐 최신순으로 쪽을 나눈다', async () => {
      // 아이디는 바꿀 수 없어 수정 본문에 없다 — 실으면 400.
      const editable: Partial<ReturnType<typeof createBody>> = createBody('c');
      delete editable.loginId;
      const res = await call('put', `/bp-masters/${bpCodeId}`, {
        ...editable,
        phone: '01099998888',
        tradeName: `한강상회 본점 ${n}`,
      });
      expect(res.status).toBe(204);

      const all = await call('get', `/bp-masters/${bpCodeId}/histories`);
      const body = all.body as BpMasterHistoryListResponseDto;
      // 등록 · 상호명(BP) + 연락처(계정)
      expect(body.total).toBe(3);
      expect(body.items.map((h) => h.field)).toEqual(
        expect.arrayContaining(['BP', '상호명', '연락처']),
      );
      expect(body.items.at(-1)?.field).toBe('BP');

      const second = await call(
        'get',
        `/bp-masters/${bpCodeId}/histories?page=2&pageSize=2`,
      );
      const page2 = second.body as BpMasterHistoryListResponseDto;
      expect(page2.total).toBe(3);
      expect(page2.items).toHaveLength(1);
    });

    it('미사용은 하위 계정까지 내리고, 사용은 BP 마스터만 올린다', async () => {
      const baGroup = await prisma.roleGroup.findFirstOrThrow({
        where: { roleCode: 'BM000001' },
      });
      ({ adminAccountId: baId } = await prisma.adminAccount.create({
        data: {
          loginId: `bmba${n}`,
          name: '하위관리자',
          email: `bmba${n}@whale.test`,
          passwordHash: '!',
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          roleTypeCode: 'BA',
          roleGroupId: baGroup.roleGroupId,
          bpCodeId,
        },
      }));

      expect(
        (
          await call('post', `/bp-masters/${bpCodeId}/status`, {
            status: 'INACTIVE',
          })
        ).status,
      ).toBe(204);
      const statusOf = async () =>
        Object.fromEntries(
          (
            await prisma.adminAccount.findMany({
              where: { bpCodeId },
              select: { roleTypeCode: true, accountStatusCode: true },
            })
          ).map((a) => [a.roleTypeCode, a.accountStatusCode]),
        );
      expect(await statusOf()).toEqual({ BM: 'INACTIVE', BA: 'INACTIVE' });

      expect(
        (
          await call('post', `/bp-masters/${bpCodeId}/status`, {
            status: 'ACTIVE',
          })
        ).status,
      ).toBe(204);
      expect(await statusOf()).toEqual({ BM: 'ACTIVE', BA: 'INACTIVE' });
    });

    it('메일 설정이 없으면 초기화는 503', async () => {
      const res = await call('post', `/bp-masters/${bpCodeId}/password-reset`);
      expect(res.status).toBe(503);
    });

    it('하위 관리자가 있으면 지울 수 없고, 없어지면 지운다', async () => {
      const blocked = await call('delete', `/bp-masters/${bpCodeId}`);
      expect(blocked.status).toBe(409);

      await prisma.adminAccount.update({
        where: { adminAccountId: baId },
        data: { isDeleted: true },
      });
      expect((await call('delete', `/bp-masters/${bpCodeId}`)).status).toBe(
        204,
      );
      expect((await call('get', `/bp-masters/${bpCodeId}`)).status).toBe(404);
      // 지운 BP 마스터의 아이디는 다시 쓰지 못한다.
      const availability = await call(
        'get',
        `/bp-masters/login-id-availability?loginId=bpmc${n}`,
      );
      expect(availability.body).toEqual({ available: false });
    });
  });

  it('탈퇴한 BP 는 이력이 409 이고, 상세에 탈퇴 정보가 실린다', async () => {
    const res = await call('post', '/bp-masters', createBody('w'));
    expect(res.status).toBe(201);
    const { bpCodeId } = res.body as CreateBpMasterResponseDto;
    bpCodeIds.push(bpCodeId);
    // 회원 탈퇴가 쓰는 칸만 그대로 바꾼다 — 이력 줄에는 탈퇴 전 이름이 남아 있다.
    const withdrawnAt = new Date('2026-10-20T01:00:00Z');
    await prisma.bpCode.update({
      where: { bpCodeId },
      data: { accountStatusCode: 'WITHDRAWN' },
    });
    await prisma.adminAccount.updateMany({
      where: { bpCodeId, roleTypeCode: 'BM' },
      data: {
        accountStatusCode: 'WITHDRAWN',
        statusChangedAt: withdrawnAt,
        name: null,
        phone: null,
        email: null,
        withdrawReasonCode: 'WD_CLOSE',
      },
    });

    const histories = await call('get', `/bp-masters/${bpCodeId}/histories`);
    expect(histories.status).toBe(409);
    expect(histories.body).toMatchObject({
      message: '탈퇴한 BP는 변경 이력을 볼 수 없습니다',
    });

    const detail = await call('get', `/bp-masters/${bpCodeId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      name: null,
      withdrawal: {
        withdrawnAt: withdrawnAt.toISOString(),
        reasonLabel: '폐업·사업 종료',
        reasonDetail: null,
      },
    });
  });
});
