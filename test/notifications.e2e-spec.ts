import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type {
  NotificationItemDto,
  NotificationListResponseDto,
} from '../src/notifications/dto/notification-item.response.dto';
import { OpsNotificationService } from '../src/notifications/ops-notification.service';
import {
  platformOperators,
  storeManagers,
} from '../src/notifications/recipients';
import { PrismaService } from '../src/prisma/prisma.service';

// 운영 알림(WHALEERP-246~252)을 실제 DB 로 확인한다. 수신자 판정의 관계 조건(점포 매핑), 중복 방지 부분 유일
// 인덱스, 받는 사람 CHECK 는 목으로는 증명되지 않는다.
describe('운영 알림 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ops: OpsNotificationService;

  let bpCodeId: number;
  let otherBpId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let bmId: number; // BP 마스터, 전체 점포
  let baId: number; // BP 관리자, 직영점만 매핑
  let fmId: number; // 가맹마스터, 가맹점 매핑
  let offId: number; // 사용 안 함 BP 마스터
  let otherBmId: number; // 다른 BP 의 BP 마스터
  let pmId: number; // 플랫폼 마스터
  const adminIds: number[] = [];
  const notificationIds: number[] = [];
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
    ops = app.get(OpsNotificationService);

    const bp = (code: number, name: string) =>
      prisma.bpCode.create({
        data: {
          bpCode: `BP${code}`,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: name,
        },
      });
    const store = (code: number, bp: number, storeTypeCode: string) =>
      prisma.store.create({
        data: {
          storeCode: `ST${code}`,
          bpCodeId: bp,
          storeTypeCode,
          name: `알림 테스트 ${storeTypeCode}`,
          storeStatusCode: 'OPERATING',
        },
      });
    ({ bpCodeId } = await bp(n, '알림 테스트 BP'));
    ({ bpCodeId: otherBpId } = await bp((n + 1) % 1_000_000, '다른 BP'));
    ({ storeId: directStoreId } = await store(n, bpCodeId, 'DIRECT'));
    ({ storeId: franchiseStoreId } = await store(
      (n + 1) % 1_000_000,
      bpCodeId,
      'FRANCHISE',
    ));

    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { isPlatform: true },
    });
    const roleGroupId = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    const admin = async (
      key: string,
      bp: number,
      roleTypeCode: string,
      roleCode: string,
      extra: object = {},
    ) => {
      const a = await prisma.adminAccount.create({
        data: {
          loginId: `ntf${key}${n}`,
          bpCodeId: bp,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId: await roleGroupId(roleCode),
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: false,
          ...extra,
        },
      });
      adminIds.push(a.adminAccountId);
      return a.adminAccountId;
    };
    bmId = await admin('bm', bpCodeId, 'BM', 'BM000001', { isAllStores: true });
    baId = await admin('ba', bpCodeId, 'BA', 'BM000001', {
      storeMappings: { create: { storeId: directStoreId } },
    });
    fmId = await admin('fm', bpCodeId, 'FM', 'FM000001', {
      storeMappings: { create: { storeId: franchiseStoreId } },
    });
    offId = await admin('off', bpCodeId, 'BM', 'BM000001', {
      isAllStores: true,
      accountStatusCode: 'INACTIVE',
    });
    otherBmId = await admin('obm', otherBpId, 'BM', 'BM000001', {
      isAllStores: true,
    });
    pmId = await admin('pm', platformBp.bpCodeId, 'PM', 'PM000001');
  });

  afterAll(async () => {
    const byNotification = { notificationId: { in: notificationIds } };
    await prisma.notificationRecipient.deleteMany({ where: byNotification });
    await prisma.notification.deleteMany({ where: byNotification });
    await prisma.adminStoreMapping.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [directStoreId, franchiseStoreId] } },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpId] } },
    });
    await app.close();
  });

  const signed = (eventKey: string, storeId = directStoreId) =>
    storeManagers(prisma, storeId).then((recipients) =>
      ops.notify({
        templateCode: 'NTF_CONTRACT_SIGNED',
        variables: { 직원이름: '문태경', 근무지: '알림 테스트 직영점' },
        related: { type: 'CONTRACT', id: 41 },
        eventKey: `e2e-${n}-${eventKey}`,
        recipients,
      }),
    );
  const track = <T extends { notificationId: number } | null>(r: T) => {
    if (r) notificationIds.push(r.notificationId);
    return r;
  };

  const tokenOf = (sub: number, type = 'admin') =>
    app.get(JwtService).signAsync({
      sub,
      type,
      email: 'a@test.invalid',
      typ: 'access',
    });
  const call = async (
    method: 'get' | 'post' | 'delete',
    path: string,
    sub = bmId,
  ) => {
    const res = await request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    return { status: res.status, body: res.body as unknown };
  };
  const list = async (sub: number, query = '') => {
    const res = await call('get', `/notifications${query}`, sub);
    return { ...res, body: res.body as NotificationListResponseDto };
  };

  describe('수신자 판정', () => {
    it('직영점은 BP 의 전체 점포 관리자와 그 점포가 매핑된 관리자가 받는다', async () => {
      const ids = await storeManagers(prisma, directStoreId);
      expect(ids.sort()).toEqual([bmId, baId].sort());
    });

    it('가맹점은 가맹마스터만 받는다 — BP 마스터는 빠진다 (NOTIFY-13 후보 A)', async () => {
      await expect(storeManagers(prisma, franchiseStoreId)).resolves.toEqual([
        fmId,
      ]);
    });

    it('사용 안 함 관리자와 다른 BP 관리자는 받지 않는다', async () => {
      const ids = await storeManagers(prisma, directStoreId);
      expect(ids).not.toContain(offId);
      expect(ids).not.toContain(otherBmId);
    });

    it('플랫폼 운영자에 플랫폼 마스터가 들어가고 사업자 관리자는 없다', async () => {
      const ids = await platformOperators(prisma);
      expect(ids).toContain(pmId);
      expect(ids).not.toContain(bmId);
    });
  });

  describe('공통 함수 notify', () => {
    it('알림 한 행과 받는 사람마다 수신 행을 만든다', async () => {
      const result = track(await signed('first'));

      expect(result?.recipients.map((r) => r.adminAccountId).sort()).toEqual(
        [bmId, baId].sort(),
      );
      const stored = await prisma.notification.findUniqueOrThrow({
        where: { notificationId: result!.notificationId },
      });
      expect(stored).toMatchObject({
        notificationTarget: 'ADMIN',
        templateCode: 'NTF_CONTRACT_SIGNED',
        relatedType: 'CONTRACT',
        relatedId: 41,
        body: '문태경 님이 근로계약서에 날인했습니다\n알림 테스트 직영점',
        dedupeKey: `NTF_CONTRACT_SIGNED:e2e-${n}-first`,
      });
    });

    it('같은 사건으로 다시 부르면 만들지 않는다 (부분 유일 인덱스)', async () => {
      await expect(signed('first')).resolves.toBeNull();
      await expect(
        prisma.notification.count({
          where: { dedupeKey: `NTF_CONTRACT_SIGNED:e2e-${n}-first` },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('운영 알림함 API', () => {
    let mineId: number;

    beforeAll(async () => {
      track(await signed('api'));
      const { body } = await list(bmId);
      mineId = body.items[0].id;
    });

    it('내 알림만 최신순으로 주고 제목·둘째 줄·구분·미확인 건수를 준다', async () => {
      const { status, body } = await list(bmId, '?pageSize=5');

      expect(status).toBe(200);
      expect(body.total).toBe(2);
      expect(body.unreadCount).toBe(2);
      expect(body.items[0]).toMatchObject({
        templateCode: 'NTF_CONTRACT_SIGNED',
        kind: '근로계약 날인',
        title: '문태경 님이 근로계약서에 날인했습니다',
        body: '알림 테스트 직영점',
        relatedType: 'CONTRACT',
        relatedId: 41,
        isRead: false,
      });
    });

    it('다른 사람의 알림은 보이지 않는다', async () => {
      await expect(list(fmId)).resolves.toMatchObject({
        body: { total: 0, unreadCount: 0 },
      });
    });

    it('남의 알림을 읽음 처리하면 404', async () => {
      const { status } = await call(
        'post',
        `/notifications/${mineId}/read`,
        fmId,
      );
      expect(status).toBe(404);
    });

    it('읽음 처리하면 그 한 줄을 주고 미확인 건수가 준다. 다시 읽어도 읽은 시각은 그대로다', async () => {
      const first = await call('post', `/notifications/${mineId}/read`);
      expect(first.status).toBe(200);
      expect(first.body as NotificationItemDto).toMatchObject({
        id: mineId,
        isRead: true,
        relatedType: 'CONTRACT',
      });
      const { readAt } = await prisma.notificationRecipient.findUniqueOrThrow({
        where: { notificationRecipientId: mineId },
      });

      await call('post', `/notifications/${mineId}/read`);
      await expect(
        prisma.notificationRecipient.findUniqueOrThrow({
          where: { notificationRecipientId: mineId },
        }),
      ).resolves.toMatchObject({ readAt });
      await expect(list(bmId)).resolves.toMatchObject({
        body: { unreadCount: 1 },
      });
    });

    it('모두 읽음은 내 미확인만 바꾼다', async () => {
      const { status, body } = await call('post', '/notifications/read-all');
      expect(status).toBe(200);
      expect(body).toEqual({ updated: 1 });
      // 같은 사건을 받은 BP 관리자의 알림은 그대로 미확인이다.
      await expect(list(baId)).resolves.toMatchObject({
        body: { unreadCount: 2 },
      });
    });

    it('선택 삭제는 내 것만 지우고 같은 알림을 받은 다른 사람의 것은 남긴다', async () => {
      const { body: theirs } = await list(baId);
      const res = await call(
        'delete',
        `/notifications?ids=${mineId},${theirs.items[0].id}`,
      );

      expect(res.status).toBe(204);
      await expect(list(bmId)).resolves.toMatchObject({ body: { total: 1 } });
      await expect(list(baId)).resolves.toMatchObject({ body: { total: 2 } });
    });

    it('쿼리 형식 오류는 400, 범위 밖 ID 는 404', async () => {
      expect((await call('get', '/notifications?page=0')).status).toBe(400);
      expect((await call('get', '/notifications?pageSize=201')).status).toBe(
        400,
      );
      expect((await call('delete', '/notifications?ids=abc')).status).toBe(400);
      expect((await call('delete', '/notifications?ids=3,,5')).status).toBe(
        400,
      );
      expect((await call('delete', '/notifications')).status).toBe(400);
      expect(
        (await call('post', '/notifications/2147483648/read')).status,
      ).toBe(404);
    });

    it('사용 안 함 관리자와 직원 앱 토큰은 403', async () => {
      expect((await list(offId)).status).toBe(403);
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${await tokenOf(1, 'staff')}`);
      expect(res.status).toBe(403);
    });
  });
});
