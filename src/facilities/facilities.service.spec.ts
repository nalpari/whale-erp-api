import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
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

/** 수정 화면이 상세에서 받은 updatedAt — 아래 행의 updatedAt 과 같다 */
const UPDATED_AT = '2026-11-11T01:02:03.004Z';

/** 범위 안 시설물 한 행(상세 조회 결과 모양) — 가맹 점포 */
const facilityRow = (over: Record<string, unknown> = {}) => ({
  facilityId: 11,
  storeId: 3,
  name: '그라인더',
  facilityStatusCode: 'OPERATING',
  facilityGroupCode: 'STORE_EQUIPMENT',
  facilityCategoryCode: 'ICE_MAKER',
  inspectionCycleCode: null,
  managerStaffMemberId: null,
  managerPhone: null,
  updatedAt: new Date(UPDATED_AT),
  store: {
    storeCode: 'ST000003',
    name: '성수점',
    storeTypeCode: 'FRANCHISE',
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
    codeItem: { count: jest.Mock; findMany: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
    staffMember: { count: jest.Mock; findUnique: jest.Mock };
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
      codeItem: {
        count: jest.fn().mockResolvedValue(1),
        // 문서 종류 — 플랫폼고정 공통코드 FACILITY_DOCUMENT 의 플랫폼 행. 다른 그룹(이름표)은 빈 목록
        findMany: jest.fn((args: { where: { groupCode?: unknown } }) =>
          Promise.resolve(
            args.where.groupCode === 'FACILITY_DOCUMENT' ? documentKinds : [],
          ),
        ),
      },
      // 메뉴 권한 다시 묻기(adminHasMenuAction) — 기본은 수정 권한 있음
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
      staffMember: {
        count: jest.fn().mockResolvedValue(1),
        // 담당자 표시 — 본사 제공 동의한 직원(가리지 않음)
        findUnique: jest.fn().mockResolvedValue({
          name: '정하윤',
          account: {
            isHqSharingConsented: true,
            hqSharingConsentVersion: 'v1.0',
          },
        }),
      },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    await build();
  });

  const upload = { buffer: PDF, size: PDF.length, originalname: 'm.pdf' };

  const kind = (
    itemCode: string,
    label: string,
    sortOrder: number,
    over: Record<string, unknown> = {},
  ) => ({
    itemCode,
    label,
    sortOrder,
    status: 'ACTIVE',
    isDeleted: false,
    codeGroup: { status: 'ACTIVE', isDeleted: false },
    ...over,
  });
  let documentKinds: ReturnType<typeof kind>[] = [];
  beforeEach(() => {
    documentKinds = [
      kind('USER_MANUAL', '사용 매뉴얼', 1),
      kind('PRECAUTION', '주의사항', 2),
      kind('WARRANTY', '제품 보증서', 3),
    ];
  });

  describe('문서 종류는 공통코드 FACILITY_DOCUMENT(플랫폼고정)에서 — WHALEERP-718', () => {
    it('공통코드에 더한 종류로 올린다', async () => {
      documentKinds.push(kind('INVOICE', '거래명세서', 4));
      tx.facilityDocument.create.mockResolvedValue({
        facilityDocumentId: 2,
        documentKind: 'INVOICE',
        fileName: 'm.pdf',
        fileType: 'PDF',
        sizeBytes: PDF.length,
        storageKey: 'facilities/11/k.pdf',
      });
      const doc = await service.putDocument(9, BP, 11, 'INVOICE', upload);
      expect(prisma.codeItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { groupCode: 'FACILITY_DOCUMENT', bpCode: 'BP000000' },
        }),
      );
      expect(doc).toMatchObject({
        documentKind: 'INVOICE',
        documentKindLabel: '거래명세서',
        isDocumentKindActive: true,
      });
    });

    it('파일이 없다는 문구는 공통코드 이름으로', async () => {
      documentKinds[0] = kind('USER_MANUAL', '사용 설명서', 1);
      await expect(
        service.putDocument(9, BP, 11, 'USER_MANUAL', undefined),
      ).rejects.toThrow('사용 설명서 파일을 골라 주세요.');
    });

    it.each([
      ['사용 중지한 종류', { status: 'INACTIVE' }],
      ['지운 종류', { isDeleted: true }],
      [
        '사용 중지한 그룹의 종류',
        { codeGroup: { status: 'INACTIVE', isDeleted: false } },
      ],
      [
        '지운 그룹의 종류',
        { codeGroup: { status: 'ACTIVE', isDeleted: true } },
      ],
    ])(
      '%s로는 새로 올리지 못한다 — 400, 저장소에 올리지도 않는다',
      async (_, over) => {
        documentKinds[2] = kind('WARRANTY', '제품 보증서', 3, over);
        await expect(
          service.putDocument(9, BP, 11, 'WARRANTY', upload),
        ).rejects.toThrow(
          '사용 중지된 문서 종류(제품 보증서)라 새로 올리거나 바꿀 수 없습니다. 이미 올린 문서는 뺄 수 있습니다.',
        );
        expect(storage.put).not.toHaveBeenCalled();
      },
    );

    it('이미 문서가 있는 종류를 사용 중지하면 바꾸기도 400 이고 기존 문서는 그대로다', async () => {
      documentKinds[2] = kind('WARRANTY', '제품 보증서', 3, {
        status: 'INACTIVE',
      });
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({ documents: [{ documentKind: 'WARRANTY' }] }),
      );
      await expect(
        service.putDocument(9, BP, 11, 'WARRANTY', upload),
      ).rejects.toThrow(BadRequestException);
      expect(storage.put).not.toHaveBeenCalled();
      expect(tx.facilityDocument.updateMany).not.toHaveBeenCalled();
    });

    it('공통코드에 없는 문서 종류가 있으면 경고 로그를 남기고 코드 그대로 보인다', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({
          documents: [
            {
              facilityDocumentId: 1,
              documentKind: 'LEGACY',
              fileName: 'w.pdf',
              fileType: 'PDF',
              sizeBytes: 9,
              storageKey: 'facilities/11/1.pdf',
            },
          ],
          createdBy: 5,
          updatedBy: null,
        }),
      );
      Object.assign(prisma, {
        codeGroup: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const d = await service.detail(9, BP, 11);
      expect(d.documents[0].documentKindLabel).toBe('LEGACY');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('FACILITY_DOCUMENT 에 없는 문서 종류 LEGACY'),
      );
      warn.mockRestore();
    });

    it('사용 중지한 종류의 문서도 뺄 수 있다', async () => {
      documentKinds[2] = kind('WARRANTY', '제품 보증서', 3, {
        status: 'INACTIVE',
      });
      await service.removeDocument(9, BP, 11, 'WARRANTY');
      expect(tx.facilityDocument.updateMany).toHaveBeenCalledWith({
        where: { facilityId: 11, documentKind: 'WARRANTY', isDeleted: false },
        data: { isDeleted: true },
      });
    });

    it.each(['INVOICE', 'toString', 'user_manual'])(
      '공통코드에 없는 종류 %p 는 올리기 404',
      async (raw) => {
        await expect(
          service.putDocument(9, BP, 11, raw, upload),
        ).rejects.toThrow('문서 종류를 찾을 수 없습니다');
      },
    );

    it('공통코드에서 행이 사라진 종류라도 그 시설물에 문서가 있으면 뺀다(상세에 보이는 문서)', async () => {
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({ documents: [{ documentKind: 'LEGACY' }] }),
      );
      await service.removeDocument(9, BP, 11, 'LEGACY');
      expect(tx.facilityDocument.updateMany).toHaveBeenCalledWith({
        where: { facilityId: 11, documentKind: 'LEGACY', isDeleted: false },
        data: { isDeleted: true },
      });
    });

    it('공통코드에 없는 종류는 빼기도 404', async () => {
      await expect(
        service.removeDocument(9, BP, 11, 'INVOICE'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('상세 문서는 공통코드 순서이고, 이름 · 사용 여부를 싣는다(공통코드에서 사라진 종류는 코드 그대로 끝에)', async () => {
      documentKinds = [
        kind('WARRANTY', '제품 보증서', 1),
        kind('USER_MANUAL', '사용 매뉴얼', 2, { status: 'INACTIVE' }),
      ];
      const doc = (facilityDocumentId: number, documentKind: string) => ({
        facilityDocumentId,
        documentKind,
        fileName: 'w.pdf',
        fileType: 'PDF',
        sizeBytes: 9,
        storageKey: `facilities/11/${facilityDocumentId}.pdf`,
      });
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({
          documents: [
            doc(1, 'USER_MANUAL'),
            doc(2, 'LEGACY'),
            doc(3, 'WARRANTY'),
          ],
          createdBy: 5,
          updatedBy: null,
        }),
      );
      Object.assign(prisma, {
        codeGroup: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const d = await service.detail(9, BP, 11);
      expect(
        d.documents.map((x) => [
          x.documentKind,
          x.documentKindLabel,
          x.isDocumentKindActive,
        ]),
      ).toEqual([
        ['WARRANTY', '제품 보증서', true],
        ['USER_MANUAL', '사용 매뉴얼', false],
        ['LEGACY', 'LEGACY', false],
      ]);
    });
  });

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
      updatedAt: UPDATED_AT,
      ...over,
    });

    it('지금 운영상태 · 분류와 같으면 미사용이어도 사용 여부를 묻지 않고 저장한다(PL-2 · PL-3)', async () => {
      prisma.codeItem.count.mockResolvedValue(0); // 둘 다 미사용이 됐다
      await service.update(9, BP, 11, form());
      expect(prisma.codeItem.count).not.toHaveBeenCalled();
      expect(tx.facility.updateMany).toHaveBeenCalled();
    });

    it('다른 운영상태로 바꾸면 사용 중인 플랫폼 코드여야 한다', async () => {
      prisma.codeItem.count.mockResolvedValue(0);
      await expect(
        service.update(9, BP, 11, form({ facilityStatusCode: 'STORED' })),
      ).rejects.toThrow('운영상태를 다시 선택해 주세요.');
      expect(prisma.codeItem.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          groupCode: 'FACILITY_STATUS',
          itemCode: 'STORED',
          bpCode: 'BP000000',
        }) as Record<string, unknown>,
      });
    });

    it('받은 updatedAt 이 이미 지금과 다르면 검증 전에 409 — 「다시 선택해 주세요」 400 이 먼저 나가지 않는다', async () => {
      prisma.codeItem.count.mockResolvedValue(0);
      await expect(
        service.update(
          9,
          BP,
          11,
          form({
            facilityCategoryCode: 'GRINDER',
            updatedAt: '2026-11-10T00:00:00.000Z',
          }),
        ),
      ).rejects.toThrow(ConflictException);
      expect(prisma.codeItem.count).not.toHaveBeenCalled();
    });

    it('다른 분류로 바꾸면 그 BP 의 사용 중인 코드여야 한다', async () => {
      prisma.codeItem.count.mockResolvedValueOnce(0); // 분류(운영상태는 지금 값)
      await expect(
        service.update(9, BP, 11, form({ facilityCategoryCode: 'GRINDER' })),
      ).rejects.toThrow('쓸 수 없는 분류입니다. 다시 선택해 주세요.');
      expect(prisma.codeItem.count).toHaveBeenNthCalledWith(1, {
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
      // 가입 완료 · 재직 · 그 점포, 그리고 본사 역할(BM) · 가맹 점포라 본사 제공 동의 조건까지
      expect(prisma.staffMember.count).toHaveBeenCalledWith({
        where: {
          AND: [
            expect.objectContaining({
              storeId: 3,
              employmentStatus: 'EMPLOYED',
              joinStatus: 'JOINED',
              account: expect.anything() as unknown,
            }) as Record<string, unknown>,
            { staffMemberId: 22 },
          ],
        },
      });
    });

    it('가려진 담당자(본사 · 미동의 가맹 직원)를 그대로 두면 화면이 비워 보낸 번호 대신 저장된 번호를 지킨다', async () => {
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({ managerStaffMemberId: 21, managerPhone: '01012345678' }),
      );
      prisma.staffMember.findUnique.mockResolvedValue({
        name: '미동의',
        account: { isHqSharingConsented: false, hqSharingConsentVersion: null },
      });
      await service.update(
        9,
        BP,
        11,
        form({ managerStaffMemberId: 21, managerPhone: null }),
      );
      expect(tx.facility.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            managerStaffMemberId: 21,
            managerPhone: '01012345678',
          }) as Record<string, unknown>,
        }),
      );
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

  describe('문서 올리기 권한 — 등록 권한만 있으면 직접 등록한 시설물에 처음 올리는 문서만', () => {
    const createOnly = () => prisma.roleGroupMenu.count.mockResolvedValue(0);

    it('수정 권한이 있으면 남의 시설물 문서도 바꾼다', async () => {
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({
          createdBy: 77,
          documents: [{ documentKind: 'WARRANTY' }],
        }),
      );
      await service.putDocument(9, BP, 11, 'WARRANTY', upload);
      expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          menu: expect.objectContaining({ url: '/facilities' }) as unknown,
          OR: [{ isUpdatable: true }],
        }) as Record<string, unknown>,
      });
      expect(tx.facilityDocument.create).toHaveBeenCalled();
    });

    it('등록 권한만 있어도 직접 등록한 시설물에 아직 없는 종류는 올린다(등록 화면 흐름)', async () => {
      createOnly();
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({ createdBy: 9, documents: [] }),
      );
      await service.putDocument(9, BP, 11, 'WARRANTY', upload);
      expect(tx.facilityDocument.create).toHaveBeenCalled();
    });

    it('등록 권한만으로는 이미 있는 문서를 바꾸지 못한다 — 403, 저장소에 올리지도 않는다', async () => {
      createOnly();
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({
          createdBy: 9,
          documents: [{ documentKind: 'WARRANTY' }],
        }),
      );
      await expect(
        service.putDocument(9, BP, 11, 'WARRANTY', upload),
      ).rejects.toThrow(ForbiddenException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('등록 권한만으로는 남이 등록한 시설물에 올리지 못한다 — 403', async () => {
      createOnly();
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({ createdBy: 77, documents: [] }),
      );
      await expect(
        service.putDocument(9, BP, 11, 'WARRANTY', upload),
      ).rejects.toThrow(ForbiddenException);
      expect(storage.put).not.toHaveBeenCalled();
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
      const d = await service.detail(9, BP, 11);
      expect(d.documents).toEqual([
        expect.objectContaining({ downloadUrl: null, thumbnailUrl: null }),
      ]);
    });

    const detailWithManager = async (consented: boolean, role = 'BM') => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        ...bmAdmin,
        roleTypeCode: role,
      });
      prisma.facility.findFirst.mockResolvedValue(
        facilityRow({
          managerStaffMemberId: 21,
          managerPhone: '01012345678',
          createdBy: 5,
          updatedBy: null,
        }),
      );
      prisma.staffMember.findUnique.mockResolvedValue({
        name: '가맹 직원',
        account: {
          isHqSharingConsented: consented,
          hqSharingConsentVersion: consented ? 'v1.0' : null,
        },
      });
      Object.assign(prisma, {
        codeGroup: { findMany: jest.fn().mockResolvedValue([]) },
      });
      return service.detail(9, BP, 11);
    };

    it('본사 역할에게 가맹 점포의 미동의 담당자는 이름 · 번호를 가린다(ATT-30)', async () => {
      const d = await detailWithManager(false);
      expect(d).toMatchObject({
        manager: { staffMemberId: 21, name: null },
        managerPhone: null,
        isManagerHidden: true,
      });
    });

    it('동의한 담당자 · 가맹 역할에게는 그대로 보인다', async () => {
      expect(await detailWithManager(true)).toMatchObject({
        manager: { staffMemberId: 21, name: '가맹 직원' },
        managerPhone: '01012345678',
        isManagerHidden: false,
      });
      expect(await detailWithManager(false, 'FM')).toMatchObject({
        manager: { name: '가맹 직원' },
        isManagerHidden: false,
      });
    });
  });

  describe('등록', () => {
    const body = {
      storeId: 3,
      name: '그라인더',
      facilityStatusCode: 'OPERATING',
      facilityGroupCode: 'STORE_EQUIPMENT' as const,
      facilityCategoryCode: 'GRINDER',
      quantity: 1,
      isVatIncluded: true,
    };

    it('검사 뒤 넣기 전에 점포가 폐점했으면 400 — 점포 행을 공유 잠금으로 다시 본다', async () => {
      prisma.store.findFirst.mockResolvedValue({
        storeId: 3,
        storeTypeCode: 'DIRECT',
        storeStatusCode: 'OPERATING',
      });
      tx.$queryRaw.mockResolvedValue([
        { store_status_code: 'CLOSED', is_deleted: false },
      ]);
      Object.assign(tx.facility, { create: jest.fn() });
      await expect(service.create(9, BP, body)).rejects.toThrow(
        '폐점 점포에는 등록할 수 없습니다.',
      );
      expect(
        (tx.facility as unknown as { create: jest.Mock }).create,
      ).not.toHaveBeenCalled();
    });
  });
});
