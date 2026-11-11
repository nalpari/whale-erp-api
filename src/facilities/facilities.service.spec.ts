import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import type { UpdateFacilityDto } from './dto/save-facility.dto';
import { FacilitiesService } from './facilities.service';

const PDF = Buffer.from('%PDF-1.4\n%test\n');
const BP = { bpCodeId: 7, isPlatformCaller: false };

/** BP 마스터(전체 점포) — 소속 BP 7 */
const bmAdmin = {
  bpCodeId: 7,
  isAllStores: true,
  roleTypeCode: 'BM',
  bpCode: { isPlatform: false, bpCode: 'BP000007' },
};

/** 범위 안 시설물 한 행(상세 조회 결과 모양) */
const facilityRow = (over: Record<string, unknown> = {}) => ({
  facilityId: 11,
  storeId: 3,
  name: '그라인더',
  facilityStatusCode: 'OPERATING',
  facilityGroupCode: 'STORE_EQUIPMENT',
  facilityCategoryCode: 'ICE_MAKER',
  inspectionCycleCode: null,
  managerStaffMemberId: null,
  store: {
    storeCode: 'ST000003',
    name: '성수점',
    storeStatusCode: 'OPERATING',
  },
  documents: [],
  ...over,
});

describe('FacilitiesService', () => {
  let service: FacilitiesService;
  let storage: {
    put: jest.Mock;
    delete: jest.Mock;
    downloadUrl: jest.Mock;
    thumbnailUrl: jest.Mock;
  };
  let tx: {
    $queryRaw: jest.Mock;
    facilityDocument: { updateMany: jest.Mock; create: jest.Mock };
    facility: {
      updateMany: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };
  let prisma: {
    adminAccount: { findFirst: jest.Mock; findMany: jest.Mock };
    bpCode: { findUniqueOrThrow: jest.Mock };
    store: { findFirst: jest.Mock };
    facility: { findFirst: jest.Mock };
    facilityDocument: { count: jest.Mock };
    codeItem: { count: jest.Mock };
    staffMember: { count: jest.Mock };
    $transaction: jest.Mock;
  };

  const build = async (withStorage = true) => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        FacilitiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: STORAGE, useValue: withStorage ? storage : null },
      ],
    }).compile();
    service = moduleRef.get(FacilitiesService);
  };

  beforeEach(async () => {
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      downloadUrl: jest.fn().mockResolvedValue('https://signed/x'),
      thumbnailUrl: jest.fn().mockResolvedValue('https://thumb/x'),
    };
    tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { is_deleted: false, store_status_code: 'OPERATING' },
        ]),
      facilityDocument: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({
          facilityDocumentId: 1,
          documentKind: 'USER_MANUAL',
          fileName: 'm.pdf',
          fileType: 'PDF',
          sizeBytes: PDF.length,
          storageKey: 'facilities/11/k.pdf',
        }),
      },
      facility: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ facilityId: 11, updatedAt: new Date() }),
      },
    };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue(bmAdmin),
        findMany: jest.fn().mockResolvedValue([]),
      },
      bpCode: { findUniqueOrThrow: jest.fn() },
      store: { findFirst: jest.fn() },
      facility: { findFirst: jest.fn().mockResolvedValue(facilityRow()) },
      facilityDocument: { count: jest.fn().mockResolvedValue(0) },
      codeItem: { count: jest.fn().mockResolvedValue(1) },
      staffMember: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    await build();
  });

  const upload = { buffer: PDF, size: PDF.length, originalname: 'm.pdf' };

  describe('호출자', () => {
    it('플랫폼 계정이 BP 를 고르지 않으면(대상 = 소속 플랫폼 BP) 400', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 1,
        isAllStores: true,
        roleTypeCode: 'PM',
        bpCode: { isPlatform: true, bpCode: 'BP000000' },
      });
      await expect(
        service.detail(9, { bpCodeId: 1, isPlatformCaller: true }, 11),
      ).rejects.toThrow(BadRequestException);
    });

    it('목록에서 그룹 없이 분류만 보내면 400 — DB 에 묻지 않는다', async () => {
      await expect(
        service.list(9, BP, {
          facilityCategoryCode: 'HVAC',
          page: 1,
          pageSize: 50,
        }),
      ).rejects.toThrow('분류는 그룹을 고른 뒤에 고를 수 있습니다.');
      expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('수정', () => {
    const form = (
      over: Partial<UpdateFacilityDto> = {},
    ): UpdateFacilityDto => ({
      name: '그라인더',
      facilityStatusCode: 'OPERATING',
      facilityGroupCode: 'STORE_EQUIPMENT' as const,
      facilityCategoryCode: 'ICE_MAKER',
      quantity: 1,
      isVatIncluded: true,
      updatedAt: '2026-11-11T01:02:03.004Z',
      ...over,
    });

    it('지금 분류와 같으면 미사용이어도 사용 여부를 묻지 않고 저장한다(PL-3)', async () => {
      await service.update(9, BP, 11, form());
      // 운영상태 하나만 물었다 — 분류는 지금 값이라 건너뛴다.
      expect(prisma.codeItem.count).toHaveBeenCalledTimes(1);
      expect(prisma.codeItem.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          groupCode: 'FACILITY_STATUS',
        }) as Record<string, unknown>,
      });
    });

    it('다른 분류로 바꾸면 그 BP 의 사용 중인 코드여야 한다', async () => {
      prisma.codeItem.count
        .mockResolvedValueOnce(1) // 운영상태
        .mockResolvedValueOnce(0); // 분류
      await expect(
        service.update(9, BP, 11, form({ facilityCategoryCode: 'GRINDER' })),
      ).rejects.toThrow('쓸 수 없는 분류입니다. 다시 선택해 주세요.');
      expect(prisma.codeItem.count).toHaveBeenNthCalledWith(2, {
        where: expect.objectContaining({
          groupCode: 'STORE_EQUIPMENT',
          itemCode: 'GRINDER',
          bpCode: 'BP000007',
          status: 'ACTIVE',
        }) as Record<string, unknown>,
      });
    });

    it('그 사이 누가 고쳤으면(updatedAt 불일치) 409', async () => {
      tx.facility.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(9, BP, 11, form())).rejects.toThrow(
        '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요.',
      );
    });

    it('그 사이 누가 지웠으면 「먼저 수정했습니다」가 아니라 404 — 다시 불러와도 없다', async () => {
      tx.$queryRaw.mockResolvedValue([
        { is_deleted: true, store_status_code: 'OPERATING' },
      ]);
      await expect(service.update(9, BP, 11, form())).rejects.toThrow(
        NotFoundException,
      );
      expect(tx.facility.updateMany).not.toHaveBeenCalled();
    });

    it('검사 뒤 저장 전에 점포가 폐점했으면 409(조회만)', async () => {
      tx.$queryRaw.mockResolvedValue([
        { is_deleted: false, store_status_code: 'CLOSED' },
      ]);
      await expect(service.update(9, BP, 11, form())).rejects.toThrow(
        '폐점 점포의 시설물·장비는 조회만 할 수 있습니다.',
      );
      expect(tx.facility.updateMany).not.toHaveBeenCalled();
    });

    it('수정에서 지금 담당자는 그 사이 퇴직했어도 재직 여부를 묻지 않고 둔다(PL-6)', async () => {
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({ managerStaffMemberId: 21 }),
      );
      prisma.staffMember.count.mockResolvedValue(0); // 퇴직
      await service.update(9, BP, 11, form({ managerStaffMemberId: 21 }));
      expect(prisma.staffMember.count).not.toHaveBeenCalled();
    });

    it('다른 담당자로 바꾸면 그 점포의 재직 직원이어야 한다', async () => {
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({ managerStaffMemberId: 21 }),
      );
      prisma.staffMember.count.mockResolvedValue(0);
      await expect(
        service.update(9, BP, 11, form({ managerStaffMemberId: 22 })),
      ).rejects.toThrow(
        '관리 담당자는 그 점포의 재직 직원만 고를 수 있습니다.',
      );
      expect(prisma.staffMember.count).toHaveBeenCalledWith({
        where: { staffMemberId: 22, storeId: 3, employmentStatus: 'EMPLOYED' },
      });
    });

    it('폐점 점포의 것은 409 — 검증 전에 막는다', async () => {
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({
          store: { storeCode: 'S', name: 'n', storeStatusCode: 'CLOSED' },
        }),
      );
      await expect(service.update(9, BP, 11, form())).rejects.toThrow(
        '폐점 점포의 시설물·장비는 조회만 할 수 있습니다.',
      );
      expect(prisma.codeItem.count).not.toHaveBeenCalled();
    });
  });

  describe('삭제', () => {
    it('검사 뒤 점포가 폐점했으면 409 — 지우지 않는다', async () => {
      tx.$queryRaw.mockResolvedValue([
        { is_deleted: false, store_status_code: 'CLOSED' },
      ]);
      await expect(service.remove(9, BP, 11)).rejects.toThrow(
        ConflictException,
      );
      expect(tx.facility.update).not.toHaveBeenCalled();
    });

    it('그 사이 다른 요청이 지웠으면 404', async () => {
      tx.$queryRaw.mockResolvedValue([
        { is_deleted: true, store_status_code: 'OPERATING' },
      ]);
      await expect(service.remove(9, BP, 11)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('문서 올리기', () => {
    it('모르는 문서 종류는 404 — 파일 검사보다 먼저', async () => {
      await expect(
        service.putDocument(9, BP, 11, 'INVOICE', undefined),
      ).rejects.toThrow(NotFoundException);
    });

    it('저장소가 없으면 범위 · 상태를 본 뒤 503', async () => {
      await build(false);
      await expect(
        service.putDocument(9, BP, 11, 'USER_MANUAL', upload),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(prisma.facility.findFirst).toHaveBeenCalled();
    });

    it('저장소 올리기가 실패하면 503, 행은 만들지 않는다', async () => {
      storage.put.mockRejectedValue(new Error('s3 down'));
      await expect(
        service.putDocument(9, BP, 11, 'USER_MANUAL', upload),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('썸네일을 못 만든 그림(HttpException)은 그대로 400', async () => {
      storage.put.mockRejectedValue(new BadRequestException('깨진 그림'));
      await expect(
        service.putDocument(9, BP, 11, 'USER_MANUAL', upload),
      ).rejects.toThrow('깨진 그림');
    });

    it('DB 저장이 실패하면 아무 행도 가리키지 않는 올린 파일을 지운다', async () => {
      tx.facilityDocument.create.mockRejectedValue(new Error('db down'));
      await expect(
        service.putDocument(9, BP, 11, 'USER_MANUAL', upload),
      ).rejects.toThrow('db down');
      const [[key]] = storage.put.mock.calls as [string][];
      expect(key).toMatch(/^facilities\/11\/.+\.pdf$/);
      expect(storage.delete).toHaveBeenCalledWith(key);
    });

    it('DB 오류여도 행이 파일을 가리키면(COMMIT 뒤 끊김) 지우지 않는다', async () => {
      tx.facilityDocument.create.mockRejectedValue(new Error('conn reset'));
      prisma.facilityDocument.count.mockResolvedValue(1);
      await expect(
        service.putDocument(9, BP, 11, 'USER_MANUAL', upload),
      ).rejects.toThrow('conn reset');
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('잠근 뒤 보니 그 사이 지워졌으면 404 이고 올린 파일을 지운다', async () => {
      tx.$queryRaw.mockResolvedValue([{ is_deleted: true }]);
      await expect(
        service.putDocument(9, BP, 11, 'USER_MANUAL', upload),
      ).rejects.toThrow(NotFoundException);
      expect(tx.facilityDocument.create).not.toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalled();
    });

    it('올리는 동안 점포가 폐점했으면 409 이고 올린 파일을 지운다', async () => {
      tx.$queryRaw.mockResolvedValue([
        { is_deleted: false, store_status_code: 'CLOSED' },
      ]);
      await expect(
        service.putDocument(9, BP, 11, 'USER_MANUAL', upload),
      ).rejects.toThrow(ConflictException);
      expect(tx.facilityDocument.create).not.toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalled();
    });

    it('문서 빼기도 같은 행 잠금으로 줄을 선다 — 잠근 뒤 폐점이면 409', async () => {
      tx.$queryRaw.mockResolvedValue([
        { is_deleted: false, store_status_code: 'CLOSED' },
      ]);
      await expect(
        service.removeDocument(9, BP, 11, 'WARRANTY'),
      ).rejects.toThrow(ConflictException);
      expect(tx.facilityDocument.updateMany).not.toHaveBeenCalled();
    });

    it('같은 종류의 옛 문서를 지움 표시한 뒤 새 행을 넣는다 — PDF 는 썸네일 주소가 없다', async () => {
      const doc = await service.putDocument(9, BP, 11, 'USER_MANUAL', upload);
      expect(tx.facilityDocument.updateMany).toHaveBeenCalledWith({
        where: {
          facilityId: 11,
          documentKind: 'USER_MANUAL',
          isDeleted: false,
        },
        data: { isDeleted: true },
      });
      expect(doc).toMatchObject({
        documentKind: 'USER_MANUAL',
        downloadUrl: 'https://signed/x',
        thumbnailUrl: null,
      });
    });
  });

  describe('상세', () => {
    it('문서 서명이 실패해도 상세는 보이고 주소만 null', async () => {
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({
          documents: [
            {
              facilityDocumentId: 1,
              documentKind: 'WARRANTY',
              fileName: 'w.png',
              fileType: 'PNG',
              sizeBytes: 9,
              storageKey: 'facilities/11/k.png',
            },
          ],
          createdBy: 5,
          updatedBy: null,
        }),
      );
      storage.downloadUrl.mockRejectedValue(new Error('no creds'));
      storage.thumbnailUrl.mockRejectedValue(new Error('no creds'));
      Object.assign(prisma, {
        codeGroup: { findMany: jest.fn().mockResolvedValue([]) },
      });
      Object.assign(prisma.codeItem, {
        findMany: jest.fn().mockResolvedValue([]),
      });
      const d = await service.detail(9, BP, 11);
      expect(d.documents).toEqual([
        expect.objectContaining({ downloadUrl: null, thumbnailUrl: null }),
      ]);
    });
  });
});
