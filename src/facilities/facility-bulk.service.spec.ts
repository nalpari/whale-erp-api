import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { BULK_HAS_ERRORS, BULK_HEADERS } from './facility-bulk';
import { FacilityBulkService } from './facility-bulk.service';

const BP = { bpCodeId: 7, isPlatformCaller: false };
const LABELS: string[] = BULK_HEADERS.map((h) => h.label);

const bmAdmin = {
  bpCodeId: 7,
  isAllStores: true,
  roleTypeCode: 'BM',
  bpCode: { isPlatform: false, bpCode: 'BP000007' },
};

const STORES = [
  {
    storeId: 3,
    storeCode: 'ST000003',
    name: '성수점',
    storeStatusCode: 'OPERATING',
  },
  {
    storeId: 1,
    storeCode: 'ST000001',
    name: '강남점',
    storeStatusCode: 'OPERATING',
  },
  {
    storeId: 9,
    storeCode: 'ST000009',
    name: '닫은점',
    storeStatusCode: 'CLOSED',
  },
];

const CODES = [
  { groupCode: 'FACILITY_STATUS', itemCode: 'OPERATING', label: '운영' },
  { groupCode: 'FACILITY_STATUS', itemCode: 'STORED', label: '보관' },
  { groupCode: 'STORE_EQUIPMENT', itemCode: 'ICE_MAKER', label: '제빙기' },
  { groupCode: 'STORE_FACILITY', itemCode: 'HVAC', label: '냉난방' },
  { groupCode: 'INSPECTION_CYCLE', itemCode: 'MONTHLY', label: '매월' },
];

const GROUPS = [
  { groupCode: 'STORE_EQUIPMENT', groupName: '점포 장비' },
  { groupCode: 'STORE_FACILITY', groupName: '점포 시설물' },
];

