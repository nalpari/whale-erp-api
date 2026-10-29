import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { unzipSync } from 'fflate';
import type { AdminScopeService } from '../admin-scope/admin-scope.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { BulkExportsService } from './bulk-exports.service';

// 읽으면 안 되는 표 — 주민등록번호 · 신고 정보 · 확인자료 · 동의 기록(계획 「빼는 것」)
const FORBIDDEN = [
  'staffTaxProfile',
  'staffTaxProfileHistory',
  'locationAccessLog',
  'locationConsent',
  'locationConsentHistory',
  'termsAgreementLog',
];

/** 표마다 findMany 등이 정해 둔 값을 주는 가짜 Prisma. 손댄 표 이름을 모은다. */
function fakePrisma(tables: Record<string, Record<string, unknown>>) {
  const touched = new Set<string>();
  const prisma = new Proxy(
    {},
    {
      get(_, name: string) {
        touched.add(name);
        return tables[name] ?? {};
      },
    },
  ) as unknown as PrismaService;
  return { prisma, touched };
}

const admin = (roleTypeCode: string) => ({
  findFirst: jest.fn().mockResolvedValue({ bpCodeId: 7, roleTypeCode }),
  findMany: jest
    .fn()
    .mockResolvedValue([{ adminAccountId: 3, name: '점장', loginId: 'x' }]),
});
const scope = (storeIds: number[]) =>
  ({
    getManageableStores: jest.fn().mockResolvedValue({
      roleTypeCode: 'BM',
      stores: storeIds.map((storeId) => ({ storeId, storeTypeCode: 'DIRECT' })),
    }),
  }) as unknown as AdminScopeService;

describe('BulkExportsService — 권한 유형', () => {
  it.each(['BA', 'FA', 'PM'])(
    '%s 는 미리 보기 · 요청 · 목록 · 내려받기 모두 403',
    async (role) => {
      const { prisma } = fakePrisma({ adminAccount: admin(role) });
      const service = new BulkExportsService(prisma, scope([1]), null);
      for (const call of [
        () => service.preview(1),
        () => service.request(1),
        () => service.list(1),
        () => service.download(1, 1),
      ])
        await expect(call()).rejects.toThrow(ForbiddenException);
    },
  );
});

describe('BulkExportsService.download — 볼 수 있는가', () => {
  it('같은 BP 라도 권한 유형이 다른 요청은 없는 것과 같다(404)', async () => {
    const { prisma } = fakePrisma({
      adminAccount: admin('BM'),
      store: {
        findMany: jest.fn().mockResolvedValue([
          {
            storeId: 1,
            storeTypeCode: 'DIRECT',
            storeStatusCode: 'OPERATING',
          },
        ]),
      },
      bulkExport: {
        findUnique: jest.fn().mockResolvedValue({
          bulkExportId: 5,
          bpCodeId: 7,
          roleTypeCode: 'FM',
          storeIds: [1],
          status: 'SUCCEEDED',
        }),
      },
    });
    await expect(
      new BulkExportsService(prisma, scope([1]), null).download(1, 5),
    ).rejects.toThrow(NotFoundException);
  });
});

