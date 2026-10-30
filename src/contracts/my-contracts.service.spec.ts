import { HttpException, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ContractNoticeService } from './contract-notice.service';
import { MY_CONTRACT_STATUSES } from './my-contract-scope';
import { MyContractsService } from './my-contracts.service';

const NOW = new Date('2026-10-21T05:00:00.000Z');
const SENT = new Date('2026-10-20T01:00:00.000Z');
const SENT_ISO = SENT.toISOString();
const HISTORY_AT = new Date('2026-10-21T05:00:00.123Z');

/** 직원 앱 날인 · 거부 · 수정 요청(WHALEERP-145) */
describe('MyContractsService', () => {
  let png: Buffer;
  let tx: {
    $executeRaw: jest.Mock;
    contract: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    contractStatusHistory: { create: jest.Mock; findFirstOrThrow: jest.Mock };
    contractDocument: { create: jest.Mock; findFirst: jest.Mock };
    contractParty: { update: jest.Mock };
    staffMember: { updateMany: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };
  let storage: { put: jest.Mock; delete: jest.Mock };
  // 날인 · 거부 알림(WHALEERP-154) — 무엇을 넘기는지만 본다(ContractNoticeService 는 따로 시험한다)
  let notice: { statusChanged: jest.Mock };

  /** 내 계약 — 서명 대기 · 기한 안 · 계약서 값과 계정 값이 같다 */
  const mine = (o: Record<string, unknown> = {}) => ({
    status: 'PENDING_SIGNATURE',
    sentAt: SENT,
    signDeadlineAt: new Date('2026-11-19T01:00:00.000Z'),
    contractParty: {
      enteredName: '홍길동',
      enteredPhone: '01090145563',
      enteredBirthDate: new Date('1995-03-02T00:00:00.000Z'),
      enteredGender: 'FEMALE',
      isForeigner: false,
    },
    staffMember: {
      employmentStatus: 'EMPLOYED',
      retiredDate: null,
      account: {
        realName: '홍길동',
        phone: '01090145563',
        birthDate: new Date('1995-03-02T00:00:00.000Z'),
        gender: 'FEMALE',
        isForeigner: false,
        zipCode: '04001',
        address: '서울 마포구 동교로 1',
        addressDetail: '2층',
      },
    },
    ...o,
  });
  const service = (withStorage = true) =>
    new MyContractsService(
      prisma as unknown as PrismaService,
      (withStorage ? storage : null) as unknown as StorageService | null,
      notice as unknown as ContractNoticeService,
    );
  const file = () => ({ buffer: png, size: png.length });
  const thrown = async (run: Promise<unknown>) => {
    try {
      await run;
    } catch (e) {
      return e as HttpException;
    }
    throw new Error('던지지 않았다');
  };
  const bodyOf = (e: HttpException) =>
    e.getResponse() as Record<string, unknown>;
  /** 잠금 SQL — 값 자리를 ? 로 */
  const locks = () =>
    tx.$executeRaw.mock.calls.map(([sql]: [TemplateStringsArray]) =>
      sql.join('?'),
    );

  beforeAll(async () => {
    png = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
  });

  beforeEach(() => {
    notice = { statusChanged: jest.fn().mockResolvedValue(undefined) };
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      contract: {
        findFirst: jest.fn().mockResolvedValue(mine()),
        // 전환 함수(기한 · 상태)가 잠근 뒤 읽는 값
        findUnique: jest.fn().mockResolvedValue({
          status: 'PENDING_SIGNATURE',
          signDeadlineAt: new Date('2026-11-19T01:00:00.000Z'),
          staffMemberId: 5,
          startDate: new Date('2026-11-24T00:00:00.000Z'),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      contractStatusHistory: {
        create: jest.fn(),
        // 날인 시각은 이력의 처리 시각(DB 시계)이다
        findFirstOrThrow: jest.fn().mockResolvedValue({
          changedAt: HISTORY_AT,
          contractStatusHistoryId: 501,
        }),
      },
      // 날인 오류 뒤 커밋 여부 확인 — 서명 행이 없으면 null
      contractDocument: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      contractParty: { update: jest.fn() },
      staffMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      ...tx,
      $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    };
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
  });
  afterEach(() => jest.restoreAllMocks());

  describe('날인', () => {
    it('서명을 올리고, 계약 행을 잠근 뒤 다시 읽어 체결 완료로 — 서명 행과 계정 주소를 남긴다', async () => {
      await expect(
        service().sign(77, 41, file(), SENT_ISO, NOW),
      ).resolves.toEqual({
        contractId: 41,
        status: 'SIGNED',
        signedAt: HISTORY_AT,
      });
      // 내 계약 — 내 계정에 이어진 레코드(후보 계정은 아니다), 서명 대기 이후(조회 API 와 같은 기준)
      expect(
        (tx.contract.findFirst.mock.calls[0] as unknown[])[0],
      ).toMatchObject({
        where: {
          contractId: 41,
          status: { in: MY_CONTRACT_STATUSES },
          staffMember: { accountId: 77 },
        },
      });
      const [key, body, kind] = storage.put.mock.calls[0] as [
        string,
        Buffer,
        string,
      ];
      expect(key).toMatch(/^contracts\/41\/[0-9a-f-]+\.png$/);
      expect([body, kind]).toEqual([png, 'PNG']);
      // 올린 뒤 직원 행(FOR NO KEY UPDATE — 입사일을 쓴다) → 계약 행(FOR UPDATE)을 잠그고 다시 읽는다 — 퇴직 확정과 같은 순서
      expect(storage.put.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$executeRaw.mock.invocationCallOrder[0],
      );
      // 뒤의 계약 행 잠금은 전환 함수가 같은 행을 다시 잡는 것(이미 쥐고 있어 기다리지 않는다)
      expect(locks().slice(0, 2)).toEqual([
        expect.stringMatching(/FROM staff_members .* FOR NO KEY UPDATE$/),
        expect.stringMatching(/FROM contracts .* FOR UPDATE$/),
      ]);
      expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
        tx.contract.findFirst.mock.invocationCallOrder[2],
      );
      expect(tx.contract.updateMany).toHaveBeenCalledWith({
        where: { contractId: 41, status: 'PENDING_SIGNATURE' },
        data: { status: 'SIGNED' },
      });
      expect(tx.contractStatusHistory.create).toHaveBeenCalledWith({
        data: {
          contractId: 41,
          fromStatus: 'PENDING_SIGNATURE',
          toStatus: 'SIGNED',
          actor: 'STAFF',
        },
      });
      expect(tx.contractDocument.create).toHaveBeenCalledWith({
        data: {
          contractId: 41,
          kind: 'SIGNATURE',
          storageKey: key,
          fileName: '서명-41.png',
          checksum: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        },
      });
      expect(tx.contractParty.update).toHaveBeenCalledWith({
        where: { contractId: 41 },
        data: {
          zipCode: '04001',
          address: '서울 마포구 동교로 1',
          addressDetail: '2층',
          filledAt: NOW,
        },
      });
      // 입사일이 비어 있으면 계약 시작일로(WHALEERP-613)
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: {
          staffMemberId: 5,
          hiredDate: null,
          // 퇴직일이 시작일보다 앞선 레코드는 채우지 않는다 — 입사 전에 끝나는 근무다
          OR: [
            { retiredDate: null },
            { retiredDate: { gte: new Date('2026-11-24T00:00:00.000Z') } },
          ],
        },
        data: { hiredDate: new Date('2026-11-24T00:00:00.000Z') },
      });
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it.each<[string, () => void, number, Record<string, unknown>]>([
      [
        '남의 계약 · 후보 계정만 있는 계약',
        () => tx.contract.findFirst.mockResolvedValue(null),
        404,
        {},
      ],
      [
        '이미 체결 완료',
        () =>
          tx.contract.findFirst.mockResolvedValue(mine({ status: 'SIGNED' })),
        409,
        { code: 'CONTRACT_STATUS_CONFLICT', status: 'SIGNED' },
      ],
      [
        '날인 기한이 지남',
        () =>
          tx.contract.findFirst.mockResolvedValue(
            mine({ signDeadlineAt: NOW }),
          ),
        409,
        { code: 'SIGN_DEADLINE_PASSED' },
      ],
      [
        '본인 대조가 틀림',
        () =>
          tx.contract.findFirst.mockResolvedValue(
            mine({
              contractParty: {
                ...mine().contractParty,
                enteredName: '홍길순',
                isForeigner: true,
              },
            }),
          ),
        409,
        { code: 'IDENTITY_MISMATCH', mismatches: ['name', 'isForeigner'] },
      ],
    ])(
      '%s — 저장소를 부르기 전에 막는다',
      async (_label, setup, status, body) => {
        setup();
        const e = await thrown(service().sign(77, 41, file(), SENT_ISO, NOW));
        expect(e.getStatus()).toBe(status);
        expect(bodyOf(e)).toMatchObject(body);
        expect(storage.put).not.toHaveBeenCalled();
        // 미리 확인은 읽기만 — 계약 행을 잠그지도 바꾸지도 않는다
        expect(tx.$executeRaw).not.toHaveBeenCalled();
        expect(tx.contract.updateMany).not.toHaveBeenCalled();
      },
    );

    it('본 뒤 다시 발송됐으면(발송 일시가 다름) 409 CONTRACT_RESENT — 올리지 않는다', async () => {
      const e = await thrown(
        service().sign(77, 41, file(), '2026-10-19T01:00:00.000Z', NOW),
      );
      expect(bodyOf(e)).toMatchObject({ code: 'CONTRACT_RESENT' });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('계정 성별이 비어 있어도 성별을 본다 — 409 IDENTITY_MISMATCH(가입 때 필수, 2026-10-21 재영)', async () => {
      tx.contract.findFirst.mockResolvedValue(
        mine({
          staffMember: {
            ...mine().staffMember,
            account: { ...mine().staffMember.account, gender: null },
          },
        }),
      );
      const e = await thrown(service().sign(77, 41, file(), SENT_ISO, NOW));
      expect(bodyOf(e)).toMatchObject({
        code: 'IDENTITY_MISMATCH',
        mismatches: ['gender'],
      });
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('당사자 행이 없으면 빈 계약서로 대조한다 — 409', async () => {
      tx.contract.findFirst.mockResolvedValue(mine({ contractParty: null }));
      const e = await thrown(service().sign(77, 41, file(), SENT_ISO, NOW));
      expect(bodyOf(e)).toMatchObject({
        code: 'IDENTITY_MISMATCH',
        mismatches: ['name', 'phone', 'birthDate', 'gender'],
      });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it.each<[string, () => { buffer: Buffer; size: number } | undefined]>([
      ['서명이 없으면', () => undefined],
      [
        'PNG 가 아니면',
        () => ({ buffer: Buffer.from('%PDF-1.4 x'), size: 10 }),
      ],
      ['1MB 를 넘으면', () => ({ buffer: png, size: 1024 * 1024 + 1 })],
      [
        'PNG 머리만 있고 읽을 수 없으면',
        () => {
          const broken = Buffer.concat([png.subarray(0, 16), Buffer.alloc(8)]);
          return { buffer: broken, size: broken.length };
        },
      ],
    ])('%s 400 — 올리지 않는다', async (_label, f) => {
      const e = await thrown(service().sign(77, 41, f(), SENT_ISO, NOW));
      expect(e.getStatus()).toBe(400);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('가로 · 세로가 4096px 를 넘으면 400 — 올리지 않는다', async () => {
      const wide = await sharp({
        create: {
          width: 4097,
          height: 2,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
      const e = await thrown(
        service().sign(
          77,
          41,
          { buffer: wide, size: wide.length },
          SENT_ISO,
          NOW,
        ),
      );
      expect(e.getStatus()).toBe(400);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('날짜로 바꿀 수 없는 발송 일시는 400 — 재발송(409)이 아니다', async () => {
      const e = await thrown(service().sign(77, 41, file(), '2026-W43', NOW));
      expect(e.getStatus()).toBe(400);
    });

    it('올리기가 실패하면 503 — 쓰지 않고, 실제로는 올라갔을 수 있어 지워 본다', async () => {
      storage.put.mockRejectedValue(new Error('S3 시간 초과'));
      storage.delete.mockRejectedValue(new Error('S3 끊김'));
      const e = await thrown(service().sign(77, 41, file(), SENT_ISO, NOW));
      expect(e.getStatus()).toBe(503);
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
      const [key] = storage.put.mock.calls[0] as [string];
      expect(storage.delete).toHaveBeenCalledWith(key, { thumbnail: false });
    });

    it('쓰기도 지우기도 실패하면 지우기 오류는 삼키고 쓰기 오류를 던진다', async () => {
      tx.contractDocument.create.mockRejectedValue(new Error('DB 끊김'));
      storage.delete.mockRejectedValue(new Error('S3 끊김'));
      await expect(
        service().sign(77, 41, file(), SENT_ISO, NOW),
      ).rejects.toThrow('DB 끊김');
    });

    it('저장소가 설정되지 않았으면 503', async () => {
      const e = await thrown(
        service(false).sign(77, 41, file(), SENT_ISO, NOW),
      );
      expect(e.getStatus()).toBe(503);
    });

    it('잠근 뒤 다시 읽으니 그사이 관리자가 근로자 정보를 고쳤으면 409 — 올린 서명을 지운다', async () => {
      tx.contract.findFirst
        .mockResolvedValueOnce(mine()) // 미리 확인
        .mockResolvedValueOnce(mine()) // 잠글 직원 행 찾기
        .mockResolvedValueOnce(
          mine({
            contractParty: {
              ...mine().contractParty,
              enteredPhone: '01011112222',
            },
          }),
        );
      const e = await thrown(service().sign(77, 41, file(), SENT_ISO, NOW));
      expect(bodyOf(e)).toMatchObject({
        code: 'IDENTITY_MISMATCH',
        mismatches: ['phone'],
      });
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
      const [key] = storage.put.mock.calls[0] as [string];
      expect(storage.delete).toHaveBeenCalledWith(key, { thumbnail: false });
    });

    it('올리는 동안 기한이 지나면 잠근 시각으로 다시 봐 409 — 올린 서명을 지운다', async () => {
      const deadline = mine().signDeadlineAt;
      jest.useFakeTimers({
        now: deadline.getTime() - 1000,
        doNotFake: ['nextTick', 'setImmediate'],
      });
      try {
        storage.put.mockImplementation(() => {
          jest.setSystemTime(deadline.getTime() + 1000);
          return Promise.resolve();
        });
        const e = await thrown(service().sign(77, 41, file(), SENT_ISO));
        expect(bodyOf(e)).toMatchObject({ code: 'SIGN_DEADLINE_PASSED' });
        expect(tx.contract.updateMany).not.toHaveBeenCalled();
        expect(storage.delete).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('쓰기가 실패하면 올린 서명을 지우고 그 오류를 그대로 던진다', async () => {
      tx.contractDocument.create.mockRejectedValue(new Error('DB 끊김'));
      await expect(
        service().sign(77, 41, file(), SENT_ISO, NOW),
      ).rejects.toThrow('DB 끊김');
      expect(storage.delete).toHaveBeenCalled();
    });

    it.each<[string, () => void]>([
      [
        '서명 행이 있으면(커밋 응답만 끊김)',
        () =>
          tx.contractDocument.findFirst.mockResolvedValue({ contractId: 41 }),
      ],
      [
        '커밋 여부를 확인할 수 없으면',
        () =>
          tx.contractDocument.findFirst.mockRejectedValue(new Error('DB 끊김')),
      ],
    ])(
      '트랜잭션 오류라도 %s 서명을 지우지 않는다 — 처리 완료본(131)의 재료',
      async (_label, setup) => {
        setup();
        prisma.$transaction
          .mockImplementationOnce((work: (t: typeof tx) => unknown) => work(tx))
          .mockRejectedValueOnce(new Error('연결 끊김'));
        await expect(
          service().sign(77, 41, file(), SENT_ISO, NOW),
        ).rejects.toThrow('연결 끊김');
        const [key] = storage.put.mock.calls[0] as [string];
        expect(tx.contractDocument.findFirst).toHaveBeenCalledWith({
          where: { storageKey: key },
          select: { contractId: true },
        });
        expect(storage.delete).not.toHaveBeenCalled();
      },
    );

    it.each<[string, Record<string, unknown>]>([
      [
        '퇴직',
        { employmentStatus: 'RETIRED', retiredDate: new Date('2026-10-01') },
      ],
      // 퇴직일 다음 날부터 — 배치(retireDue)가 아직 돌지 않았어도
      ['퇴직일이 지남(배치 전)', { retiredDate: new Date('2026-10-20') }],
    ])(
      '%s 직원이면 409 STAFF_RETIRED — 올리지 않는다',
      async (_label, staff) => {
        tx.contract.findFirst.mockResolvedValue(
          mine({ staffMember: { ...mine().staffMember, ...staff } }),
        );
        const e = await thrown(service().sign(77, 41, file(), SENT_ISO, NOW));
        expect(bodyOf(e)).toMatchObject({ code: 'STAFF_RETIRED' });
        expect(storage.put).not.toHaveBeenCalled();
      },
    );

    it('퇴직일 당일까지는 날인할 수 있다', async () => {
      tx.contract.findFirst.mockResolvedValue(
        mine({
          staffMember: {
            ...mine().staffMember,
            retiredDate: new Date('2026-10-21'),
          },
        }),
      );
      await service().sign(77, 41, file(), SENT_ISO, NOW);
      expect(tx.contract.updateMany).toHaveBeenCalled();
    });

    it('잠근 뒤 다시 읽으니 그사이 퇴직 확정됐으면 409 STAFF_RETIRED — 올린 서명을 지운다', async () => {
      tx.contract.findFirst
        .mockResolvedValueOnce(mine())
        .mockResolvedValueOnce(mine())
        .mockResolvedValueOnce(
          mine({
            staffMember: {
              ...mine().staffMember,
              employmentStatus: 'RETIRED',
              retiredDate: new Date('2026-10-20'),
            },
          }),
        );
      const e = await thrown(service().sign(77, 41, file(), SENT_ISO, NOW));
      expect(bodyOf(e)).toMatchObject({ code: 'STAFF_RETIRED' });
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalled();
    });
  });

  describe('거부 · 수정 요청', () => {
    it.each<[string, (s: MyContractsService) => Promise<unknown>]>([
      ['거부', (s) => s.reject(77, 41, NOW)],
      ['수정 요청', (s) => s.requestCorrection(77, 41, '사유', NOW)],
    ])(
      '%s도 직원 행 → 계약 행을 잠그고, 퇴직한 직원이면 409 STAFF_RETIRED',
      async (_label, run) => {
        tx.contract.findFirst.mockResolvedValue(
          mine({
            staffMember: { ...mine().staffMember, employmentStatus: 'RETIRED' },
          }),
        );
        const e = await thrown(run(service()));
        expect(bodyOf(e)).toMatchObject({ code: 'STAFF_RETIRED' });
        expect(locks()).toEqual([
          expect.stringMatching(/FROM staff_members .* FOR SHARE$/),
          expect.stringMatching(/FROM contracts .* FOR UPDATE$/),
        ]);
        expect(tx.contract.updateMany).not.toHaveBeenCalled();
      },
    );

    it('거부 — 내 계약인지 본 뒤 거부로(사유는 받지 않는다, WHALEERP-635)', async () => {
      await expect(service().reject(77, 41, NOW)).resolves.toEqual({
        contractId: 41,
        status: 'REJECTED',
      });
      expect(tx.contract.updateMany).toHaveBeenCalledWith({
        where: { contractId: 41, status: 'PENDING_SIGNATURE' },
        data: { status: 'REJECTED' },
      });
    });

    it('날인 · 거부가 커밋되면 그 상태 이력을 사건 키로 관리자에게 알린다(WHALEERP-154)', async () => {
      await service().sign(77, 41, file(), SENT_ISO, NOW);
      expect(notice.statusChanged).toHaveBeenCalledWith('SIGNED', 41, 501);

      await service().reject(77, 41, NOW);
      expect(notice.statusChanged).toHaveBeenLastCalledWith(
        'REJECTED',
        41,
        501,
      );
    });

    it('날인 · 거부가 실패하면 알리지 않는다', async () => {
      tx.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SIGNATURE',
        signDeadlineAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      await service()
        .reject(77, 41, NOW)
        .catch(() => undefined);
      expect(notice.statusChanged).not.toHaveBeenCalled();
    });

    it('거부도 날인 기한이 지났으면 409 SIGN_DEADLINE_PASSED — 바꾸지 않는다', async () => {
      tx.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SIGNATURE',
        signDeadlineAt: NOW,
      });
      const e = await thrown(service().reject(77, 41, NOW));
      expect(bodyOf(e)).toMatchObject({ code: 'SIGN_DEADLINE_PASSED' });
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });

    it('수정 요청 — 대조 결과와 상관없이 서명 대기면 받고 사유를 함께 남긴다', async () => {
      tx.contract.findFirst.mockResolvedValue(
        mine({
          contractParty: { ...mine().contractParty, enteredName: '홍길순' },
        }),
      );
      await expect(
        service().requestCorrection(77, 41, '이름이 틀렸습니다', NOW),
      ).resolves.toEqual({
        contractId: 41,
        status: 'CORRECTION_REQUESTED',
      });
      expect(tx.contract.updateMany).toHaveBeenCalledWith({
        where: { contractId: 41, status: 'PENDING_SIGNATURE' },
        data: {
          correctionReason: '이름이 틀렸습니다',
          status: 'CORRECTION_REQUESTED',
        },
      });
    });

    it.each<[string, (s: MyContractsService) => Promise<unknown>]>([
      ['거부', (s) => s.reject(77, 41, NOW)],
      ['수정 요청', (s) => s.requestCorrection(77, 41, '사유', NOW)],
    ])('%s — 남의 계약이면 404, 바꾸지 않는다', async (_label, run) => {
      tx.contract.findFirst.mockResolvedValue(null);
      const e = await thrown(run(service()));
      expect(e.getStatus()).toBe(404);
      expect(tx.contract.updateMany).not.toHaveBeenCalled();
    });
  });
});
