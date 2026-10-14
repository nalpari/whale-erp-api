import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { sameMillisecond } from '../common/updated-at';
import type { MenuCaller } from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday, parseDateOnly } from '../staff-members/kst-date';
import type {
  ListStoresQueryDto,
  StoreHistoryPageDto,
} from './dto/list-stores-query.dto';
import type {
  BusinessIdentityInputDto,
  CreateStoreDto,
  SaveStoreDto,
  StoreFloorInputDto,
  UpdateStoreDto,
  VerifyStoreBusinessDto,
} from './dto/save-store.dto';
import type {
  CreateStoreResponseDto,
  StoreBusinessVerificationResponseDto,
  StoreDetailResponseDto,
  StoreHistoryListResponseDto,
  StoreListResponseDto,
  StoreTransitionCheckResponseDto,
} from './dto/store.response.dto';
import {
  type BusinessIdentity,
  STORE_BUSINESS_VERIFIER,
  type StoreBusinessVerifier,
} from './store-business-verifier';
import {
  canTransition,
  floorLabel,
  FRANCHISE_ROLE_TYPES,
  IN_PROGRESS_CONTRACT_STATUSES,
  missingForOperation,
  type OperationRequirement,
  PLATFORM_ROLE_TYPES,
  regionOf,
  retainEndDate,
  STATUS_LABEL,
  STORE_TYPES,
} from './store-format';

type Tx = Prisma.TransactionClient;
type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};

const NOT_FOUND = '점포를 찾을 수 없습니다';
const CHANGED_MEANWHILE =
  '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요';
const BP_INACTIVE =
  '소속 BP가 미사용 상태여서 이 업무를 할 수 없습니다. 조회는 그대로 됩니다';
const NUMBER_TAKEN =
  '이미 미운영 · 운영 중인 다른 점포가 쓰는 사업자등록번호입니다';
const REQUIREMENT_LABEL: Record<OperationRequirement, string> = {
  BUSINESS_VERIFICATION: '사업자정보 인증',
  COORDINATES: '좌표(위도 · 경도)',
  BP_INACTIVE: '소속 BP 사용',
};

const FLOOR_SELECT = {
  storeFloorId: true,
  floorTypeCode: true,
  floorNumber: true,
  floorAreaPyeong: true,
  floorAreaSqm: true,
  seatCount: true,
} as const;

const DETAIL_SELECT = {
  storeId: true,
  storeCode: true,
  name: true,
  storeTypeCode: true,
  storeStatusCode: true,
  closedDate: true,
  bpCodeId: true,
  phone: true,
  zipCode: true,
  address: true,
  addressDetail: true,
  latitude: true,
  longitude: true,
  isLocationApplied: true,
  createdAt: true,
  updatedAt: true,
  bpCode: {
    select: { bpCode: true, tradeName: true, accountStatusCode: true },
  },
  creator: { select: { name: true } },
  updater: { select: { name: true } },
  businessProfile: true,
  floors: {
    where: { isDeleted: false },
    select: FLOOR_SELECT,
    orderBy: { storeFloorId: 'asc' },
  },
} satisfies Prisma.StoreSelect;

type StoreDetailRow = Prisma.StoreGetPayload<{ select: typeof DETAIL_SELECT }>;
type ProfileRow = NonNullable<StoreDetailRow['businessProfile']>;

/** 점포를 다루는 관리자. 메뉴 권한을 통과한 뒤 소속 BP 와 점포 범위를 읽어 둔다. */
type StoreCaller = MenuCaller & { bpCodeId: number; isAllStores: boolean };

