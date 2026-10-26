import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailService } from '../mail/mail.service';
import type { OpsNotificationService } from '../notifications/ops-notification.service';
import { storeManagers as storeManagersOf } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import { ContractNoticeService } from './contract-notice.service';

// 받는 사람 고르기(1팀 관리자 · 점포 매핑 테이블)는 recipients 가 맡고 따로 시험한다 — 여기서는 누구에게 보내는지만 정한다
jest.mock('../notifications/recipients', () => ({
  storeManagers: jest.fn(),
}));
const storeManagers = jest.mocked(storeManagersOf);

describe('ContractNoticeService (근로계약 날인 · 거부 · 만료 · 갱신 예정 알림)', () => {
  let prisma: {
    contract: { findUnique: jest.Mock };
    store: { findUnique: jest.Mock };
    adminAccount: { findMany: jest.Mock };
  };
  let ops: { notify: jest.Mock };
  let mail: { send: jest.Mock };

  const contract = (o: Record<string, unknown> = {}) => ({
    contractId: 41,
    staffMemberId: 3,
    storeId: 11,
    rejectReason: null,
    endDate: new Date('2026-11-06T00:00:00Z'),
    staffMember: { name: '레코드이름' },
    contractParty: { enteredName: '홍길동' },
    ...o,
  });

  const service = ({
    withMail = true,
    adminWebUrl = 'https://dev.whaleerp.co.kr',
  } = {}) =>
    new ContractNoticeService(
      prisma as unknown as PrismaService,
      ops as unknown as OpsNotificationService,
      (withMail ? mail : null) as unknown as MailService | null,
      {
        get: (key: string) =>
          key === 'ADMIN_WEB_URL' ? adminWebUrl : undefined,
      } as unknown as ConfigService,
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    prisma = {
      contract: { findUnique: jest.fn().mockResolvedValue(contract()) },
      store: {
        findUnique: jest.fn().mockResolvedValue({ name: '모리커피 연남점' }),
      },
      adminAccount: {
        findMany: jest.fn().mockResolvedValue([
          { adminAccountId: 7, email: 'bm@test.invalid' },
          { adminAccountId: 8, email: null },
        ]),
      },
    };
    ops = { notify: jest.fn().mockResolvedValue({ notificationId: 1 }) };
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    storeManagers.mockReset().mockResolvedValue([7, 8]);
  });

  afterEach(() => jest.restoreAllMocks());

  it('날인 — 근무지를 맡은 관리자에게 운영 알림(사건 키 = 상태 이력 ID, 링크 = 계약 상세)과 메일을 따로 보낸다', async () => {
    await service().statusChanged('SIGNED', 41, 501);

    expect(storeManagers).toHaveBeenCalledWith(prisma, 3);
    expect(ops.notify).toHaveBeenCalledWith({
      templateCode: 'NTF_CONTRACT_SIGNED',
      variables: { 직원이름: '홍길동', 근무지: '모리커피 연남점' },
      related: { type: 'CONTRACT', id: 41 },
      link: '/contracts/41',
      eventKey: '501',
      recipients: [7, 8],
    });
    // 메일은 이메일이 있는 관리자에게만, 버튼은 업무 화면(ADMIN_WEB_URL + 계약 상세)으로 바로
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send).toHaveBeenCalledWith({
      templateCode: 'EMAIL_CONTRACT_SIGNED',
      to: 'bm@test.invalid',
      variables: {
        직원이름: '홍길동',
        근무지: '모리커피 연남점',
        링크: 'https://dev.whaleerp.co.kr/contracts/41',
      },
      adminAccountId: 7,
    });
  });

  it('거부 — 운영 알림에는 근무지가 없고(템플릿에 없는 변수는 렌더러가 던진다) 사유가 있으면 싣는다', async () => {
    prisma.contract.findUnique.mockResolvedValue(
      contract({ rejectReason: '근무 시간이 달라요' }),
    );

    await service().statusChanged('REJECTED', 41, 502);

    expect(ops.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'NTF_CONTRACT_REJECTED',
        variables: { 직원이름: '홍길동', 거부사유: '근무 시간이 달라요' },
        eventKey: '502',
      }),
    );
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'EMAIL_CONTRACT_REJECTED',
        variables: expect.objectContaining({
          근무지: '모리커피 연남점',
          거부사유: '근무 시간이 달라요',
        }) as object,
      }),
    );
  });

  it('거부 사유가 없으면 거부사유 변수를 넘기지 않는다(선택 변수)', async () => {
    await service().statusChanged('REJECTED', 41, 502);

    expect(ops.notify).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { 직원이름: '홍길동' } }),
    );
  });

  it('만료 — 같은 길로 알린다', async () => {
    await service().statusChanged('EXPIRED', 41, 503);

    expect(ops.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'NTF_CONTRACT_EXPIRED',
        eventKey: '503',
      }),
    );
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({ templateCode: 'EMAIL_CONTRACT_EXPIRED' }),
    );
  });

  it('갱신 예정 — 사건 키는 계약 ID, 계약 종료일은 「11월 6일」', async () => {
    await service().renewalDue(41);

    const variables = {
      직원이름: '홍길동',
      계약종료일: '11월 6일',
      근무지: '모리커피 연남점',
    };
    expect(ops.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'NTF_CONTRACT_RENEWAL_DUE',
        variables,
        eventKey: '41',
      }),
    );
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'EMAIL_CONTRACT_RENEWAL_DUE',
        variables: {
          ...variables,
          링크: 'https://dev.whaleerp.co.kr/contracts/41',
        },
      }),
    );
  });

  it('당사자 행이 없는 옛 계약은 직원 레코드 이름으로 알린다', async () => {
    prisma.contract.findUnique.mockResolvedValue(
      contract({ contractParty: null }),
    );

    await service().statusChanged('SIGNED', 41, 501);

    expect(ops.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { 직원이름: '레코드이름', 근무지: '모리커피 연남점' },
      }),
    );
  });

  it('받을 관리자가 없으면 아무것도 보내지 않는다', async () => {
    storeManagers.mockResolvedValue([]);

    await service().statusChanged('SIGNED', 41, 501);

    expect(ops.notify).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('메일 설정 · ADMIN_WEB_URL 이 없으면 메일만 건너뛰고 운영 알림은 보낸다', async () => {
    await service({ withMail: false }).statusChanged('SIGNED', 41, 501);
    await service({ adminWebUrl: '' }).statusChanged('SIGNED', 41, 501);

    expect(ops.notify).toHaveBeenCalledTimes(2);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('운영 알림 · 메일이 실패해도 던지지 않고, 서로의 실패에 묶이지 않는다', async () => {
    ops.notify.mockRejectedValue(new Error('db down'));
    prisma.adminAccount.findMany.mockResolvedValue([
      { adminAccountId: 7, email: 'a@test.invalid' },
      { adminAccountId: 8, email: 'b@test.invalid' },
    ]);
    mail.send
      .mockRejectedValueOnce(new Error('smtp'))
      .mockResolvedValueOnce(undefined);

    await expect(
      service().statusChanged('SIGNED', 41, 501),
    ).resolves.toBeUndefined();
    // 한 사람의 메일 실패가 다른 사람 메일을 막지 않는다
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it('계약을 읽지 못하면(지워짐 · DB 오류) 던지지 않고 보내지 않는다', async () => {
    prisma.contract.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service().statusChanged('SIGNED', 41, 501),
    ).resolves.toBeUndefined();
    prisma.contract.findUnique.mockResolvedValueOnce(null);
    await service().renewalDue(41);

    expect(ops.notify).not.toHaveBeenCalled();
  });
});
