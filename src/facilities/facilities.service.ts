import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AttachmentFileType,
  type FacilityDocumentKind,
  Prisma,
} from '@prisma/client';
import {
  hiddenStoreStaffWhere,
  hidesPersonalData,
  isPlatformRole,
  type MaskingStore,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { PLATFORM_BP_CODE } from '../codes/codes.service';
import { containsText } from '../common/contains-text';
import { dateOnly } from '../common/date-only';
import { isSameMillisecond, sameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import { parseDateOnly } from '../staff-members/kst-date';
import {
  type OptionalStorage,
  requireStorage,
  STORAGE,
} from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { assertUpload } from '../storage/upload-check';
import type {
  FacilityManagerOptionsQueryDto,
  FacilityStoreOptionsQueryDto,
  ListFacilitiesQueryDto,
} from './dto/list-facilities-query.dto';
import type {
  CreateFacilityDto,
  SaveFacilityDto,
  UpdateFacilityDto,
} from './dto/save-facility.dto';
import type {
  CreateFacilityResponseDto,
  FacilityDetailResponseDto,
  FacilityDocumentDto,
  FacilityListResponseDto,
  FacilityManagerOptionListResponseDto,
  FacilityStoreOptionListResponseDto,
  UpdateFacilityResponseDto,
} from './dto/facility.response.dto';
import {
  FACILITY_DOCUMENT_KINDS,
  FACILITY_DOCUMENT_MAX_BYTES,
  FACILITY_GROUPS,
  type FacilityGroup,
  FACILITY_STATUS_GROUP,
  INSPECTION_CYCLE_GROUP,
  documentKindLabel,
  documentKindOf,
  pickLabel,
  totalAmountOf,
} from './facility-format';

type Db = Prisma.TransactionClient | PrismaService;

const NOT_FOUND = '시설물·장비를 찾을 수 없습니다';
const STORE_NOT_FOUND = '점포를 찾을 수 없습니다';
const STORE_UNAVAILABLE = '고를 수 없는 점포입니다.';
const CLOSED_STORE_CREATE = '폐점 점포에는 등록할 수 없습니다.';
const READ_ONLY = '폐점 점포의 시설물·장비는 조회만 할 수 있습니다.';
const CHANGED_MEANWHILE =
  '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요.';
const DOCUMENT_TYPES = Object.values(AttachmentFileType);

/** multipart 로 받은 문서 파일 한 개 */
export type FacilityDocumentUpload = {
  buffer: Buffer;
  size: number;
  originalname: string;
};

/**
 * 시설물·장비를 다루는 관리자 — 가드가 메뉴 권한을 본 뒤 계정 한 행에서 읽어 둔다. 범위는 점포 정보 관리와 같다:
 * 플랫폼 계정은 상단에서 고른 BP 의 모든 점포, 그 밖의 계정은 소속 BP 의 점포(전체 점포가 아니면 매핑된 점포만).
 */
type FacilityCaller = {
  adminAccountId: number;
  /** 권한 유형(공통코드 ROLE_TYPE) — 본사 역할(BM · BA)의 가맹 직원 개인정보 가림(ATT-30)에 쓴다 */
  roleTypeCode: string;
  isPlatform: boolean;
  isAllStores: boolean;
  /** 다루는 BP — 플랫폼 계정은 X-Bp-Code-Id 의 고객 BP, 그 밖의 계정은 소속 BP */
  targetBpCodeId: number;
  /** 그 BP 의 코드(BP+6자리) — 분류 · 점검 주기는 이 BP 의 공통코드 행이다 */
  targetBpCode: string;
};

const DOCUMENT_SELECT = {
  facilityDocumentId: true,
  documentKind: true,
  fileName: true,
  fileType: true,
  sizeBytes: true,
  storageKey: true,
} as const;
type DocumentRow = Prisma.FacilityDocumentGetPayload<{
  select: typeof DOCUMENT_SELECT;
}>;

const STORE_SELECT = {
  storeCode: true,
  name: true,
  storeTypeCode: true,
  storeStatusCode: true,
} as const;

const DETAIL_INCLUDE = {
  store: { select: STORE_SELECT },
  documents: { where: { isDeleted: false }, select: DOCUMENT_SELECT },
} as const;
type DetailRow = Prisma.FacilityGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/** 수정 전 값 — 미사용 운영상태 · 분류 · 점검 주기 · 퇴직한 담당자를 그대로 둘 수 있는지 가른다. */
type Current = Pick<
  DetailRow,
  | 'facilityStatusCode'
  | 'facilityGroupCode'
  | 'facilityCategoryCode'
  | 'inspectionCycleCode'
  | 'managerStaffMemberId'
>;

/**
 * 관리자 웹 「시설물 및 장비 관리」(MN000022, `/facilities`). 「시설물·장비 관리 정책서」(2026-11-10) PL-1 ~ PL-6.
 *
 * - 시설물·장비는 점포 하나에 속하고, 점포는 등록 뒤 바꿀 수 없다. 폐점 점포에는 등록하지 못하고, 이미 있는 것은 조회만
 *   된다(수정 · 삭제 · 문서 409).
 * - 운영상태는 플랫폼고정 FACILITY_STATUS, 분류는 고른 그룹(STORE_FACILITY · STORE_EQUIPMENT)의, 점검 주기는
 *   INSPECTION_CYCLE 의 점포 BP 행이다. 새로 고르는 값은 사용 중이어야 하고, 수정에서 지금 값(운영상태 포함)은 미사용이어도 둘 수 있다.
 * - 관리 담당자는 그 점포의 가입 완료 · 재직 직원이고, 본사 역할이 가맹 점포에서 보면 본사 제공 동의한 직원만이다(ATT-30).
 *   수정에서 지금 담당자는 그 뒤 퇴직했어도 그대로 둘 수 있고, 가려진 담당자는 이름 · 번호를 응답에서 가린다.
 * - 삭제는 논리 삭제이고 문서도 함께 지움 표시한다. 수리 이력 · 점검 결과가 있으면 막아야 하는데(PL-4) 두 표가 아직 없다
 *   — 수리 이력을 만들 때 여기에 검사를 더한다.
 */
@Injectable()
export class FacilitiesService implements OnModuleInit {
  private readonly logger = new Logger(FacilitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** 첨부파일 저장소. 설정이 없으면 null — 문서 올리기만 503 이고 상세의 주소는 null 이다. */
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  onModuleInit(): void {
    if (!this.storage)
      this.logger.warn(
        '첨부파일 저장소 설정이 없습니다 — 시설물·장비 문서 올리기는 503 이고, 상세의 문서 주소는 null 입니다',
      );
  }

  async list(
    callerId: number,
    bp: TargetBpContext,
    query: ListFacilitiesQueryDto,
  ): Promise<FacilityListResponseDto> {
    if (query.facilityCategoryCode && !query.facilityGroupCode)
      throw new BadRequestException(
        '분류는 그룹을 고른 뒤에 고를 수 있습니다.',
      );
    const caller = await this.loadCaller(callerId, bp);
    const { page, pageSize } = query;
    const where: Prisma.FacilityWhereInput = {
      AND: [
        facilityScope(caller),
        query.storeIds ? { storeId: { in: query.storeIds } } : {},
        query.facilityStatusCode
          ? { facilityStatusCode: query.facilityStatusCode }
          : {},
        query.facilityGroupCode
          ? { facilityGroupCode: query.facilityGroupCode }
          : {},
        query.facilityCategoryCode
          ? { facilityCategoryCode: query.facilityCategoryCode }
          : {},
        query.keyword ? { name: containsText(query.keyword) } : {},
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.facility.findMany({
        where,
        select: {
          facilityId: true,
          storeId: true,
          name: true,
          facilityStatusCode: true,
          facilityGroupCode: true,
          facilityCategoryCode: true,
          createdAt: true,
          store: { select: STORE_SELECT },
        },
        orderBy: [{ createdAt: 'desc' }, { facilityId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.facility.count({ where }),
    ]);
    const labels = await this.labels(caller.targetBpCode);
    return {
      items: rows.map((r) => ({
        facilityId: r.facilityId,
        storeId: r.storeId,
        storeCode: r.store.storeCode,
        storeName: r.store.name,
        isStoreClosed: r.store.storeStatusCode === 'CLOSED',
        facilityStatusCode: r.facilityStatusCode,
        facilityStatusLabel: labels.status(r.facilityStatusCode),
        // DB CHECK(facilities_facility_group_code_allowed)가 두 값만 받는다.
        facilityGroupCode: r.facilityGroupCode as FacilityGroup,
        facilityGroupLabel: labels.group(r.facilityGroupCode),
        facilityCategoryCode: r.facilityCategoryCode,
        facilityCategoryLabel: labels.item(
          r.facilityGroupCode,
          r.facilityCategoryCode,
        ),
        name: r.name,
        createdAt: r.createdAt,
      })),
      total,
    };
  }

  async detail(
    callerId: number,
    bp: TargetBpContext,
    facilityId: number,
  ): Promise<FacilityDetailResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    const row = await this.findFacility(this.prisma, caller, facilityId);
    const [labels, active, manager, names, documents] = await Promise.all([
      this.labels(caller.targetBpCode),
      this.activeCodes(caller.targetBpCode),
      this.managerOf(caller, row.store, row.managerStaffMemberId),
      this.adminNames([row.createdBy, row.updatedBy]),
      this.documentsOf(row.documents),
    ]);
    return {
      facilityId: row.facilityId,
      store: {
        storeId: row.storeId,
        storeCode: row.store.storeCode,
        name: row.store.name,
        isClosed: row.store.storeStatusCode === 'CLOSED',
      },
      name: row.name,
      facilityStatusCode: row.facilityStatusCode,
      facilityStatusLabel: labels.status(row.facilityStatusCode),
      isFacilityStatusActive: active.has(
        codeKey(FACILITY_STATUS_GROUP, row.facilityStatusCode),
      ),
      facilityGroupCode: row.facilityGroupCode as FacilityGroup,
      facilityGroupLabel: labels.group(row.facilityGroupCode),
      facilityCategoryCode: row.facilityCategoryCode,
      facilityCategoryLabel: labels.item(
        row.facilityGroupCode,
        row.facilityCategoryCode,
      ),
      isFacilityCategoryActive: active.has(
        codeKey(row.facilityGroupCode, row.facilityCategoryCode),
      ),
      memo: row.memo,
      brand: row.brand,
      manufacturer: row.manufacturer,
      serialNumber: row.serialNumber,
      installationLocation: row.installationLocation,
      vendorName: row.vendorName,
      vendorPhone: row.vendorPhone,
      salesRepresentativeName: row.salesRepresentativeName,
      salesRepresentativePhone: row.salesRepresentativePhone,
      unitPriceAmount: row.unitPriceAmount?.toNumber() ?? null,
      quantity: row.quantity,
      totalAmount: row.totalAmount?.toNumber() ?? null,
      isVatIncluded: row.isVatIncluded,
      purchaseDate: dateOnly(row.purchaseDate),
      installationDate: dateOnly(row.installationDate),
      usageExpiryDate: dateOnly(row.usageExpiryDate),
      warrantyExpiryDate: dateOnly(row.warrantyExpiryDate),
      manager: manager && {
        staffMemberId: manager.staffMemberId,
        name: manager.name,
      },
      // 가려진 담당자의 번호는 그 직원 휴대폰으로 채운 값이라 함께 가린다(ATT-30).
      managerPhone: manager?.isHidden ? null : row.managerPhone,
      isManagerHidden: manager?.isHidden ?? false,
      inspectionCycleCode: row.inspectionCycleCode,
      inspectionCycleLabel:
        row.inspectionCycleCode === null
          ? null
          : labels.item(INSPECTION_CYCLE_GROUP, row.inspectionCycleCode),
      isInspectionCycleActive:
        row.inspectionCycleCode === null
          ? null
          : active.has(
              codeKey(INSPECTION_CYCLE_GROUP, row.inspectionCycleCode),
            ),
      inspectionNote: row.inspectionNote,
      serviceCenterZipCode: row.serviceCenterZipCode,
      serviceCenterAddress: row.serviceCenterAddress,
      serviceCenterAddressDetail: row.serviceCenterAddressDetail,
      serviceCenterPhone: row.serviceCenterPhone,
      documents,
      createdAt: row.createdAt,
      createdByName: names.get(row.createdBy) ?? null,
      updatedAt: row.updatedAt,
      updatedByName:
        row.updatedBy === null ? null : (names.get(row.updatedBy) ?? null),
    };
  }

  async create(
    callerId: number,
    bp: TargetBpContext,
    dto: CreateFacilityDto,
  ): Promise<CreateFacilityResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    const store = await this.prisma.store.findFirst({
      where: { AND: [storeScope(caller), { storeId: dto.storeId }] },
      select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
    });
    if (!store) throw new BadRequestException(STORE_UNAVAILABLE);
    if (store.storeStatusCode === 'CLOSED')
      throw new BadRequestException(CLOSED_STORE_CREATE);
    const data = await this.validated(caller, dto, store, null);
    return this.prisma.$transaction(async (tx) => {
      // 점포 행을 공유 잠금으로 다시 본다 — 위 검사 뒤 폐점 · 삭제가 커밋됐으면 막는다. 폐점(점포 행 FOR NO KEY UPDATE)과
      // 줄을 서므로, 외래키 검사(FOR KEY SHARE)만으로는 지나가던 틈이 닫힌다.
      const [locked] = await tx.$queryRaw<
        { store_status_code: string; is_deleted: boolean }[]
      >`SELECT "store_status_code", "is_deleted" FROM "stores" WHERE "store_id" = ${store.storeId} FOR SHARE`;
      if (!locked || locked.is_deleted)
        throw new BadRequestException(STORE_UNAVAILABLE);
      if (locked.store_status_code === 'CLOSED')
        throw new BadRequestException(CLOSED_STORE_CREATE);
      const created = await tx.facility.create({
        data: {
          ...data,
          storeId: store.storeId,
          createdBy: caller.adminAccountId,
        },
        select: { facilityId: true },
      });
      return { facilityId: created.facilityId };
    });
  }

  async update(
    callerId: number,
    bp: TargetBpContext,
    facilityId: number,
    dto: UpdateFacilityDto,
  ): Promise<UpdateFacilityResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    const current = await this.findFacility(this.prisma, caller, facilityId);
    assertEditable(current);
    // 받은 updatedAt 이 이미 지금과 다르면 검증 전에 409 — 「지금 값 유지」를 다른 사람이 고친 값과 견주면, 새로고침해야 할
    // 사람이 「다시 선택해 주세요」 400 을 받는다. 저장 직전의 같은 조건(아래 updateMany)은 그 뒤 끼어든 수정을 잡는다.
    if (!isSameMillisecond(current.updatedAt, dto.updatedAt))
      throw new ConflictException(CHANGED_MEANWHILE);
    const store = { storeId: current.storeId, ...current.store };
    const data = await this.validated(caller, dto, store, current);
    // 가려진 담당자(본사 역할 · 미동의 가맹 직원)를 그대로 두면 화면은 번호를 받지 못해 비워 보낸다 — 저장된 번호를 지키다.
    const manager = await this.managerOf(
      caller,
      current.store,
      current.managerStaffMemberId,
    );
    if (
      manager?.isHidden &&
      data.managerStaffMemberId === current.managerStaffMemberId &&
      data.managerPhone === null
    )
      data.managerPhone = current.managerPhone;
    return this.prisma.$transaction(async (tx) => {
      // 잠근 뒤 지움 · 폐점을 다시 본다 — 그 사이 지웠으면 404, 폐점했으면 409(조회만). 남은 0건은 동시 수정이다.
      await lockEditable(tx, facilityId);
      const { count } = await tx.facility.updateMany({
        where: { facilityId, updatedAt: sameMillisecond(dto.updatedAt) },
        data: { ...data, updatedBy: caller.adminAccountId },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);
      return tx.facility.findUniqueOrThrow({
        where: { facilityId },
        select: { facilityId: true, updatedAt: true },
      });
    });
  }

  /** 논리 삭제. 문서도 함께 지움 표시한다(파일은 남긴다). */
  async remove(
    callerId: number,
    bp: TargetBpContext,
    facilityId: number,
  ): Promise<void> {
    const caller = await this.loadCaller(callerId, bp);
    assertEditable(await this.findFacility(this.prisma, caller, facilityId));
    await this.prisma.$transaction(async (tx) => {
      // 그 사이 다른 요청이 지웠으면 404(이미 없는 것과 같다), 폐점했으면 409.
      await lockEditable(tx, facilityId);
      await tx.facility.update({
        where: { facilityId },
        data: { isDeleted: true, updatedBy: caller.adminAccountId },
      });
      await tx.facilityDocument.updateMany({
        where: { facilityId, isDeleted: false },
        data: { isDeleted: true },
      });
    });
  }

  /** 점포 선택지 — 범위 안의 지우지 않은 점포. 등록 화면은 폐점을 빼고(기본), 목록 필터는 넣는다(PL-1). */
  async storeOptions(
    callerId: number,
    bp: TargetBpContext,
    query: FacilityStoreOptionsQueryDto,
  ): Promise<FacilityStoreOptionListResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    const items = await this.prisma.store.findMany({
      where: {
        AND: [
          storeScope(caller),
          query.includeClosed ? {} : { storeStatusCode: { not: 'CLOSED' } },
        ],
      },
      select: {
        storeId: true,
        storeCode: true,
        name: true,
        storeStatusCode: true,
      },
      orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
    });
    return { items };
  }

  /** 관리 담당자 선택지 — 그 점포의 재직 직원, 이름순(PL-6). 범위 밖 점포면 404. */
  async managerOptions(
    callerId: number,
    bp: TargetBpContext,
    query: FacilityManagerOptionsQueryDto,
  ): Promise<FacilityManagerOptionListResponseDto> {
    const caller = await this.loadCaller(callerId, bp);
    const store = await this.prisma.store.findFirst({
      where: { AND: [storeScope(caller), { storeId: query.storeId }] },
      select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
    });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND);
    const items = await this.prisma.staffMember.findMany({
      where: managerCandidateWhere(caller, store),
      select: { staffMemberId: true, name: true, phone: true },
      orderBy: [{ name: 'asc' }, { staffMemberId: 'asc' }],
    });
    return { items };
  }

  /**
   * 문서 올리기 · 바꾸기(종류마다 1개). 저장소에 먼저 올리고, 시설물 행을 잠근 채(지움 · 폐점을 다시 본다) 그 종류의 옛
   * 문서를 지움 표시한 뒤 새 행을 넣는다 — 같은 시설물의 교체 · 빼기끼리 줄을 서서 마지막 것이 남는다. DB 저장이 실패하면
   * 그 파일을 가리키는 행이 없을 때만 올린 파일을 지운다(COMMIT 뒤 연결이 끊겼을 수 있다).
   */
  async putDocument(
    callerId: number,
    bp: TargetBpContext,
    facilityId: number,
    rawKind: string,
    file: FacilityDocumentUpload | undefined,
  ): Promise<FacilityDocumentDto> {
    const documentKind = kindOrNotFound(rawKind);
    if (!file)
      throw new BadRequestException(
        `${documentKindLabel(documentKind)} 파일을 골라 주세요.`,
      );
    const fileType = assertUpload(
      file,
      DOCUMENT_TYPES,
      FACILITY_DOCUMENT_MAX_BYTES,
    );
    const caller = await this.loadCaller(callerId, bp);
    assertEditable(await this.findFacility(this.prisma, caller, facilityId));
    // 저장소가 없다는 503 은 입력 · 범위 · 상태 검사 뒤에 낸다 — 404 · 409 를 가리지 않게.
    const storage = requireStorage(this.storage);

    const storageKey = StorageService.newKey(
      'facilities',
      facilityId,
      fileType,
    );
    try {
      await storage.put(storageKey, file.buffer, fileType, {
        thumbnail: true,
      });
    } catch (error) {
      // 썸네일을 만들 수 없는 그림(깨짐 · 화소 초과)은 고쳐 올리면 되는 400 이다.
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `시설물 문서 올리기 실패 facilityId=${facilityId} key=${storageKey}`,
        stackOf(error),
      );
      throw new ServiceUnavailableException(
        '파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
      );
    }

    let saved: DocumentRow;
    try {
      saved = await this.prisma.$transaction(async (tx) => {
        // 잠근 뒤 다시 본다 — 올리는 동안(저장소 왕복) 지워지거나 폐점했으면 404 · 409 이고, 올린 파일은 아래에서 지운다.
        await lockEditable(tx, facilityId);
        await tx.facilityDocument.updateMany({
          where: { facilityId, documentKind, isDeleted: false },
          data: { isDeleted: true },
        });
        return tx.facilityDocument.create({
          data: {
            facilityId,
            documentKind,
            fileName: fileNameOf(file.originalname, fileType),
            fileType,
            sizeBytes: file.size,
            storageKey,
            createdBy: caller.adminAccountId,
          },
          select: DOCUMENT_SELECT,
        });
      });
    } catch (error) {
      // 행 없는 파일은 아무도 보지 못한다. COMMIT 뒤 연결이 끊겨 행이 남았을 수 있으니 가리키는 행이 없을 때만 지운다.
      try {
        const referenced = await this.prisma.facilityDocument.count({
          where: { storageKey },
        });
        if (referenced === 0) await storage.delete(storageKey);
      } catch (cleanupError) {
        this.logger.error(
          `저장하지 못한 시설물 문서 파일을 지우지 못했다(남은 파일) key=${storageKey}`,
          stackOf(cleanupError),
        );
      }
      throw error;
    }
    const [document] = await this.documentsOf([saved]);
    return document;
  }

  /**
   * 문서 빼기 — 그 종류의 행을 지움 표시하고 파일은 남긴다. 없으면 아무것도 하지 않는다. 올리기와 같은 행 잠금으로 줄을
   * 서므로, 진행 중인 교체가 먼저 커밋되면 그 새 문서를 뺀다.
   */
  async removeDocument(
    callerId: number,
    bp: TargetBpContext,
    facilityId: number,
    rawKind: string,
  ): Promise<void> {
    const documentKind = kindOrNotFound(rawKind);
    const caller = await this.loadCaller(callerId, bp);
    assertEditable(await this.findFacility(this.prisma, caller, facilityId));
    await this.prisma.$transaction(async (tx) => {
      await lockEditable(tx, facilityId);
      await tx.facilityDocument.updateMany({
        where: { facilityId, documentKind, isDeleted: false },
        data: { isDeleted: true },
      });
    });
  }

  /**
   * 저장할 값. 공통코드 · 날짜 앞뒤 · 주소 짝 · 관리 담당자를 보고, 총금액을 계산한다. current 는 수정 전 값(등록이면
   * null) — 지금 값과 같은 운영상태 · 분류 · 점검 주기 · 담당자는 그 사이 미사용 · 퇴직이 됐어도 그대로 둔다(PL-3 · PL-6).
   */
  private async validated(
    caller: FacilityCaller,
    dto: SaveFacilityDto,
    store: { storeId: number } & MaskingStore,
    current: Current | null,
  ) {
    const purchaseDate = dateOrNull(dto.purchaseDate);
    const installationDate = dateOrNull(dto.installationDate);
    if (purchaseDate && installationDate && installationDate < purchaseDate)
      throw new BadRequestException('설치일은 구매일보다 앞설 수 없습니다.');
    const zipCode = dto.serviceCenterZipCode ?? null;
    const address = dto.serviceCenterAddress ?? null;
    const addressDetail = dto.serviceCenterAddressDetail ?? null;
    if (
      (zipCode === null) !== (address === null) ||
      (addressDetail && !address)
    )
      throw new BadRequestException(
        'A/S센터 주소는 주소 검색으로 골라 주세요.',
      );

    if (
      current?.facilityStatusCode !== dto.facilityStatusCode &&
      !(await this.isActiveCode(
        FACILITY_STATUS_GROUP,
        dto.facilityStatusCode,
        PLATFORM_BP_CODE,
      ))
    )
      throw new BadRequestException('운영상태를 다시 선택해 주세요.');
    const keepsCategory =
      current?.facilityGroupCode === dto.facilityGroupCode &&
      current.facilityCategoryCode === dto.facilityCategoryCode;
    if (
      !keepsCategory &&
      !(await this.isActiveCode(
        dto.facilityGroupCode,
        dto.facilityCategoryCode,
        caller.targetBpCode,
      ))
    )
      throw new BadRequestException(
        '쓸 수 없는 분류입니다. 다시 선택해 주세요.',
      );
    const cycle = dto.inspectionCycleCode ?? null;
    if (
      cycle !== null &&
      current?.inspectionCycleCode !== cycle &&
      !(await this.isActiveCode(
        INSPECTION_CYCLE_GROUP,
        cycle,
        caller.targetBpCode,
      ))
    )
      throw new BadRequestException('점검 주기를 다시 선택해 주세요.');
    const manager = dto.managerStaffMemberId ?? null;
    if (manager !== null && current?.managerStaffMemberId !== manager) {
      // 선택지와 같은 조건 — 가입 완료 · 재직이고, 본사 역할이 가맹 점포에서 고르면 본사 제공 동의한 직원만.
      const candidate = await this.prisma.staffMember.count({
        where: {
          AND: [
            managerCandidateWhere(caller, store),
            { staffMemberId: manager },
          ],
        },
      });
      if (candidate === 0)
        throw new BadRequestException(
          '관리 담당자는 그 점포의 재직 직원만 고를 수 있습니다.',
        );
    }

    const unitPrice = dto.unitPriceAmount ?? null;
    return {
      name: dto.name,
      facilityStatusCode: dto.facilityStatusCode,
      facilityGroupCode: dto.facilityGroupCode,
      facilityCategoryCode: dto.facilityCategoryCode,
      memo: dto.memo ?? null,
      brand: dto.brand ?? null,
      manufacturer: dto.manufacturer ?? null,
      serialNumber: dto.serialNumber ?? null,
      installationLocation: dto.installationLocation ?? null,
      vendorName: dto.vendorName ?? null,
      vendorPhone: dto.vendorPhone ?? null,
      salesRepresentativeName: dto.salesRepresentativeName ?? null,
      salesRepresentativePhone: dto.salesRepresentativePhone ?? null,
      unitPriceAmount: unitPrice,
      quantity: dto.quantity,
      totalAmount: totalAmountOf(unitPrice, dto.quantity),
      isVatIncluded: dto.isVatIncluded,
      purchaseDate,
      installationDate,
      usageExpiryDate: dateOrNull(dto.usageExpiryDate),
      warrantyExpiryDate: dateOrNull(dto.warrantyExpiryDate),
      managerStaffMemberId: manager,
      managerPhone: dto.managerPhone ?? null,
      inspectionCycleCode: cycle,
      inspectionNote: dto.inspectionNote ?? null,
      serviceCenterZipCode: zipCode,
      serviceCenterAddress: address,
      serviceCenterAddressDetail: addressDetail,
      serviceCenterPhone: dto.serviceCenterPhone ?? null,
    };
  }

  /**
   * 그 BP(bpCode)의 사용 중인 상세 코드인가 — 그룹도 사용 중이어야 한다. 관리 주체로 나누는 것은 부르는 쪽이다:
   * 플랫폼고정 그룹은 PLATFORM_BP_CODE 를, 플랫폼제공 그룹은 대상 BP 코드를 넘긴다.
   */
  private async isActiveCode(
    groupCode: string,
    itemCode: string,
    bpCode: string,
  ): Promise<boolean> {
    const n = await this.prisma.codeItem.count({
      where: {
        groupCode,
        itemCode,
        bpCode,
        status: 'ACTIVE',
        isDeleted: false,
        codeGroup: { status: 'ACTIVE', isDeleted: false },
      },
    });
    return n > 0;
  }

  /**
   * 지금 사용 중인 코드(`그룹:코드`) — 상세의 「미사용」 표시에 쓴다. 운영상태는 플랫폼 원본, 분류 · 점검 주기는 그 BP 의
   * 행이다(플랫폼 원본만 사용 중이고 BP 로 복사되지 않은 분류는 쓸 수 없으므로 사용 중이 아니다).
   */
  private async activeCodes(bpCode: string): Promise<Set<string>> {
    const rows = await this.prisma.codeItem.findMany({
      where: {
        OR: [
          {
            groupCode: { in: [...FACILITY_GROUPS, INSPECTION_CYCLE_GROUP] },
            bpCode,
          },
          { groupCode: FACILITY_STATUS_GROUP, bpCode: PLATFORM_BP_CODE },
        ],
        status: 'ACTIVE',
        isDeleted: false,
        codeGroup: { status: 'ACTIVE', isDeleted: false },
      },
      select: { groupCode: true, itemCode: true },
    });
    return new Set(rows.map((r) => codeKey(r.groupCode, r.itemCode)));
  }

  /**
   * 관리 담당자 표시 — 본사 역할(BM · BA)에게 가맹 점포의 본사 제공 미동의 직원(폐점한 가맹 점포면 누구든)은 이름을
   * 가린다(ATT-30, hidesPersonalData). 직원 정보 관리에서 가려지는 사람이 여기로 새지 않게. 담당자가 없으면 null.
   */
  private async managerOf(
    caller: FacilityCaller,
    store: MaskingStore,
    staffMemberId: number | null,
  ): Promise<{
    staffMemberId: number;
    name: string | null;
    isHidden: boolean;
  } | null> {
    if (staffMemberId === null) return null;
    const staff = await this.prisma.staffMember.findUnique({
      where: { staffMemberId },
      select: { name: true, ...HQ_SHARING_SELECT },
    });
    const isHidden =
      !staff ||
      hidesPersonalData(
        caller.roleTypeCode,
        store,
        hqSharingConsentedOf(staff),
      );
    return { staffMemberId, name: isHidden ? null : staff.name, isHidden };
  }

  /**
   * 한글 이름표. 운영상태는 플랫폼 원본, 그룹은 공통코드 그룹명, 분류 · 점검 주기는 점포 BP 의 행(없으면 플랫폼 원본).
   * 미사용 · 지운 코드도 이름을 보인다 — 그 값을 쓰는 시설물·장비에는 이름이 남는다(PL-3).
   */
  private async labels(bpCode: string) {
    const [groups, items] = await Promise.all([
      this.prisma.codeGroup.findMany({
        where: { groupCode: { in: [...FACILITY_GROUPS] } },
        select: { groupCode: true, groupName: true },
      }),
      this.prisma.codeItem.findMany({
        where: {
          groupCode: {
            in: [
              FACILITY_STATUS_GROUP,
              ...FACILITY_GROUPS,
              INSPECTION_CYCLE_GROUP,
            ],
          },
          bpCode: { in: [PLATFORM_BP_CODE, bpCode] },
        },
        select: {
          groupCode: true,
          itemCode: true,
          bpCode: true,
          label: true,
          isDeleted: true,
        },
        // 지우지 않은 행을 먼저 — 같은 코드가 지운 행과 함께 있으면 살아 있는 이름을 고른다.
        orderBy: [{ isDeleted: 'asc' }],
      }),
    ]);
    const groupNames = new Map(groups.map((g) => [g.groupCode, g.groupName]));
    const inGroup = (groupCode: string) =>
      items.filter((i) => i.groupCode === groupCode);
    return {
      status: (code: string) =>
        pickLabel(inGroup(FACILITY_STATUS_GROUP), code, PLATFORM_BP_CODE),
      group: (code: string) => groupNames.get(code) ?? code,
      item: (groupCode: string, code: string) =>
        pickLabel(inGroup(groupCode), code, bpCode),
    };
  }

  private async adminNames(
    ids: (number | null)[],
  ): Promise<Map<number, string | null>> {
    const wanted = ids.filter((id): id is number => id !== null);
    if (!wanted.length) return new Map();
    const rows = await this.prisma.adminAccount.findMany({
      where: { adminAccountId: { in: wanted } },
      select: { adminAccountId: true, name: true },
    });
    return new Map(rows.map((r) => [r.adminAccountId, r.name]));
  }

  /** 문서 응답 — 종류 순. 주소는 5분짜리 서명이고, 저장소가 없거나 서명이 실패하면 null(조회는 막지 않는다). */
  private async documentsOf(
    rows: DocumentRow[],
  ): Promise<FacilityDocumentDto[]> {
    const sorted = [...rows].sort(
      (a, b) =>
        FACILITY_DOCUMENT_KINDS.indexOf(a.documentKind) -
        FACILITY_DOCUMENT_KINDS.indexOf(b.documentKind),
    );
    return Promise.all(
      sorted.map(async (r) => ({
        facilityDocumentId: r.facilityDocumentId,
        documentKind: r.documentKind,
        fileName: r.fileName,
        fileType: r.fileType,
        sizeBytes: r.sizeBytes,
        downloadUrl: await this.signed(r.storageKey, (storage) =>
          storage.downloadUrl(r.storageKey, r.fileName),
        ),
        thumbnailUrl:
          r.fileType === 'PDF'
            ? null
            : await this.signed(r.storageKey, (storage) =>
                storage.thumbnailUrl(r.storageKey),
              ),
      })),
    );
  }

  private async signed(
    storageKey: string,
    sign: (storage: StorageService) => Promise<string | null>,
  ): Promise<string | null> {
    if (!this.storage) return null;
    try {
      return await sign(this.storage);
    } catch (error) {
      this.logger.warn(
        `시설물 문서 서명 주소를 만들지 못했다 storageKey=${storageKey}`,
        stackOf(error),
      );
      return null;
    }
  }

  /**
   * 사용 중인 관리자 계정과 다루는 BP. 플랫폼 계정이 BP 를 고르지 않았으면(대상 = 소속 플랫폼 BP) 400 — 플랫폼 BP 에는
   * 점포가 없다(점포 정보 관리와 같다).
   */
  private async loadCaller(
    callerId: number,
    bp: TargetBpContext,
  ): Promise<FacilityCaller> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId: callerId,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: {
        bpCodeId: true,
        isAllStores: true,
        roleTypeCode: true,
        bpCode: { select: { isPlatform: true, bpCode: true } },
      },
    });
    if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const isPlatform = isPlatformRole(
      admin.roleTypeCode,
      admin.bpCode.isPlatform,
    );
    if (isPlatform && bp.bpCodeId === admin.bpCodeId)
      throw new BadRequestException('시설물·장비를 볼 BP 를 골라 주세요.');
    const targetBpCodeId = isPlatform ? bp.bpCodeId : admin.bpCodeId;
    const targetBpCode = isPlatform
      ? (
          await this.prisma.bpCode.findUniqueOrThrow({
            where: { bpCodeId: targetBpCodeId },
            select: { bpCode: true },
          })
        ).bpCode
      : admin.bpCode.bpCode;
    return {
      adminAccountId: callerId,
      roleTypeCode: admin.roleTypeCode,
      isPlatform,
      isAllStores: admin.isAllStores,
      targetBpCodeId,
      targetBpCode,
    };
  }

  /** 범위 안의 지우지 않은 시설물·장비. 없으면 404. */
  private async findFacility(
    db: Db,
    caller: FacilityCaller,
    facilityId: number,
  ): Promise<DetailRow> {
    const row = await db.facility.findFirst({
      where: { AND: [facilityScope(caller), { facilityId }] },
      include: DETAIL_INCLUDE,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }
}

/** 이 관리자가 보는 점포 — 점포 정보 관리의 범위와 같다(store-management.service scopeOf). */
function storeScope(caller: FacilityCaller): Prisma.StoreWhereInput {
  return {
    isDeleted: false,
    bpCodeId: caller.targetBpCodeId,
    ...(!caller.isPlatform &&
      !caller.isAllStores && {
        adminMappings: {
          some: { adminAccountId: caller.adminAccountId, isDeleted: false },
        },
      }),
  };
}

/**
 * 그 점포에서 관리 담당자로 보이고 고를 수 있는 직원 — 재직 · 가입 완료. 가입 전 레코드는 계약 삭제 · 대체가 물리 삭제하므로
 * (contracts.service 임시저장 삭제, contract-duplicates dropOrphanRecords) 담당자 외래키(RESTRICT)가 그 삭제를 막지 않게 뺀다.
 * 본사 역할이 가맹 점포에서 보면 본사 제공 동의한 직원만이다(폐점한 가맹 점포면 아무도 — ATT-30, hiddenStoreStaffWhere).
 */
function managerCandidateWhere(
  caller: FacilityCaller,
  store: { storeId: number } & MaskingStore,
): Prisma.StaffMemberWhereInput {
  return {
    storeId: store.storeId,
    employmentStatus: 'EMPLOYED',
    joinStatus: 'JOINED',
    ...(hidesPersonalData(caller.roleTypeCode, store, false) &&
      hiddenStoreStaffWhere(caller.roleTypeCode, store)),
  };
}

function facilityScope(caller: FacilityCaller): Prisma.FacilityWhereInput {
  return { isDeleted: false, store: storeScope(caller) };
}

/** 폐점 점포의 시설물·장비는 조회만 된다(PL-1). */
function assertEditable(row: { store: { storeStatusCode: string } }): void {
  if (row.store.storeStatusCode === 'CLOSED')
    throw new ConflictException(READ_ONLY);
}

/**
 * 쓰기 트랜잭션 첫 줄 — 시설물 행을 잠그고(FOR UPDATE) 점포 행은 공유 잠금(FOR SHARE)으로 읽어, 트랜잭션 밖에서 본 지움 ·
 * 폐점을 다시 본다. 점포 공유 잠금은 폐점(점포 행 FOR NO KEY UPDATE)과 줄을 세워 「폐점 점포는 조회만」을 지킨다.
 * 없거나 지웠으면 404, 폐점이면 409.
 */
async function lockEditable(
  tx: Prisma.TransactionClient,
  facilityId: number,
): Promise<void> {
  const [row] = await tx.$queryRaw<
    { is_deleted: boolean; store_status_code: string }[]
  >`
    SELECT f."is_deleted", s."store_status_code"
      FROM "facilities" f JOIN "stores" s ON s."store_id" = f."store_id"
     WHERE f."facility_id" = ${facilityId}
       FOR UPDATE OF f FOR SHARE OF s`;
  if (!row || row.is_deleted) throw new NotFoundException(NOT_FOUND);
  if (row.store_status_code === 'CLOSED')
    throw new ConflictException(READ_ONLY);
}

function kindOrNotFound(raw: string): FacilityDocumentKind {
  const kind = documentKindOf(raw);
  if (!kind) throw new NotFoundException('문서 종류를 찾을 수 없습니다');
  return kind;
}

function codeKey(groupCode: string, itemCode: string): string {
  return `${groupCode}:${itemCode}`;
}

/** DTO 가 모양을 본 날짜(YYYY-MM-DD) — 비면 null. */
function dateOrNull(raw: string | null | undefined): Date | null {
  return raw ? parseDateOnly(raw) : null;
}

/**
 * 저장할 원래 파일 이름 — 점포 대표 이미지와 같다. 제어 문자(NUL 은 Postgres 가 TEXT 로 받지 않는다)를 빼고 글자 단위로
 * 255자(DB CHECK)로 자른다. 남는 것이 없으면 document.{확장자}.
 */
function fileNameOf(raw: string, fileType: AttachmentFileType): string {
  // eslint-disable-next-line no-control-regex
  const name = [...raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()]
    .slice(0, 255)
    .join('');
  return name || `document.${fileType.toLowerCase()}`;
}

function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : String(error);
}