/**
 * 관리자 웹 「점포 정보 관리」(MN000002). 1팀 `stores` 와 층별정보 · 사업자정보 · 변경 이력을 다룬다.
 *
 * 범위: 플랫폼 계정(PM · PA)은 모든 BP 의 점포, BP · 가맹 계정은 자기 BP 의 점포 — 전체 점포가 아니면 매핑된
 * 점포만이다. 메뉴 권한은 컨트롤러가 먼저 본다. 여기서는 그 위의 업무 규칙을 본다.
 * - 상태는 미운영 → 운영 → 폐점 한 방향이다. 운영은 사업자 인증 · 좌표 · 사용 중인 BP 가 있어야 한다(STORE-2).
 * - 폐점 · 삭제는 진행 중인 근로계약이 없어야 한다. 삭제는 미운영만, 폐점한 점포는 조회만 된다.
 * - 소속 BP 가 미사용이면 조회만 된다(STORE-3). 가맹 역할은 등록하지 못한다.
 * - 사업자등록번호는 미운영 · 운영 점포끼리 고유하다. DB 제약으로 표현할 수 없어(상태가 다른 표에 있다)
 *   번호로 잠근 뒤 센다.
 */
@Injectable()
export class StoreManagementService {
  constructor(
    private readonly prisma: PrismaService,
    /** 국세청 진위확인. 연동이 없으면 null — 인증을 요구하는 요청은 503. */
    @Inject(STORE_BUSINESS_VERIFIER)
    private readonly verifier: StoreBusinessVerifier | null,
  ) {}

