import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import type {
  TemplateDetailDto,
  TemplateListResponseDto,
} from '../src/notification-templates/dto/template.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';

// 알림 템플릿 관리(WHALEERP-572 · 573 · 581)를 실제 DB 로 확인한다. 기본값 복사 마이그레이션, 채널별 CHECK,
// 템플릿 코드 고유, 이력 · 되돌리기는 목으로 증명되지 않는다.
describe('알림 템플릿 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let pmId: number;
  let bmId: number;
  let bpCodeId: number;
  const createdIds: number[] = [];
  const n = randomInt(100_000, 999_999);

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

    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { isPlatform: true },
    });
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '템플릿 테스트 BP',
      },
    }));
    const roleGroupId = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    const admin = async (
      key: string,
      bp: number,
      roleTypeCode: string,
      roleCode: string,
    ) =>
      (
        await prisma.adminAccount.create({
          data: {
            loginId: `tpl${key}${n}`,
            name: `템플릿${key}`,
            bpCodeId: bp,
            passwordHash: '!',
            roleTypeCode,
            roleGroupId: await roleGroupId(roleCode),
            joinPathCode: 'PLATFORM_REGISTERED',
            accountStatusCode: 'ACTIVE',
            isAllStores: true,
          },
        })
      ).adminAccountId;
    pmId = await admin('pm', platformBp.bpCodeId, 'PM', 'PM000001');
    bmId = await admin('bm', bpCodeId, 'BM', 'BM000001');
  });

  afterAll(async () => {
    await prisma.notificationTemplateHistory.deleteMany({
      where: { notificationTemplateId: { in: createdIds } },
    });
    await prisma.notificationTemplate.deleteMany({
      where: { notificationTemplateId: { in: createdIds } },
    });
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: [pmId, bmId] } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: [pmId, bmId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  // 가드가 관리자 세션을 확인하므로 실제 admin_sessions 행으로 토큰을 낸다.
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
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    body?: object,
    sub = pmId,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    const res = body ? await req.send(body) : await req;
    return { status: res.status, body: res.body as unknown };
  };
  /** 상세에서 수정 요청이 받는 칸만 고른다 */
  const editable = (d: TemplateDetailDto) => ({
    channel: d.channel,
    templateName: d.templateName,
    templateCode: d.templateCode,
    preferenceCategory: d.preferenceCategory,
    title: d.title,
    body: d.body,
    kakaoTemplateCode: d.kakaoTemplateCode,
    variables: d.variables,
  });
  const detail = async (id: number) =>
    (await call('get', `/notification-templates/${id}`))
      .body as TemplateDetailDto;

  it('마이그레이션이 처음 넣은 40건에 기본 문구를 복사했다 (NOTIFY-17)', async () => {
    await expect(
      prisma.notificationTemplate.count({
        where: { defaultBody: { not: null } },
      }),
    ).resolves.toBe(40);
  });

  it('채널 하나의 목록을 주고, 플랫폼 관리자가 아니면 403', async () => {
    const { status, body } = await call(
      'get',
      '/notification-templates?channel=NOTIFICATION',
    );
    expect(status).toBe(200);
    const list = body as TemplateListResponseDto;
    expect(list.total).toBe(10);
    expect(
      list.items.every((i) => i.channel === 'NOTIFICATION' && i.hasDefault),
    ).toBe(true);

    expect(
      (
        await call(
          'get',
          '/notification-templates?channel=NOTIFICATION',
          undefined,
          bmId,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call('get', '/notification-templates?channel=WRONG')).status,
    ).toBe(400);
  });

  describe('기본 템플릿 고치기 · 되돌리기', () => {
    let id: number;
    let original: TemplateDetailDto;

    // 공용 기본 템플릿을 고치면 같이 도는 다른 e2e(운영 알림)와 부딪힌다 — 기본 문구가 있는 템플릿을 따로 만든다.
    beforeAll(async () => {
      const variables = [
        {
          name: '직원이름',
          label: '직원 이름',
          isRequired: true,
          sampleValue: '문태경',
        },
        {
          name: '근무지',
          label: '근무지',
          isRequired: false,
          sampleValue: '판교점',
        },
      ];
      const row = await prisma.notificationTemplate.create({
        data: {
          templateCode: `NTF_E2E_BASE_${n}`,
          channel: 'NOTIFICATION',
          templateName: `e2e 기본 ${n}`,
          title: '#{직원이름} 님이 날인했습니다',
          body: '#{근무지} 근로계약',
          variables,
          defaultTitle: '#{직원이름} 님이 날인했습니다',
          defaultBody: '#{근무지} 근로계약',
          defaultVariables: variables,
        },
      });
      id = row.notificationTemplateId;
      createdIds.push(id);
      original = await detail(id);
    });

    it('검사에 걸리면 400 과 고칠 문장, 읽은 시각이 다르면 409', async () => {
      const base = editable(original);
      const bad = await call('put', `/notification-templates/${id}`, {
        ...base,
        body: '#{없는변수}',
        updatedAt: original.updatedAt,
      });
      expect(bad.status).toBe(400);
      expect((bad.body as { message: string[] }).message).toContain(
        '본문 1번째 줄: #{없는변수} 는 변수 목록에 없습니다.',
      );

      const long = await call('put', `/notification-templates/${id}`, {
        ...base,
        title: '가'.repeat(201),
        updatedAt: original.updatedAt,
      });
      expect((long.body as { message: string[] }).message).toContain(
        '제목은 200자를 넘을 수 없습니다.',
      );

      const stale = await call('put', `/notification-templates/${id}`, {
        ...base,
        updatedAt: '2000-01-01T00:00:00.000Z',
      });
      expect(stale.status).toBe(409);
    });

    it('고치면 이력이 쌓이고, 되돌리면 제목 · 본문 · 변수 목록만 기본값으로 돌아간다', async () => {
      const base = editable(original);
      const edited = await call('put', `/notification-templates/${id}`, {
        ...base,
        templateCode: `NTF_E2E_${n}`,
        body: `고친 본문 #{근무지}`,
        updatedAt: original.updatedAt,
      });
      expect(edited.status).toBe(200);
      const after = edited.body as TemplateDetailDto;
      expect(after.updatedByName).toBe('템플릿pm');
      expect(after.histories[0].summary).toBe('템플릿 코드 · 본문');

      const restored = await call(
        'post',
        `/notification-templates/${id}/restore`,
        {
          updatedAt: after.updatedAt,
        },
      );
      expect(restored.status).toBe(200);
      const back = restored.body as TemplateDetailDto;
      expect(back.body).toBe(original.body);
      expect(back.title).toBe(original.title);
      expect(back.templateCode).toBe(`NTF_E2E_${n}`); // 코드는 그대로 (NOTIFY-18)
      expect(back.histories).toHaveLength(2);
    });

    it('채널을 앱 푸시로 바꾼 뒤 되돌리면 지금 채널 규칙으로 검사해 400', async () => {
      const now = await detail(id);
      const pushed = await call('put', `/notification-templates/${id}`, {
        ...editable(now),
        channel: 'PUSH',
        preferenceCategory: 'CONTRACT',
        updatedAt: now.updatedAt,
      });
      expect(pushed.status).toBe(200);
      // 기본 본문을 앱 푸시 100자보다 길게 해 둔다.
      await prisma.notificationTemplate.update({
        where: { notificationTemplateId: id },
        data: { defaultBody: `#{근무지} ${'가'.repeat(101)}` },
      });
      const after = await detail(id);
      const res = await call('post', `/notification-templates/${id}/restore`, {
        updatedAt: after.updatedAt,
      });
      expect(res.status).toBe(400);
      expect((res.body as { message: string[] }).message).toContain(
        '본문은 100자를 넘을 수 없습니다(지금 108자).',
      );
    });
  });

  describe('등록 · 사용 여부', () => {
    let createdId: number;
    const push = () => ({
      channel: 'PUSH',
      templateName: `e2e 푸시 ${n}`,
      templateCode: `PUSH_E2E_${n}`,
      preferenceCategory: 'SCHEDULE',
      title: '근무스케줄이 바뀌었습니다',
      body: '#{날짜} 근무가 바뀌었습니다',
      kakaoTemplateCode: null,
      variables: [
        { name: '날짜', label: '날짜', isRequired: true, sampleValue: '10-14' },
      ],
      isActive: true,
    });

    it('등록하면 기본 문구 없이 만들어지고 되돌리기는 409', async () => {
      const res = await call('post', '/notification-templates', push());
      expect(res.status).toBe(201);
      const created = res.body as TemplateDetailDto;
      createdIds.push(created.id);
      createdId = created.id;
      expect(created.hasDefault).toBe(false);

      const restore = await call(
        'post',
        `/notification-templates/${created.id}/restore`,
        {
          updatedAt: created.updatedAt,
        },
      );
      expect(restore.status).toBe(409);
    });

    it('같은 템플릿 코드로 다시 등록하면 409', async () => {
      expect(
        (await call('post', '/notification-templates', push())).status,
      ).toBe(409);
    });

    it('사용 안 함으로 끄면 이력이 남는다', async () => {
      const id = createdId;
      const before = await detail(id);
      const res = await call('patch', `/notification-templates/${id}/active`, {
        isActive: false,
        updatedAt: before.updatedAt,
      });
      expect(res.status).toBe(200);
      expect((res.body as TemplateDetailDto).isActive).toBe(false);
      expect((res.body as TemplateDetailDto).histories[0].summary).toBe(
        '사용 여부',
      );
    });

    it('범위 밖 id 는 404', async () => {
      expect(
        (await call('get', '/notification-templates/2147483648')).status,
      ).toBe(404);
    });
  });

  // CHECK 위반을 일부러 일으키므로 맨 뒤에 둔다 — PGlite 는 그 뒤 응답 순서가 어긋난다.
  it('DB 도 기본 본문과 기본 변수 목록을 함께만 받는다', async () => {
    await expect(
      prisma.notificationTemplate.create({
        data: {
          templateCode: `NTF_BAD_${n}`,
          channel: 'NOTIFICATION',
          templateName: 'bad',
          title: 't',
          body: 'b',
          variables: [],
          defaultBody: 'b',
        },
      }),
    ).rejects.toThrow();
  });
});