async function xlsx(rows: Record<string, string>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('시설물·장비');
  ws.addRow(LABELS);
  for (const r of rows) ws.addRow(LABELS.map((l) => r[l] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const row = (over: Record<string, string> = {}) => ({
  '점포*': 'ST000001',
  '시설물/장비명*': '제빙기 1호',
  '운영상태*': '운영',
  '그룹*': '점포 장비',
  '분류*': '제빙기',
  ...over,
});

const upload = async (
  rows: Record<string, string>[],
  name = '내 파일.xlsx',
) => {
  const buffer = await xlsx(rows);
  return { buffer, size: buffer.length, originalname: name, mimetype: 'x' };
};

describe('FacilityBulkService', () => {
  let service: FacilityBulkService;
  let tx: { $queryRaw: jest.Mock; facility: { createMany: jest.Mock } };
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    bpCode: { findUniqueOrThrow: jest.Mock };
    store: { findMany: jest.Mock };
    codeItem: { findMany: jest.Mock };
    codeGroup: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    tx = {
      $queryRaw: jest.fn(),
      facility: { createMany: jest.fn() },
    };
    prisma = {
      adminAccount: { findFirst: jest.fn().mockResolvedValue(bmAdmin) },
      bpCode: { findUniqueOrThrow: jest.fn() },
      store: { findMany: jest.fn().mockResolvedValue(STORES) },
      codeItem: { findMany: jest.fn().mockResolvedValue(CODES) },
      codeGroup: { findMany: jest.fn().mockResolvedValue(GROUPS) },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FacilityBulkService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(FacilityBulkService);
  });

  it('점포는 관리 범위 안에서, 공통코드는 운영상태(플랫폼 원본)와 그 BP 의 분류 · 점검 주기를 한 번에 읽는다', async () => {
    await service.preview(168, BP, await upload([row()]));
    expect(prisma.store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isDeleted: false,
          bpCodeId: 7,
        }) as Record<string, unknown>,
      }) as Record<string, unknown>,
    );
    const [[{ where }]] = prisma.codeItem.findMany.mock.calls as [
      { where: unknown },
    ][];
    expect(where).toMatchObject({
      status: 'ACTIVE',
      isDeleted: false,
      codeGroup: { status: 'ACTIVE', isDeleted: false },
      OR: [
        { groupCode: 'FACILITY_STATUS', bpCode: 'BP000000' },
        {
          groupCode: {
            in: ['STORE_FACILITY', 'STORE_EQUIPMENT', 'INSPECTION_CYCLE'],
          },
          bpCode: 'BP000007',
        },
      ],
    });
  });

  it('미리보기 — 건수 · 열 · 줄(행 번호 · 결과 · 보일 글자 · 사유)', async () => {
    const result = await service.preview(
      168,
      BP,
      await upload([row(), row({ '점포*': 'ST000009', '분류*': '냉난방' })]),
    );
    expect(result).toMatchObject({
      fileName: '내 파일.xlsx',
      totalCount: 2,
      validCount: 1,
      errorCount: 1,
    });
    expect(result.columns.map((c) => c.key)).toEqual([
      'storeName',
      'group',
      'category',
      'name',
      'purchaseDate',
      'installationDate',
    ]);
    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        isValid: true,
        values: {
          storeName: '강남점',
          group: '점포 장비',
          category: '제빙기',
          name: '제빙기 1호',
          purchaseDate: '',
          installationDate: '',
        },
        errors: [],
      },
      {
        rowNumber: 3,
        isValid: false,
        values: expect.objectContaining({
          storeName: '닫은점',
          category: '냉난방',
        }) as Record<string, string>,
        errors: [
          '점포: 폐점 점포에는 등록할 수 없습니다.',
          '분류: 「점포 장비」에 없는 분류입니다.',
        ],
      },
    ]);
  });

  it('파일이 없으면 400', async () => {
    await expect(service.preview(168, BP, undefined)).rejects.toThrow(
      new BadRequestException('올릴 파일을 선택해 주세요.'),
    );
  });

  it('등록 — 오류가 한 줄이라도 있으면 하나도 저장하지 않고 400', async () => {
    await expect(
      service.register(
        168,
        BP,
        await upload([row(), row({ '분류*': '없는것' })]),
      ),
    ).rejects.toThrow(new BadRequestException(BULK_HAS_ERRORS));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('등록 — 점포를 id 순서로 공유 잠금해 다시 보고 한 번에 넣는다(등록자 · 총금액)', async () => {
    tx.$queryRaw.mockResolvedValue([
      { store_id: 1, store_status_code: 'OPERATING', is_deleted: false },
      { store_id: 3, store_status_code: 'OPERATING', is_deleted: false },
    ]);
    tx.facility.createMany.mockResolvedValue({ count: 3 });
    const result = await service.register(
      168,
      BP,
      await upload([
        row({ '점포*': 'ST000003', 단가: '1000', 수량: '2' }),
        row(),
        row({ '점포*': 'ST000003' }),
      ]),
    );
    expect(result).toEqual({ createdCount: 3 });
    const lockCalls = tx.$queryRaw.mock.calls as unknown as [
      TemplateStringsArray,
      { values: unknown[] },
    ][];
    const [sql, ids] = lockCalls[0];
    expect(Array.from(sql).join('?')).toMatch(/FOR SHARE/);
    // Prisma.join(storeIds) — 겹친 점포는 한 번, id 순서
    expect(ids.values).toEqual([1, 3]);
    const createCalls = tx.facility.createMany.mock.calls as unknown as [
      { data: Record<string, unknown>[] },
    ][];
    const { data } = createCalls[0][0];
    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({
      storeId: 3,
      createdBy: 168,
      unitPriceAmount: 1000,
      quantity: 2,
      totalAmount: 2000,
    });
    expect(data[1]).toMatchObject({ storeId: 1, createdBy: 168 });
  });

  it('등록 — 그 사이 점포가 폐점 · 삭제됐으면 400(미리보기를 다시 받게)', async () => {
    tx.$queryRaw.mockResolvedValue([
      { store_id: 1, store_status_code: 'CLOSED', is_deleted: false },
    ]);
    await expect(
      service.register(168, BP, await upload([row()])),
    ).rejects.toThrow(new BadRequestException(BULK_HAS_ERRORS));
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      service.register(168, BP, await upload([row()])),
    ).rejects.toThrow(new BadRequestException(BULK_HAS_ERRORS));
    expect(tx.facility.createMany).not.toHaveBeenCalled();
  });

  it('양식 — 범위 안 열린 점포만 둘째 시트에 넣는다', async () => {
    const buffer = await service.template(168, BP);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const stores = wb.worksheets[1];
    expect(stores.getColumn(2).values.slice(2)).toEqual([
      'ST000001',
      'ST000003',
    ]);
  });

  it('오류 파일 — 「올린파일이름_오류.xlsx」 에 오류 줄 사유를 적는다', async () => {
    const result = await service.errorFile(
      168,
      BP,
      await upload([row(), row({ '시설물/장비명*': '' })], '시설물.xlsx'),
    );
    expect(result.fileName).toBe('시설물_오류.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getCell(2, 25).value ?? null).toBeNull();
    expect(ws.getCell(3, 25).value).toBe('시설물/장비명: 입력해 주세요.');
  });
});