  async list(
    menuCaller: MenuCaller,
    query: ListStoresQueryDto,
  ): Promise<StoreListResponseDto> {
    const caller = await this.loadCaller(menuCaller);
    const { page, pageSize, keyword, bizRegistrationNumber } = query;
    const where: Prisma.StoreWhereInput = {
      AND: [
        scopeOf(caller),
        {
          storeStatusCode: {
            in: query.statuses?.length
              ? query.statuses
              : ['NOT_OPERATING', 'OPERATING'],
          },
          storeTypeCode: {
            in: query.storeTypes?.length ? query.storeTypes : [...STORE_TYPES],
          },
          ...(query.storeIds?.length && { storeId: { in: query.storeIds } }),
          ...(query.bpCodeId && { bpCodeId: query.bpCodeId }),
          ...(keyword && {
            OR: [
              { name: { contains: keyword, mode: 'insensitive' } },
              { storeCode: { contains: keyword, mode: 'insensitive' } },
            ],
          }),
          ...(bizRegistrationNumber && {
            businessProfile: {
              is: {
                bizRegistrationNumber: { contains: bizRegistrationNumber },
              },
            },
          }),
        },
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.store.findMany({
        where,
        select: {
          storeId: true,
          storeCode: true,
          name: true,
          storeTypeCode: true,
          storeStatusCode: true,
          bpCodeId: true,
          phone: true,
          address: true,
          createdAt: true,
          bpCode: { select: { tradeName: true } },
          businessProfile: { select: { bizRegistrationNumber: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { storeId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.store.count({ where }),
    ]);
    const staff = await this.staffCounts(rows.map((r) => r.storeId));
    return {
      items: rows.map((r) => ({
        storeId: r.storeId,
        storeCode: r.storeCode,
        name: r.name,
        storeTypeCode: r.storeTypeCode,
        storeStatusCode: r.storeStatusCode,
        bpCodeId: r.bpCodeId,
        bpTradeName: r.bpCode.tradeName,
        bizRegistrationNumber: r.businessProfile?.bizRegistrationNumber ?? null,
        phone: r.phone,
        region: regionOf(r.address),
        staffCount: staff.get(r.storeId) ?? 0,
        createdAt: r.createdAt,
      })),
      total,
    };
  }

  async detail(
    menuCaller: MenuCaller,
    storeId: number,
  ): Promise<StoreDetailResponseDto> {
    const caller = await this.loadCaller(menuCaller);
    const store = await this.findStore(this.prisma, caller, storeId);
    const [staff, transitions] = await Promise.all([
      this.staffCounts([storeId]),
      this.transitionsOf(store),
    ]);
    const profile = store.businessProfile;
    return {
      storeId: store.storeId,
      storeCode: store.storeCode,
      name: store.name,
      storeTypeCode: store.storeTypeCode,
      storeStatusCode: store.storeStatusCode,
      closedDate: dateOnly(store.closedDate),
      bpCodeId: store.bpCodeId,
      bpCode: store.bpCode.bpCode,
      bpTradeName: store.bpCode.tradeName,
      bpAccountStatusCode: store.bpCode.accountStatusCode,
      phone: store.phone,
      zipCode: store.zipCode,
      address: store.address,
      addressDetail: store.addressDetail,
      latitude: numberOrNull(store.latitude),
      longitude: numberOrNull(store.longitude),
      isLocationApplied: store.isLocationApplied,
      staffCount: staff.get(storeId) ?? 0,
      business: {
        isVerified: Boolean(profile?.bizRegistrationNumber),
        bizRegistrationNumber: profile?.bizRegistrationNumber ?? null,
        ceoName: profile?.bizCeoName ?? null,
        openDate: dateOnly(profile?.bizOpenDate ?? null),
        verifiedAt: profile?.bizVerifiedAt ?? null,
        tradeName: profile?.bizTradeName ?? null,
        ceoPhone: profile?.bizCeoPhone ?? null,
        zipCode: profile?.bizZipCode ?? null,
        address: profile?.bizAddress ?? null,
        addressDetail: profile?.bizAddressDetail ?? null,
        category: profile?.bizCategory ?? null,
        item: profile?.bizItem ?? null,
      },
      floors: store.floors.map((f) => ({
        storeFloorId: f.storeFloorId,
        floorTypeCode: f.floorTypeCode,
        floorNumber: f.floorNumber,
        floorAreaPyeong: numberOrNull(f.floorAreaPyeong),
        floorAreaSqm: numberOrNull(f.floorAreaSqm),
        seatCount: f.seatCount,
      })),
      transitions,
      createdAt: store.createdAt,
      createdByName: store.creator?.name ?? null,
      updatedAt: store.updatedAt,
      updatedByName: store.updater?.name ?? null,
    };
  }

  /** 상태 전환 · 삭제를 지금 할 수 있는가. 수정 화면이 폐점을 고를 때 다시 묻는다. */
  async transitionCheck(
    menuCaller: MenuCaller,
    storeId: number,
  ): Promise<StoreTransitionCheckResponseDto> {
    const caller = await this.loadCaller(menuCaller);
    return this.transitionsOf(
      await this.findStore(this.prisma, caller, storeId),
    );
  }

  /** 변경 이력. 보존 기한(5년) 안의 것만, 최신순. */
  async histories(
    menuCaller: MenuCaller,
    storeId: number,
    { page, pageSize }: StoreHistoryPageDto,
  ): Promise<StoreHistoryListResponseDto> {
    const caller = await this.loadCaller(menuCaller);
    await this.findStore(this.prisma, caller, storeId);
    const where: Prisma.StoreChangeHistoryWhereInput = {
      storeId,
      retainEndDate: { gte: kstToday() },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.storeChangeHistory.findMany({
        where,
        select: {
          changeId: true,
          field: true,
          beforeValue: true,
          afterValue: true,
          changedAt: true,
          changer: { select: { name: true } },
        },
        orderBy: [{ changedAt: 'desc' }, { changeId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.storeChangeHistory.count({ where }),
    ]);
    return {
      items: rows.map(({ changer, ...row }) => ({
        ...row,
        changedByName: changer?.name ?? null,
      })),
      total,
    };
  }

  /**
   * 등록. 늘 미운영으로 만들고 점포코드(ST+6자리)를 채번한다. 지운 점포의 코드도 다시 쓰지 않는다 — 마지막
   * 코드 다음 번호를, 채번끼리 줄 세운 채 고른다.
   */
  async create(
    menuCaller: MenuCaller,
    dto: CreateStoreDto,
  ): Promise<CreateStoreResponseDto> {
    if (FRANCHISE_ROLE_TYPES.includes(menuCaller.roleTypeCode))
      throw new ForbiddenException('가맹 계정은 점포를 등록할 수 없습니다');
    const caller = await this.loadCaller(menuCaller);
    const isPlatform = PLATFORM_ROLE_TYPES.includes(caller.roleTypeCode);
    if (isPlatform && !dto.bpCodeId)
      throw new BadRequestException('점포를 등록할 BP 를 골라 주세요');
    if (!isPlatform && dto.bpCodeId && dto.bpCodeId !== caller.bpCodeId)
      throw new BadRequestException('다른 BP 에 점포를 등록할 수 없습니다');
    const bpCodeId = isPlatform ? dto.bpCodeId! : caller.bpCodeId;

    const bp = await this.prisma.bpCode.findFirst({
      where: { bpCodeId, isDeleted: false, isPlatform: false },
      select: { accountStatusCode: true },
    });
    if (!bp) throw new BadRequestException('없는 BP 입니다');
    if (bp.accountStatusCode !== 'ACTIVE')
      throw new ConflictException(BP_INACTIVE);

    const identity = dto.businessVerification
      ? await this.verifiedIdentity(dto.businessVerification, null)
      : null;
    const by = caller.adminAccountId;

    return this.prisma.$transaction(async (tx) => {
      if (identity) await this.lockNumber(tx, identity, null);

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('stores:store_code'))`;
      const last = await tx.store.findFirst({
        orderBy: { storeCode: 'desc' },
        select: { storeCode: true },
      });
      const storeCode = nextStoreCode(last?.storeCode ?? null);

      const store = await tx.store.create({
        data: {
          storeCode,
          bpCodeId,
          storeTypeCode: dto.storeTypeCode,
          ...storeFields(dto),
          storeStatusCode: 'NOT_OPERATING',
          createdBy: by,
        },
        select: { storeId: true, storeCode: true },
      });
      const { storeId } = store;

      const profile = profileFields(dto, identity);
      if (Object.values(profile).some((v) => v !== null))
        await tx.storeBusinessProfile.create({
          data: { storeId, ...profile, createdBy: by },
        });
      if (dto.floors.length)
        await tx.storeFloor.createMany({
          data: dto.floors.map((f) => ({
            storeId,
            ...floorFields(f),
            createdBy: by,
          })),
        });
      // 일부 점포만 맡은 계정은 매핑된 점포만 본다 — 자기가 만든 점포를 볼 수 있게 매핑한다.
      // 전체 점포 계정은 매핑 없이도 BP 의 모든 점포를 본다.
      if (!isPlatform && !caller.isAllStores)
        await tx.adminStoreMapping.create({
          data: { adminAccountId: by, storeId, createdBy: by },
        });
      await record(tx, storeId, by, [
        { field: '등록', beforeValue: null, afterValue: dto.name },
      ]);
      return store;
    });
  }

  /**
   * 수정. 화면 전체를 받는다 — 빠진 선택 칸은 지운다. 상태 전환도 여기서 한다. 상세에서 받은 updatedAt 과
   * 같을 때만 고치고(그 사이 고쳤으면 409), 바뀐 항목마다 이력을 남긴다.
   */
  async update(
    menuCaller: MenuCaller,
    storeId: number,
    dto: UpdateStoreDto,
  ): Promise<void> {
    const caller = await this.loadCaller(menuCaller);
    const store = await this.findStore(this.prisma, caller, storeId);
    const from = store.storeStatusCode;
    if (from === 'CLOSED')
      throw new ConflictException(
        '폐점한 점포는 고칠 수 없습니다. 다시 운영하려면 신규 점포로 등록합니다',
      );
    if (store.bpCode.accountStatusCode !== 'ACTIVE')
      throw new ConflictException(BP_INACTIVE);
    if (!canTransition(from, dto.storeStatus))
      throw new BadRequestException(
        `${STATUS_LABEL[from]} 점포를 ${STATUS_LABEL[dto.storeStatus]}으로 바꿀 수 없습니다`,
      );

    const profile = store.businessProfile;
    const savedNumber = profile?.bizRegistrationNumber ?? null;
    let identity: BusinessIdentity | null = null;
    if (dto.businessVerification) {
      const v = dto.businessVerification;
      if (
        savedNumber &&
        (v.bizRegistrationNumber !== savedNumber ||
          v.openDate !== dateOnly(profile!.bizOpenDate))
      )
        throw new BadRequestException(
          '사업자등록번호 · 개업일자는 저장한 뒤 바꿀 수 없습니다. 대표자명만 다시 인증합니다',
        );
      // 재인증은 이 점포가 이미 가진 번호라 중복을 다시 보지 않는다.
      identity = await this.verifiedIdentity(v, savedNumber ? 'skip' : storeId);
    }

    if (dto.storeStatus === 'OPERATING') {
      const missing = missingForOperation({
        bizRegistrationNumber: identity?.bizRegistrationNumber ?? savedNumber,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        bpAccountStatusCode: store.bpCode.accountStatusCode,
      });
      if (missing.length)
        throw new BadRequestException(
          `운영으로 바꾸려면 다음이 필요합니다 — ${missing.map((m) => REQUIREMENT_LABEL[m]).join(', ')}`,
        );
    }
    const isClosing = dto.storeStatus === 'CLOSED' && from !== 'CLOSED';
    if (isClosing) await this.assertNoContracts(storeId, '폐점할');

    const by = caller.adminAccountId;
    await this.prisma.$transaction(async (tx) => {
      if (identity && !savedNumber)
        await this.lockNumber(tx, identity, storeId);

      const { count } = await tx.store.updateMany({
        where: {
          storeId,
          isDeleted: false,
          storeStatusCode: from,
          updatedAt: sameMillisecond(dto.updatedAt),
        },
        data: {
          ...storeFields(dto),
          storeStatusCode: dto.storeStatus,
          ...(isClosing && { closedDate: kstToday() }),
          updatedBy: by,
        },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);

      const nextProfile = profileFields(dto, identity, profile);
      const profileChanges = profileHistory(profile, nextProfile);
      if (profileChanges.length || (identity && profile))
        await tx.storeBusinessProfile.upsert({
          where: { storeId },
          create: { storeId, ...nextProfile, createdBy: by },
          update: { ...nextProfile, updatedBy: by },
        });

      const beforeFloors = floorsText(store.floors);
      const afterFloors = floorsText(dto.floors.map(floorFields));
      if (beforeFloors !== afterFloors) {
        await tx.storeFloor.updateMany({
          where: { storeId, isDeleted: false },
          data: { isDeleted: true, updatedBy: by },
        });
        if (dto.floors.length)
          await tx.storeFloor.createMany({
            data: dto.floors.map((f) => ({
              storeId,
              ...floorFields(f),
              createdBy: by,
            })),
          });
      }

      await record(tx, storeId, by, [
        change('점포명', store.name, dto.name),
        change('점포 연락처', store.phone, dto.phone ?? null),
        change(
          '주소',
          addressOf(store.zipCode, store.address, store.addressDetail),
          addressOf(
            dto.zipCode ?? null,
            dto.address ?? null,
            dto.addressDetail ?? null,
          ),
        ),
        change(
          '위도 · 경도',
          coordinatesOf(store.latitude, store.longitude),
          coordinatesOf(dto.latitude ?? null, dto.longitude ?? null),
        ),
        change(
          '위치 적용 여부',
          usedLabel(store.isLocationApplied),
          usedLabel(dto.isLocationApplied),
        ),
        change('점포상태', STATUS_LABEL[from], STATUS_LABEL[dto.storeStatus]),
        change('층별 정보', beforeFloors, afterFloors),
        ...profileChanges,
      ]);
    });
  }

  /** 삭제(논리 삭제). 미운영이면서 진행 중인 근로계약이 없어야 한다. 폐점한 점포는 지우지 않고 남긴다. */
  async remove(menuCaller: MenuCaller, storeId: number): Promise<void> {
    const caller = await this.loadCaller(menuCaller);
    const store = await this.findStore(this.prisma, caller, storeId);
    if (store.bpCode.accountStatusCode !== 'ACTIVE')
      throw new ConflictException(BP_INACTIVE);
    if (store.storeStatusCode !== 'NOT_OPERATING')
      throw new ConflictException('미운영 점포만 삭제할 수 있습니다');
    await this.assertNoContracts(storeId, '삭제할');

    const by = caller.adminAccountId;
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.store.updateMany({
        where: { storeId, isDeleted: false, storeStatusCode: 'NOT_OPERATING' },
        data: { isDeleted: true, updatedBy: by },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);
      await record(tx, storeId, by, [
        { field: '삭제', beforeValue: store.name, afterValue: null },
      ]);
    });
  }

  /** 저장 전 인증 확인. 번호 중복을 먼저 보고, 겹치면 국세청에 묻지 않는다. */
  async verifyBusiness(
    menuCaller: MenuCaller,
    dto: VerifyStoreBusinessDto,
  ): Promise<StoreBusinessVerificationResponseDto> {
    if (dto.storeId) {
      const caller = await this.loadCaller(menuCaller);
      await this.findStore(this.prisma, caller, dto.storeId);
    }
    if (
      await this.isNumberTaken(
        this.prisma,
        dto.bizRegistrationNumber,
        dto.storeId ?? null,
      )
    )
      return { result: 'DUPLICATE' };
    return {
      result: (await this.askVerifier(identityOf(dto)))
        ? 'VERIFIED'
        : 'UNVERIFIABLE',
    };
  }

  /** 사용 중인 관리자 계정의 소속 BP 와 점포 범위. 메뉴 권한 판정 뒤에 읽는다. */
  private async loadCaller(caller: MenuCaller): Promise<StoreCaller> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId: caller.adminAccountId,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
    });
    if (!admin)
      throw new ForbiddenException('사용 중인 관리자 계정이 아닙니다');
    return { ...caller, ...admin };
  }

  /** 범위 안의 지우지 않은 점포. 없으면 404. */
  private async findStore(
    db: Tx | PrismaService,
    caller: StoreCaller,
    storeId: number,
  ): Promise<StoreDetailRow> {
    const store = await db.store.findFirst({
      where: { AND: [scopeOf(caller), { storeId }] },
      select: DETAIL_SELECT,
    });
    if (!store) throw new NotFoundException(NOT_FOUND);
    return store;
  }

  private async transitionsOf(
    store: StoreDetailRow,
  ): Promise<StoreTransitionCheckResponseDto> {
    const inProgressContractCount = await this.countContracts(store.storeId);
    const isBpActive = store.bpCode.accountStatusCode === 'ACTIVE';
    const canClose =
      isBpActive &&
      store.storeStatusCode !== 'CLOSED' &&
      inProgressContractCount === 0;
    return {
      missingForOperation: missingForOperation({
        bizRegistrationNumber:
          store.businessProfile?.bizRegistrationNumber ?? null,
        latitude: store.latitude,
        longitude: store.longitude,
        bpAccountStatusCode: store.bpCode.accountStatusCode,
      }),
      inProgressContractCount,
      canClose,
      canDelete: canClose && store.storeStatusCode === 'NOT_OPERATING',
      isSubscriptionChecked: false,
    };
  }

  private countContracts(storeId: number): Promise<number> {
    return this.prisma.contract.count({
      where: { storeId, status: { in: [...IN_PROGRESS_CONTRACT_STATUSES] } },
    });
  }

  private async assertNoContracts(storeId: number, verb: string) {
    const count = await this.countContracts(storeId);
    if (count > 0)
      throw new ConflictException(
        `진행 중인 근로계약이 ${count}건 있어 ${verb} 수 없습니다`,
      );
  }

  /** 점포별 재직 직원 수 */
  private async staffCounts(storeIds: number[]): Promise<Map<number, number>> {
    if (!storeIds.length) return new Map();
    const groups = await this.prisma.staffMember.groupBy({
      by: ['storeId'],
      where: { storeId: { in: storeIds }, employmentStatus: 'EMPLOYED' },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.storeId, g._count._all]));
  }

  /**
   * 국세청에 확인한 세 값. 번호 중복을 먼저 본다(`'skip'` 은 재인증 — 이미 이 점포의 번호다).
   * 겹치면 409, 맞지 않으면 400, 연동이 없거나 실패하면 503.
   */
  private async verifiedIdentity(
    input: BusinessIdentityInputDto,
    exclude: number | null | 'skip',
  ): Promise<BusinessIdentity> {
    if (
      exclude !== 'skip' &&
      (await this.isNumberTaken(
        this.prisma,
        input.bizRegistrationNumber,
        exclude,
      ))
    )
      throw new ConflictException(NUMBER_TAKEN);
    const identity = identityOf(input);
    if (!(await this.askVerifier(identity)))
      throw new BadRequestException(
        '국세청에 등록된 사업자 정보와 맞지 않습니다. 사업자등록번호 · 대표자명 · 개업일자를 확인해 주세요',
      );
    return identity;
  }

  private async askVerifier(identity: BusinessIdentity): Promise<boolean> {
    if (!this.verifier)
      throw new ServiceUnavailableException(
        '사업자 진위확인 연동이 아직 없어 인증할 수 없습니다',
      );
    try {
      return await this.verifier.verify(identity);
    } catch {
      throw new ServiceUnavailableException(
        '사업자 진위확인 중 오류가 났습니다. 잠시 뒤 다시 시도해 주세요',
      );
    }
  }

  /** 같은 번호의 저장을 줄 세우고, 잠근 뒤 다시 센다 — 두 점포가 동시에 같은 번호를 인증해도 하나만 남는다. */
  private async lockNumber(
    tx: Tx,
    identity: BusinessIdentity,
    exclude: number | null,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stores:biz:${identity.bizRegistrationNumber}`}))`;
    if (await this.isNumberTaken(tx, identity.bizRegistrationNumber, exclude))
      throw new ConflictException(NUMBER_TAKEN);
  }

  /** 미운영 · 운영 점포(지우지 않은)가 이 번호를 쓰는가. 폐점 · 삭제한 점포의 번호는 다시 쓸 수 있다. */
  private async isNumberTaken(
    db: Tx | PrismaService,
    bizRegistrationNumber: string,
    exclude: number | null,
  ): Promise<boolean> {
    const count = await db.storeBusinessProfile.count({
      where: {
        bizRegistrationNumber,
        ...(exclude !== null && { storeId: { not: exclude } }),
        store: {
          isDeleted: false,
          storeStatusCode: { in: ['NOT_OPERATING', 'OPERATING'] },
        },
      },
    });
    return count > 0;
  }
}

/** 이 관리자가 보는 점포 — 지우지 않았고, 플랫폼이 아니면 자기 BP(전체 점포가 아니면 매핑된 점포). */
function scopeOf(caller: StoreCaller): Prisma.StoreWhereInput {
  if (PLATFORM_ROLE_TYPES.includes(caller.roleTypeCode))
    return { isDeleted: false };
  return {
    isDeleted: false,
    bpCodeId: caller.bpCodeId,
    ...(!caller.isAllStores && {
      adminMappings: {
        some: { adminAccountId: caller.adminAccountId, isDeleted: false },
      },
    }),
  };
}

function storeFields(dto: SaveStoreDto) {
  return {
    name: dto.name,
    phone: dto.phone ?? null,
    zipCode: dto.zipCode ?? null,
    address: dto.address ?? null,
    addressDetail: dto.addressDetail ?? null,
    latitude: dto.latitude ?? null,
    longitude: dto.longitude ?? null,
    isLocationApplied: dto.isLocationApplied,
  };
}

function floorFields(f: StoreFloorInputDto) {
  return {
    floorTypeCode: f.floorTypeCode ?? null,
    floorNumber: f.floorNumber ?? null,
    floorAreaPyeong: f.floorAreaPyeong ?? null,
    floorAreaSqm: f.floorAreaSqm ?? null,
    seatCount: f.seatCount ?? null,
  };
}

/**
 * 저장할 사업자정보. 직접 넣는 칸은 화면 값, 번호 · 대표자명 · 개업일자 · 인증일시는 이번에 인증했으면 그 값,
 * 아니면 저장된 값 그대로다.
 */
function profileFields(
  dto: SaveStoreDto,
  identity: BusinessIdentity | null,
  saved: ProfileRow | null = null,
) {
  const b = dto.business ?? {};
  return {
    bizTradeName: b.tradeName ?? null,
    bizCeoPhone: b.ceoPhone ?? null,
    bizZipCode: b.zipCode ?? null,
    bizAddress: b.address ?? null,
    bizAddressDetail: b.addressDetail ?? null,
    bizCategory: b.category ?? null,
    bizItem: b.item ?? null,
    bizRegistrationNumber:
      identity?.bizRegistrationNumber ?? saved?.bizRegistrationNumber ?? null,
    bizCeoName: identity?.ceoName ?? saved?.bizCeoName ?? null,
    bizOpenDate: identity?.openDate ?? saved?.bizOpenDate ?? null,
    bizVerifiedAt: identity ? new Date() : (saved?.bizVerifiedAt ?? null),
  };
}

function profileHistory(
  saved: ProfileRow | null,
  next: ReturnType<typeof profileFields>,
): History[] {
  const s = saved;
  return [
    change('상호명', s?.bizTradeName ?? null, next.bizTradeName),
    change('대표자 연락처', s?.bizCeoPhone ?? null, next.bizCeoPhone),
    change(
      '사업자주소',
      addressOf(
        s?.bizZipCode ?? null,
        s?.bizAddress ?? null,
        s?.bizAddressDetail ?? null,
      ),
      addressOf(next.bizZipCode, next.bizAddress, next.bizAddressDetail),
    ),
    change('업태', s?.bizCategory ?? null, next.bizCategory),
    change('종목', s?.bizItem ?? null, next.bizItem),
    change(
      '사업자등록번호',
      s?.bizRegistrationNumber ?? null,
      next.bizRegistrationNumber,
    ),
    change('대표자명', s?.bizCeoName ?? null, next.bizCeoName),
    change(
      '개업일자',
      dateOnly(s?.bizOpenDate ?? null),
      dateOnly(next.bizOpenDate),
    ),
  ].filter((c): c is History => c !== null);
}

function identityOf(input: BusinessIdentityInputDto): BusinessIdentity {
  return {
    bizRegistrationNumber: input.bizRegistrationNumber,
    ceoName: input.ceoName,
    // DTO 가 날짜를 검사했다.
    openDate: parseDateOnly(input.openDate)!,
  };
}

/** 다음 점포코드. 6자리를 다 쓰면 더 만들 수 없다. */
function nextStoreCode(last: string | null): string {
  const next = (last ? Number(last.slice(2)) : 0) + 1;
  if (next > 999_999)
    throw new ConflictException('점포코드를 더 만들 수 없습니다');
  return `ST${String(next).padStart(6, '0')}`;
}

async function record(
  tx: Tx,
  storeId: number,
  changedBy: number,
  changes: (History | null)[],
): Promise<void> {
  const until = retainEndDate();
  const data = changes
    .filter((c): c is History => c !== null)
    .map((c) => ({ storeId, ...c, changedBy, retainEndDate: until }));
  if (data.length) await tx.storeChangeHistory.createMany({ data });
}

function change(
  field: string,
  beforeValue: string | null,
  afterValue: string | null,
): History | null {
  return beforeValue === afterValue ? null : { field, beforeValue, afterValue };
}

function floorsText(floors: Parameters<typeof floorLabel>[0][]): string | null {
  return floors.length ? floors.map(floorLabel).join(' / ') : null;
}

function addressOf(
  zipCode: string | null,
  address: string | null,
  addressDetail: string | null,
): string | null {
  const text = [zipCode && `(${zipCode})`, address, addressDetail]
    .filter(Boolean)
    .join(' ');
  return text || null;
}

function coordinatesOf(latitude: unknown, longitude: unknown): string | null {
  if (latitude == null && longitude == null) return null;
  return `${numberOrNull(latitude) ?? '-'}, ${numberOrNull(longitude) ?? '-'}`;
}

function usedLabel(on: boolean): string {
  return on ? '사용' : '미사용';
}

function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}

/** 날짜만 있는 칸(UTC 자정 Date)을 YYYY-MM-DD 로. */
function dateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