function archiveFixture() {
  const staffFind = jest
    .fn()
    .mockResolvedValue([
      { staffMemberId: 10, storeId: 1, name: '유하람', phone: '01012345678' },
    ]);
  const { prisma, touched } = fakePrisma({
    staffMember: { findMany: staffFind },
    store: {
      findMany: jest.fn().mockResolvedValue([{ storeId: 1, name: '판교점' }]),
    },
    contract: {
      findMany: jest.fn().mockResolvedValue([
        {
          contractId: 100,
          staffMemberId: 10,
          status: 'SIGNED',
          contractMethod: 'PAPER',
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          startDate: null,
          endDate: null,
          wageAmount: null,
          sentAt: null,
          contractDocuments: [
            {
              kind: 'PAPER_EMPLOYMENT_CONTRACT',
              storageKey: 'contracts/100/a.pdf',
            },
          ],
        },
      ]),
    },
    attendanceRecord: { findMany: jest.fn().mockResolvedValue([]) },
    workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
    payslip: {
      findMany: jest.fn().mockResolvedValue([
        {
          payslipId: 900,
          staffMemberId: 10,
          storeId: 1,
          periodStartDate: new Date('2026-09-01T00:00:00.000Z'),
          periodEndDate: new Date('2026-09-30T00:00:00.000Z'),
          employmentType: 'PART_TIME',
          status: 'SENT',
          grossPayAmount: 1_000_000,
          totalDeductionAmount: 33_000,
          netPayAmount: 967_000,
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          isWithholdingApplied: true,
          staffMember: { name: '유하람' },
          payslipLogs: [
            {
              payslipLogId: 1,
              logType: 'SEND',
              changedAt: new Date('2026-10-10T01:00:00.000Z'),
            },
          ],
          payslipItems: [
            {
              payslipItemId: 1,
              itemCategory: 'EARNING',
              itemName: '기본급',
              isTaxFree: false,
              calculatedAmount: 1_000_000,
              adjustedAmount: null,
              isEntered: true,
              payslipItemMaster: { itemCode: 'BASE_PAY' },
            },
          ],
        },
      ]),
    },
    adminAccount: { findMany: jest.fn().mockResolvedValue([]) },
  });
  const storage = { get: jest.fn().mockResolvedValue(Buffer.from('%PDF')) };
  const service = new BulkExportsService(
    prisma,
    scope([1]),
    storage as unknown as StorageService,
  );
  return { service, storage, touched, staffFind };
}
const FM_STORE = [
  { storeId: 1, storeTypeCode: 'FRANCHISE', storeStatusCode: 'OPERATING' },
];
const AT = new Date('2026-10-29T01:00:00.000Z');

describe('BulkExportsService.buildArchive — 읽는 표', () => {
  it('직원 · 계약 · 출퇴근 · 근무스케줄 · 급여명세서만 읽고 신고 정보 · 확인자료 · 동의 기록은 읽지 않는다', async () => {
    const { service, storage, touched, staffFind } = archiveFixture();
    const { buffer, staffMemberIds } = await service.buildArchive(
      'FM',
      [
        {
          storeId: 1,
          storeTypeCode: 'FRANCHISE',
          storeStatusCode: 'OPERATING',
        },
      ],
      new Date('2026-10-29T01:00:00.000Z'),
    );

    expect(staffMemberIds).toHaveLength(1);
    expect(Object.keys(unzipSync(buffer))).toContain(
      '판교점/유하람_10/근로계약서/100_종이 계약 근로계약서.pdf',
    );
    // 발송 완료 명세서는 직원 앱 내보내기와 같은 PDF 로 그려 넣는다
    const payslipPdf =
      unzipSync(buffer)[
        '판교점/유하람_10/급여명세서/급여명세서_2026-09_유하람.pdf'
      ];
    expect(Buffer.from(payslipPdf.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(storage.get).toHaveBeenCalledWith('contracts/100/a.pdf');
    expect(FORBIDDEN.filter((t) => touched.has(t))).toEqual([]);
    // 직원은 이름 · 휴대전화번호까지만 읽는다 — 계정(주민등록번호 · 생년월일)을 select 하지 않는다
    const [[{ select }]] = staffFind.mock.calls as [[{ select: object }]];
    expect(Object.keys(select).sort()).toEqual([
      'name',
      'phone',
      'staffMemberId',
      'storeId',
    ]);
  });
});

describe('BulkExportsService.buildArchive — 크기 한도', () => {
  it('읽어 온 계약서 · 그린 명세서 합이 한도를 넘으면 4xx 로 멈춘다 — 다시 해도 같으므로 바로 실패', async () => {
    const { service } = archiveFixture();
    // 계약서 4바이트(%PDF)는 넘지 않고, 명세서 PDF 를 더하면 넘는 한도
    const error = await service
      .buildArchive('FM', FM_STORE, AT, 10)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBeLessThan(500);
    expect((error as HttpException).message).toBe(
      '파일이 너무 큽니다. 점포를 나눠 다시 요청해 주세요.',
    );
  });

  it('한도 안이면 만든다', async () => {
    const { service } = archiveFixture();
    await expect(
      service.buildArchive('FM', FM_STORE, AT, 10_000_000),
    ).resolves.toMatchObject({ staffMemberIds: [expect.any(Number)] });
  });
});
